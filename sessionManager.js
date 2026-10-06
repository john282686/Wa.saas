const { default: makeWASocket, DisconnectReason, fetchLatestBaileysVersion, Browsers } = require('@whiskeysockets/baileys');
const pino = require('pino');
const axios = require('axios');
const { getDB } = require('./db');
const { useMongoAuthState } = require('./authState');

const activeSessions = new Map();
let notifyUserFn = null;

function setNotifier(fn) { notifyUserFn = fn; }

async function notifyUser(telegramId, message, extra = {}) {
  if (notifyUserFn) {
    try { await notifyUserFn(telegramId, message, extra); }
    catch (e) { console.log('Notify err:', e.message); }
  }
}

async function createSession(telegramId, phoneNumber) {
  await removeSession(telegramId);

  const { state, saveCreds } = await useMongoAuthState(telegramId);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    auth: state,
    browser: Browsers.ubuntu('Chrome'),
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: true
  });

  sock.ev.on('creds.update', saveCreds);

  const session = { sock, status: 'pending', phone: phoneNumber, groups: 0 };
  activeSessions.set(telegramId, session);

  let codeRequested = false;

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && !sock.authState.creds.registered && !codeRequested) {
      codeRequested = true;
      try {
        const code = await sock.requestPairingCode(phoneNumber);
        console.log(`Pairing code for ${telegramId}: ${code}`);
        await notifyUser(telegramId,
          `🔑 *Your Pairing Code:* \`${code}\`\n\n` +
          `1. Open WhatsApp\n` +
          `2. Settings → Linked Devices\n` +
          `3. Link a Device → Link with phone number instead\n` +
          `4. Enter the code above (works only for 60 seconds)`,
          { parse_mode: 'Markdown' }
        );
      } catch (e) {
        console.log(`Pair code err for ${telegramId}: ${e.message}`);
        await notifyUser(telegramId, `❌ Failed to get pairing code: ${e.message}`);
      }
    }

    if (connection === 'connecting') session.status = 'connecting';

    if (connection === 'open') {
      session.status = 'connected';
      console.log(`✅ Session open for ${telegramId}`);
      try {
        const groups = await sock.groupFetchAllParticipating();
        session.groups = Object.keys(groups).length;
      } catch (e) {}

      await getDB().collection('users').updateOne(
        { telegram_id: telegramId },
        { $set: { telegram_id: telegramId, phone_number: phoneNumber, status: 'connected', last_active: new Date(), groups_count: session.groups } },
        { upsert: true }
      );

      await notifyUser(telegramId, `✅ *WhatsApp connected!*\n\nGroups: ${session.groups}\n\nUse /dashboard to control your bot.`, { parse_mode: 'Markdown' });
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      console.log(`Session closed for ${telegramId}. Code: ${code}`);

      if (code === DisconnectReason.loggedOut) {
        session.status = 'logged_out';
        activeSessions.delete(telegramId);
        await getDB().collection('users').updateOne(
          { telegram_id: telegramId },
          { $set: { status: 'logged_out' } }
        );
        await notifyUser(telegramId, '⚠️ WhatsApp disconnected. Use /pair to link again.');
      } else {
        session.status = 'reconnecting';
        setTimeout(() => {
          console.log(`Reconnecting ${telegramId}...`);
          createSession(telegramId, phoneNumber);
        }, 8000);
      }
    }
  });

  return sock;
}

async function removeSession(telegramId) {
  const existing = activeSessions.get(telegramId);
  if (existing && existing.sock) {
    try { existing.sock.end(undefined); } catch (e) {}
  }
  activeSessions.delete(telegramId);
  try {
    const coll = getDB().collection('sessions');
    const cursor = coll.find({ _id: { $regex: `^user_${telegramId}-` } });
    const docs = await cursor.toArray();
    for (const d of docs) await coll.deleteOne({ _id: d._id });
  } catch (e) {}
}

function getSession(telegramId) { return activeSessions.get(telegramId); }

async function restoreAllSessions() {
  try {
    const users = await getDB().collection('users').find({ status: { $in: ['connected', 'reconnecting'] } }).toArray();
    console.log(`Restoring ${users.length} session(s)...`);
    for (const user of users) {
      try {
        await createSession(user.telegram_id, user.phone_number);
        await new Promise(r => setTimeout(r, 3000));
      } catch (e) { console.log(`Failed to restore ${user.telegram_id}: ${e.message}`); }
    }
  } catch (e) { console.log('Restore failed:', e.message); }
}

function extractChannelLink(text) {
  const m = text.match(/(https?:\/\/)?(whatsapp\.com|chat\.whatsapp\.com|wa\.me)\/[^\s]+/i);
  if (!m) return null;
  return m[0].startsWith('http') ? m[0] : 'https://' + m[0];
}

async function fetchChannelPreview(url) {
  try {
    const res = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      timeout: 20000
    });
    const html = res.data;
    const out = {};
    let m = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i);
    if (m) out.title = m[1].replace(/&amp;/g, '&').replace(/&#039;/g, "'").replace(/&quot;/g, '"');
    m = html.match(/<meta\s+property="og:description"\s+content="([^"]+)"/i);
    if (m) out.description = m[1].replace(/&amp;/g, '&').replace(/&#039;/g, "'").replace(/&quot;/g, '"');
    m = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i);
    if (m) out.image = m[1].replace(/&amp;/g, '&');
    return out;
  } catch (e) { console.log('Preview failed:', e.message); return null; }
}

async function preparePreview(channelLink) {
  const data = await fetchChannelPreview(channelLink);
  if (!data || !data.title) return null;
  let thumb = null;
  if (data.image) {
    try {
      const r = await axios.get(data.image, { responseType: 'arraybuffer', timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0' } });
      thumb = Buffer.from(r.data);
    } catch (e) {}
  }
  return { title: data.title, description: data.description || '', thumb };
}

async function broadcastToAll(telegramId, messageText, asStatus = false) {
  const session = activeSessions.get(telegramId);
  if (!session || session.status !== 'connected') {
    return { success: 0, failed: 0, total: 0, error: 'Session not connected' };
  }
  const sock = session.sock;
  const channelLink = extractChannelLink(messageText);
  const preview = channelLink ? await preparePreview(channelLink) : null;

  const groups = await sock.groupFetchAllParticipating();
  const groupIds = Object.keys(groups);
  let success = 0, failed = 0;

  for (const gid of groupIds) {
    try {
      const opts = { text: messageText };
      if (asStatus) opts.groupStatus = true;
      if (preview && preview.thumb) {
        opts.contextInfo = {
          externalAdReply: {
            title: preview.title,
            body: preview.description || 'Tap to view channel',
            mediaType: 1,
            thumbnail: preview.thumb,
            sourceUrl: channelLink,
            mediaUrl: channelLink,
            showAdAttribution: false
          }
        };
      }
      await sock.sendMessage(gid, opts);
      success++;
    } catch (e) { failed++; }
    await new Promise(r => setTimeout(r, 8000));
  }

  await getDB().collection('users').updateOne(
    { telegram_id: telegramId },
    { $inc: { broadcasts_count: 1 }, $set: { last_active: new Date() } }
  );

  return { success, failed, total: groupIds.length };
}

module.exports = {
  createSession, removeSession, getSession,
  restoreAllSessions, setNotifier, broadcastToAll
};
