// index.js — WhatsApp-only bot (no Telegram)
const http = require('http');
const { MongoClient } = require('mongodb');
const {
  initAuthCreds,
  BufferJSON,
  proto,
  default: makeWASocket,
  DisconnectReason,
  fetchLatestWaWebVersion,
  Browsers
} = require('@whiskeysockets/baileys');
const pino = require('pino');

const PORT = process.env.PORT || 10000;
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = 'wa_saas';
const SESSION_KEY = '8629374120'; // matches what we uploaded from Termux

http.createServer((req, res) => {
  res.writeHead(200);
  res.end('OK');
}).listen(PORT, () => console.log(`✅ Health server on ${PORT}`));

let db;

async function connectDB() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  db = client.db(DB_NAME);
  console.log('✅ MongoDB connected');
}

async function useMongoAuthState(key) {
  const coll = db.collection('sessions');

  const writeData = async (data, id) => {
    const json = JSON.stringify(data, BufferJSON.replacer);
    await coll.updateOne(
      { _id: `user_${key}-${id}` },
      { $set: { data: json, updated_at: new Date() } },
      { upsert: true }
    );
  };

  const readData = async (id) => {
    const doc = await coll.findOne({ _id: `user_${key}-${id}` });
    if (!doc) return null;
    try { return JSON.parse(doc.data, BufferJSON.reviver); }
    catch (e) { return null; }
  };

  const removeData = async (id) => {
    await coll.deleteOne({ _id: `user_${key}-${id}` });
  };

  const creds = (await readData('creds')) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(ids.map(async (id) => {
            let value = await readData(`${type}-${id}`);
            if (type === 'app-state-sync-key' && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            data[id] = value;
          }));
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const k = `${category}-${id}`;
              tasks.push(value ? writeData(value, k) : removeData(k));
            }
          }
          await Promise.all(tasks);
        }
      }
    },
    saveCreds: () => writeData(creds, 'creds')
  };
}

async function startBot() {
  const { state, saveCreds } = await useMongoAuthState(SESSION_KEY);

  let version;
  try {
    const r = await fetchLatestWaWebVersion();
    version = r.version;
  } catch (e) {
    version = [2, 3000, 1035194821];
  }

  console.log('WA version:', version.join('.'));
  console.log('Session registered:', state.creds.registered);
  console.log('Session me:', state.creds.me ? state.creds.me.id : 'NONE');

  const sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    auth: state,
    browser: Browsers.macOS('Chrome'),
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: true
  });

  sock.ev.on('creds.update', saveCreds);

  const awaitingLink = {};

  sock.ev.on('connection.update', (u) => {
    const { connection, lastDisconnect } = u;
    if (connection === 'connecting') console.log('Connecting...');
    if (connection === 'open') console.log('✅ WhatsApp connected!');
    if (connection === 'close') {
      const code = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output
        ? lastDisconnect.error.output.statusCode : 0;
      console.log('Closed. Code:', code);
      if (code !== DisconnectReason.loggedOut) {
        console.log('Reconnecting in 5s...');
        setTimeout(() => startBot(), 5000);
      } else {
        console.log('❌ Logged out. Cannot reconnect.');
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    try {
      if (!messages || !messages.length) return;
      if (type !== 'notify' && type !== 'append') return;

      for (const msg of messages) {
        try {
          if (!msg || !msg.message) continue;
          const from = msg.key.remoteJid;
          if (!from) continue;

          const text =
            msg.message.conversation ||
            (msg.message.extendedTextMessage && msg.message.extendedTextMessage.text) ||
            (msg.message.imageMessage && msg.message.imageMessage.caption) ||
            '';
          const t = text.trim().toLowerCase();

          // DEBUG — every message
          if (from.endsWith('@g.us')) {
            console.log(`[MSG] group=${from} fromMe=${msg.key.fromMe} text="${text.substring(0, 60)}"`);
          }

          if (from.endsWith('@newsletter')) continue;
          if (from.endsWith('@broadcast')) continue;
          if (!from.endsWith('@g.us')) continue;
          if (!msg.key.fromMe) continue; // ONLY owner commands

          // ---- Command handlers ----
          if (t === '.send') {
            awaitingLink[from] = 'send';
            console.log('  → .send triggered');
            await sock.sendMessage(from, { text: 'Send your message with the channel link.' }, { quoted: msg });
            continue;
          }
          if (t === '.sendall') {
            awaitingLink[from] = 'sendall';
            console.log('  → .sendall triggered');
            await sock.sendMessage(from, { text: 'Send your message with the channel link.' }, { quoted: msg });
            continue;
          }
          if (t === '.status') {
            awaitingLink[from] = 'status';
            console.log('  → .status triggered');
            await sock.sendMessage(from, { text: 'Send your message with the channel link.' }, { quoted: msg });
            continue;
          }
          if (t === '.statusall') {
            awaitingLink[from] = 'statusall';
            console.log('  → .statusall triggered');
            await sock.sendMessage(from, { text: 'Send your message with the channel link.' }, { quoted: msg });
            continue;
          }

          // ---- Handle link reply ----
          if (awaitingLink[from]) {
            const mode = awaitingLink[from];
            delete awaitingLink[from];
            console.log(`  → processing ${mode}`);

            const finalText = text;
            const isStatus = mode.includes('status');
            const toAll = mode.includes('all');

            async function post(jid) {
              const opts = { text: finalText };
              if (isStatus) opts.groupStatus = true;
              await sock.sendMessage(jid, opts);
            }

            if (toAll) {
              const groups = await sock.groupFetchAllParticipating();
              const ids = Object.keys(groups).filter(g => !g.endsWith('@newsletter'));
              await sock.sendMessage(from, { text: `📤 Posting to ${ids.length} groups...` });
              let s = 0, f = 0;
              for (const g of ids) {
                try { await post(g); s++; console.log(`  ✓ ${g}`); }
                catch (e) { f++; console.log(`  ✗ ${g}: ${e.message}`); }
                await new Promise(r => setTimeout(r, 5000));
              }
              await sock.sendMessage(from, { text: `✅ Done. Success: ${s}, Failed: ${f}` });
            } else {
              try {
                await post(from);
                await sock.sendMessage(from, { text: '✅ Posted!' });
              } catch (e) {
                await sock.sendMessage(from, { text: '❌ Failed: ' + e.message });
              }
            }
          }
        } catch (e) {
          console.log(`[MSG ERR] ${e.message}`);
        }
      }
    } catch (e) {
      console.log(`[UPSERT ERR] ${e.message}`);
    }
  });
}

connectDB().then(startBot).catch(e => {
  console.error('Startup failed:', e.message);
  process.exit(1);
});
