// index.js — WhatsApp bot with group status + preview card
const http = require('http');
const { MongoClient } = require('mongodb');
const {
  default: makeWASocket,
  initAuthCreds,
  BufferJSON,
  proto,
  DisconnectReason,
  fetchLatestWaWebVersion,
  Browsers,
  generateWAMessageFromContent,
  prepareWAMessageMedia,
  jidNormalizedUser
} = require('@rexxhayanasi/elaina-baileys');
const pino = require('pino');
const axios = require('axios');
const sharp = require('sharp');

const PORT = process.env.PORT || 10000;
const MONGODB_URI = process.env.MONGODB_URI;
const OWNER_NUMBER = '233206391674';
const DB_NAME = 'wa_saas';
const SESSION_KEY = 'owner';

let db;
let sock;
const awaitingLink = {};
const processedIds = new Set();

http.createServer((req, res) => {
  res.writeHead(200);
  res.end('OK');
}).listen(PORT, () => console.log(`✅ Health on ${PORT}`));

// ===== MongoDB auth state =====
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
    try { return JSON.parse(doc.data, BufferJSON.reviver); }
    catch (e) { return null; }
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

// ===== Fetch channel preview =====
async function fetchPreview(url) {
  try {
    const res = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml'
      },
      timeout: 15000
    });
    const html = res.data;
    const out = {};
    let m = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i);
    if (m) out.title = m[1].replace(/&amp;/g, '&').replace(/&#039;/g, "'");
    m = html.match(/<meta\s+property="og:description"\s+content="([^"]+)"/i);
    if (m) out.description = m[1].replace(/&amp;/g, '&').replace(/&#039;/g, "'");
    m = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i);
    if (m) out.image = m[1].replace(/&amp;/g, '&');

    if (out.image) {
      try {
        const r = await axios.get(out.image, {
          responseType: 'arraybuffer',
          timeout: 10000,
          headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        const originalBuffer = Buffer.from(r.data);
        // Convert to landscape (16:9) to satisfy status aspect ratio requirement
        const metadata = await sharp(originalBuffer).metadata();
        const targetWidth = 640;
        const targetHeight = Math.round(targetWidth / 1.78); // 16:9 = 1.78 (well above 1.4 min)
        const padded = await sharp(originalBuffer)
          .resize({
            width: Math.round(targetHeight * (metadata.width / metadata.height)),
            height: targetHeight,
            fit: 'contain',
            background: { r: 0, g: 0, b: 0, alpha: 1 }
          })
          .extend({
            top: 0, bottom: 0,
            left: Math.max(0, Math.round((targetWidth - Math.round(targetHeight * (metadata.width / metadata.height))) / 2)),
            right: Math.max(0, Math.round((targetWidth - Math.round(targetHeight * (metadata.width / metadata.height))) / 2)),
            background: { r: 0, g: 0, b: 0, alpha: 1 }
          })
          .jpeg({ quality: 90 })
          .toBuffer();
        out.thumbBuffer = padded;
        out.thumbWidth = targetWidth;
        out.thumbHeight = targetHeight;
        console.log(`[THUMB] resized to ${targetWidth}x${targetHeight} (ratio ${(targetWidth/targetHeight).toFixed(2)})`);
      } catch (e) {
        console.log('Thumb resize failed:', e.message);
        out.thumbBuffer = null;
      }
    }
    return out;
  } catch (e) { console.log('Preview fetch failed:', e.message); return null; }
}

// ===== Send group status with preview card =====
async function sendGroupStatusWithCard(groupJid, text, preview) {
  const senderJid = jidNormalizedUser(sock.user?.id);

  const contextInfo = {
    forwardingScore: 0,
    featureEligibilities: { canBeReshared: true, canReceiveMultiReact: true },
    pairedMediaType: 0,
    statusSourceType: 4,
    isGroupStatus: true,
    statusAttributions: [{ type: 6, groupStatus: { authorJid: senderJid } }],
    statusAudienceMetadata: { audienceType: 1, listEmoji: '', listName: 'Channel Update' }
  };

  // Attach externalAdReply — the preview card
  if (preview && preview.thumbBuffer) {
    contextInfo.externalAdReply = {
      title: preview.title || 'WhatsApp Channel',
      body: preview.description || 'Tap to view channel',
      mediaType: 1, // IMAGE — must be 1 for the card to render
      thumbnail: preview.thumbBuffer,
      thumbnailWidth: preview.thumbWidth,
      thumbnailHeight: preview.thumbHeight,
      sourceUrl: preview.channelUrl || 'https://whatsapp.com',
      mediaUrl: preview.channelUrl || 'https://whatsapp.com',
      renderLargerThumbnail: true,
      showAdAttribution: false,
      sourceApp: 'whatsapp'
    };
  }

  const innerContent = {
    extendedTextMessage: {
      text: text,
      font: 1,
      backgroundArgb: 0xFF23313A,
      contextInfo: contextInfo
    }
  };

  const messageContent = { groupStatusMessageV2: { message: innerContent } };
  const generated = generateWAMessageFromContent(groupJid, messageContent, { userJid: senderJid });
  await sock.relayMessage(groupJid, generated.message, { messageId: generated.key.id });
  return generated.key.id;
}

// ===== Send regular message with preview card =====
async function sendMessageWithPreview(jid, text, preview) {
  const opts = { text: text };
  if (preview && preview.thumbBuffer) {
    opts.contextInfo = {
      externalAdReply: {
        title: preview.title || 'WhatsApp Channel',
        body: preview.description || 'Tap to view channel',
        mediaType: 1,
        thumbnail: preview.thumbBuffer,
        thumbnailWidth: preview.thumbWidth,
        thumbnailHeight: preview.thumbHeight,
        sourceUrl: preview.channelUrl,
        mediaUrl: preview.channelUrl,
        renderLargerThumbnail: true,
        showAdAttribution: false
      }
    };
  }
  await sock.sendMessage(jid, opts);
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
        console.log('Enter in WhatsApp within 60 seconds.');
        console.log('');
      } catch (e) { console.log('Pair error:', e.message); }
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
      if (code !== DisconnectReason.loggedOut) setTimeout(startBot, 5000);
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
          if (from.endsWith('@newsletter') || from.endsWith('@broadcast')) continue;
          if (!from.endsWith('@g.us')) continue;
          if (!msg.key.fromMe) continue;

          const msgAge = Date.now() / 1000 - (msg.messageTimestamp || 0);
          if (msgAge > 30) continue;
          if (processedIds.has(msg.key.id)) continue;
          processedIds.add(msg.key.id);
          if (processedIds.size > 500) {
            const arr = Array.from(processedIds);
            processedIds.clear();
            arr.slice(-250).forEach(id => processedIds.add(id));
          }

          const text = msg.message.conversation ||
            (msg.message.extendedTextMessage && msg.message.extendedTextMessage.text) || '';
          const t = text.trim().toLowerCase();

          console.log(`[MSG] ${from} "${text.substring(0, 50)}"`);

          if (t === '.send' || t === '.sendall' || t === '.status' || t === '.statusall') {
            awaitingLink[from] = t.replace('.', '');
            const hint = t.includes('status') ? 'status' : 'message';
            const scope = t.includes('all') ? 'ALL groups' : 'THIS group';
            await sock.sendMessage(from, { text: `Send your message with the channel link to post as ${hint} to ${scope}.` }, { quoted: msg });
            continue;
          }

          if (awaitingLink[from]) {
            const hasLink = /(https?:\/\/[^\s]+)/i.test(text);
            if (!hasLink) continue;

            const mode = awaitingLink[from];
            delete awaitingLink[from];
            const isStatus = mode.includes('status');
            const toAll = mode.includes('all');
            const channelLink = text.match(/(https?:\/\/[^\s]+)/)[0];

            console.log(`[POST] ${mode} — fetching preview for ${channelLink}`);
            const preview = await fetchPreview(channelLink);
            if (preview) preview.channelUrl = channelLink;

            if (preview && preview.title) {
              console.log(`[PREVIEW] "${preview.title}" thumb=${preview.thumbBuffer ? preview.thumbBuffer.length + 'B' : 'none'}`);
            } else {
              console.log('[PREVIEW] failed');
            }

            const post = async (jid) => {
              if (isStatus) {
                await sendGroupStatusWithCard(jid, text, preview);
                console.log(`  ✓ status posted to ${jid}`);
              } else {
                await sendMessageWithPreview(jid, text, preview);
                console.log(`  ✓ message posted to ${jid}`);
              }
            };

            if (toAll) {
              const groups = await sock.groupFetchAllParticipating();
              const ids = Object.keys(groups).filter(g => !g.endsWith('@newsletter'));
              await sock.sendMessage(from, { text: `📤 Posting ${mode} to ${ids.length} groups...` });
              let s = 0, f = 0;
              for (const g of ids) {
                try { await post(g); s++; }
                catch (e) { f++; console.log(`  ✗ ${g}: ${e.message}`); }
                await new Promise(r => setTimeout(r, 5000));
              }
              await sock.sendMessage(from, { text: `✅ Done. Success: ${s}, Failed: ${f}` });
            } else {
              try {
                await post(from);
                await sock.sendMessage(from, { text: '✅ Posted!' });
              } catch (e) {
                console.log(`[POST ERR] ${e.message}`);
                await sock.sendMessage(from, { text: '❌ Failed: ' + e.message });
              }
            }
          }
        } catch (e) { console.log('[MSG ERR]', e.message); }
      }
    } catch (e) { console.log('[UPSERT ERR]', e.message); }
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
