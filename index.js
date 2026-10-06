// index.js — Simple WhatsApp bot with 4 commands
const http = require('http');
const { MongoClient } = require('mongodb');
const {
  default: makeWASocket,
  DisconnectReason,
  fetchLatestWaWebVersion,
  Browsers,
  initAuthCreds,
  BufferJSON,
  proto
} = require('@whiskeysockets/baileys');
const pino = require('pino');

const PORT = process.env.PORT || 10000;
const MONGODB_URI = process.env.MONGODB_URI;
const OWNER_NUMBER = '233206391674';
const DB_NAME = 'wa_saas';
const SESSION_KEY = 'owner';

let db;
let sock;
const awaitingLink = {};

// Health check
http.createServer((req, res) => {
  res.writeHead(200);
  res.end('OK');
}).listen(PORT, () => console.log(`✅ Health on port ${PORT}`));

// MongoDB auth state
async function useMongoAuthState(key) {
  const coll = db.collection('sessions');
  const writeData = async (data, id) => {
    const json = JSON.stringify(data, BufferJSON.replacer);
    await coll.updateOne(
      { _id: `${key}-${id}` },
      { $set: { data: json, updated_at: new Date() } },
      { upsert: true }
    );
  };
  const readData = async (id) => {
    const doc = await coll.findOne({ _id: `${key}-${id}` });
    if (!doc) return null;
    try { return JSON.parse(doc.data, BufferJSON.reviver); } catch (e) { return null; }
  };
  const removeData = async (id) => {
    await coll.deleteOne({ _id: `${key}-${id}` });
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
  console.log('Registered:', state.creds.registered);

  sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    auth: state,
    browser: Browsers.macOS('Chrome'),
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: true
  });

  sock.ev.on('creds.update', saveCreds);

  if (!state.creds.registered) {
    console.log('⏳ Requesting pairing code in 3 seconds...');
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(OWNER_NUMBER);
        console.log('');
        console.log('========================================');
        console.log('🔑 PAIRING CODE: ' + code);
        console.log('========================================');
        console.log('Open WhatsApp > Linked Devices > Link a Device > Link with phone number instead');
        console.log('Enter code within 60 seconds.');
        console.log('');
      } catch (e) {
        console.log('Pair error:', e.message);
      }
    }, 3000);
  }

  sock.ev.on('connection.update', (u) => {
    const { connection, lastDisconnect } = u;
    if (connection === 'connecting') console.log('Connecting...');
    if (connection === 'open') console.log('✅ WhatsApp connected!');
    if (connection === 'close') {
      const code = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output
        ? lastDisconnect.error.output.statusCode : 0;
      console.log('Closed. Code:', code);
      if (code !== DisconnectReason.loggedOut) {
        setTimeout(startBot, 5000);
      } else {
        console.log('⚠️ Logged out. Delete sessions from MongoDB and restart.');
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
          if (from.endsWith('@newsletter')) continue;
          if (from.endsWith('@broadcast')) continue;
          if (!from.endsWith('@g.us')) continue;
          if (!msg.key.fromMe) continue;

          const text = msg.message.conversation ||
            (msg.message.extendedTextMessage && msg.message.extendedTextMessage.text) ||
            (msg.message.imageMessage && msg.message.imageMessage.caption) || '';
          const t = text.trim().toLowerCase();

          console.log(`[MSG] ${from} "${text.substring(0, 60)}"`);

          if (t === '.send' || t === '.sendall' || t === '.status' || t === '.statusall') {
            awaitingLink[from] = t.replace('.', '');
            const hint = t.includes('status') ? 'status' : 'message';
            const scope = t.includes('all') ? 'ALL groups' : 'THIS group';
            console.log(`  → ${t} triggered`);
            await sock.sendMessage(from, {
              text: `Send your message with the channel link to post as ${hint} to ${scope}.`
            }, { quoted: msg });
            continue;
          }

          if (awaitingLink[from]) {
            const mode = awaitingLink[from];
            delete awaitingLink[from];
            const isStatus = mode.includes('status');
            const toAll = mode.includes('all');

            const post = async (jid) => {
              const opts = { text: text };
              if (isStatus) opts.groupStatus = true;
              await sock.sendMessage(jid, opts);
            };

            if (toAll) {
              const groups = await sock.groupFetchAllParticipating();
              const ids = Object.keys(groups).filter(g => !g.endsWith('@newsletter'));
              await sock.sendMessage(from, { text: `📤 Posting to ${ids.length} groups...` });
              let s = 0, f = 0;
              for (const g of ids) {
                try { await post(g); s++; console.log(`  ✓ ${g}`); }
                catch (e) { f++; console.log(`  ✗ ${g}`); }
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
          console.log('[MSG ERR]', e.message);
        }
      }
    } catch (e) {
      console.log('[UPSERT ERR]', e.message);
    }
  });
}

async function main() {
  console.log('Connecting to MongoDB...');
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  db = client.db(DB_NAME);
  console.log('✅ MongoDB connected');
  await startBot();
}

main().catch(e => {
  console.error('Startup failed:', e.message);
  process.exit(1);
});
