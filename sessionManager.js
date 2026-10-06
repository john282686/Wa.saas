// sessionManager.js
const { default: makeWASocket, DisconnectReason, fetchLatestWaWebVersion, Browsers } = require('@whiskeysockets/baileys');
const pino = require('pino');
const { getDB } = require('./db');
const { useMongoAuthState } = require('./authState');
const { getText, detectViolations, isAdminCommand, asksAboutGroup } = require('./groupProtection');

const activeSessions = new Map();
const adminCache = new Map();
const pairingCodeSent = new Map();
let notifyUserFn = null;

function setNotifier(fn) { notifyUserFn = fn; }

async function notifyUser(telegramId, message, extra = {}) {
  if (notifyUserFn) {
    try { await notifyUserFn(telegramId, message, extra); }
    catch (e) { console.log('Notify err:', e.message); }
  }
}

async function getGroupAdmins(sock, telegramId, groupJid) {
  const key = `${telegramId}-${groupJid}`;
  const cached = adminCache.get(key);
  if (cached && Date.now() - cached.ts < 5 * 60 * 1000) return cached.admins;
  try {
    const meta = await sock.groupMetadata(groupJid);
    const admins = meta.participants
      .filter(p => p.admin === 'admin' || p.admin === 'superadmin')
      .map(p => p.id.split('@')[0].split(':')[0]);
    adminCache.set(key, { admins, ts: Date.now() });
    return admins;
  } catch (e) { return []; }
}

async function isParticipantAdmin(sock, telegramId, groupJid, participantJid) {
  if (!participantJid) return false;
  const num = participantJid.split('@')[0].split(':')[0];
  const admins = await getGroupAdmins(sock, telegramId, groupJid);
  return admins.includes(num);
}

async function isOwnerAdmin(sock, telegramId, groupJid, ownerNumber) {
  const admins = await getGroupAdmins(sock, telegramId, groupJid);
  return admins.includes(String(ownerNumber).replace(/\D/g, ''));
}

async function createSession(telegramId, phoneNumber, skipWipe = false) {
  if (!skipWipe) {
    await removeSession(telegramId);
  }

  const { state, saveCreds } = await useMongoAuthState(telegramId);

  let version;
  try {
    const r = await fetchLatestWaWebVersion();
    version = r.version;
    console.log(`Using WA Web version: ${version.join('.')}`);
  } catch (e) {
    version = [2, 3000, 1035194821];
    console.log('Using fallback version');
  }

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

  const db = getDB();
  const user = await db.collection('users').findOne({ telegram_id: telegramId });
  const protectionEnabled = user ? !!user.protection_enabled : false;

  const session = {
    sock,
    status: 'pending',
    phone: phoneNumber,
    groups: 0,
    protectionEnabled,
    hasSentConnectMsg: false,
    ownerNumber: String(phoneNumber).replace(/\D/g, '')
  };
  activeSessions.set(telegramId, session);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && !sock.authState.creds.registered && !pairingCodeSent.get(telegramId)) {
      pairingCodeSent.set(telegramId, true);
      try {
        const code = await sock.requestPairingCode(phoneNumber);
        console.log(`🔑 Pair code for ${telegramId}: ${code}`);
        await notifyUser(telegramId,
          `🔑 *Your Pairing Code:* \`${code}\`\n\n` +
          `1. Open WhatsApp\n` +
          `2. Settings → Linked Devices\n` +
          `3. Link a Device → Link with phone number instead\n` +
          `4. Enter this code (valid 60 seconds only)`,
          { parse_mode: 'Markdown' }
        );
      } catch (e) {
        console.log(`Pair err ${telegramId}: ${e.message}`);
        await notifyUser(telegramId, `❌ Pairing failed: ${e.message}`);
      }
    }

    if (connection === 'connecting') session.status = 'connecting';

    if (connection === 'open') {
      if (!sock.user || !sock.user.id) {
        console.log(`⚠️ Fake connect for ${telegramId}`);
        try { sock.end(undefined); } catch (e) {}
        return;
      }

      if (session.hasSentConnectMsg) return;
      session.hasSentConnectMsg = true;
      session.status = 'connected';
      console.log(`✅ Real connect: ${telegramId} (${session.ownerNumber})`);

      try {
        const groups = await sock.groupFetchAllParticipating();
        session.groups = Object.keys(groups).filter(k => !k.endsWith('@newsletter')).length;
      } catch (e) {}

      await db.collection('users').updateOne(
        { telegram_id: telegramId },
        {
          $set: {
            telegram_id: telegramId,
            phone_number: phoneNumber,
            status: 'connected',
            last_active: new Date(),
            groups_count: session.groups
          }
        },
        { upsert: true }
      );

      try {
        const selfJid = session.ownerNumber + '@s.whatsapp.net';
        await sock.sendMessage(selfJid, {
          text:
            `🤖 *WhatsApp Guardian Bot — Commands*\n\n` +
            `*Owner commands (type in any group you admin):*\n` +
            `.send — Post to this group\n` +
            `.sendall — Post to ALL your groups\n` +
            `.status — Post as status in this group\n` +
            `.statusall — Post as status in ALL groups\n\n` +
            `*Auto protection (turn on in Telegram):*\n` +
            `🚫 Links, phone numbers, invites, forwards, contacts\n` +
            `⚠️ 3 warnings → user removed\n` +
            `✅ Admins are exempt`
        });
      } catch (e) { console.log('Self-chat send failed:', e.message); }

      await notifyUser(telegramId,
        `✅ *WhatsApp connected!*\n\n` +
        `📱 Phone: ${phoneNumber}\n` +
        `👥 Groups: ${session.groups}\n` +
        `🛡️ Protection: ${session.protectionEnabled ? 'ON' : 'OFF'}`,
        { parse_mode: 'Markdown' }
      );
    }

    if (connection === 'close') {
      const code = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output
        ? lastDisconnect.error.output.statusCode : 0;
      console.log(`Close ${telegramId}. Code: ${code}`);

      if (code === DisconnectReason.loggedOut) {
        session.status = 'logged_out';
        activeSessions.delete(telegramId);
        await db.collection('users').updateOne(
          { telegram_id: telegramId }, { $set: { status: 'logged_out' } }
        );
        await notifyUser(telegramId, '⚠️ WhatsApp disconnected. Use /pair to link again.');
      } else if (code === 401) {
        console.log(`401 for ${telegramId}. Wiping.`);
        session.status = 'logged_out';
        activeSessions.delete(telegramId);
      } else {
        session.status = 'reconnecting';
        setTimeout(() => createSession(telegramId, phoneNumber, true), 8000);
      }
    }
  });

  // Persistent link queue — survives reconnects
const linkQueuePath = './linkqueue.json';
const fs = require('fs');
function loadQueue() {
  try { return JSON.parse(fs.readFileSync(linkQueuePath, 'utf8')); }
  catch (e) { return {}; }
}
function saveQueue(q) {
  try { fs.writeFileSync(linkQueuePath, JSON.stringify(q)); } catch (e) {}
}
let awaitingLink = loadQueue();
const warnings = new Map();

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    try {
      // DEBUG LOG
      console.log(`\n[UPSERT] type=${type} count=${messages.length}`);
      if (!messages || messages.length === 0) return;
      if (type !== 'notify' && type !== 'append') return;

      for (const msg of messages) {
        try {
          if (!msg || !msg.message) continue;
          const from = msg.key.remoteJid;
          if (!from) continue;

          const textPreview = getText(msg).substring(0, 60);
          console.log(`[MSG] from=${from} fromMe=${msg.key.fromMe} text="${textPreview}" type=${type}`);

          if (from.endsWith('@newsletter')) continue;
          if (from.endsWith('@broadcast')) continue;
          if (!from.endsWith('@g.us')) continue;

          const text = getText(msg);
          const t = text.trim().toLowerCase();
          const senderJid = msg.key.participant || msg.key.remoteJid;
          const senderNum = senderJid.split('@')[0].split(':')[0];

          // ---- Owner commands ----
          if (msg.key.fromMe) {
            if (t === '.send' || t === '.sendall' || t === '.status' || t === '.statusall') {
  const mode = t.replace('.', '');
  awaitingLink[from] = mode;
  saveQueue(awaitingLink);
              const hint = t.includes('status') ? 'status' : 'message';
              const scope = t.includes('all') ? 'ALL groups' : 'THIS group';
              console.log(`[CMD] ${mode} triggered in ${from}`);
              try {
                await sock.sendMessage(from, { text: `Send your channel link to post as ${hint} to ${scope}.` }, { quoted: msg });
                console.log(`[CMD] Reply sent`);
              } catch (e) {
                console.log(`[CMD] Reply failed: ${e.message}`);
              }
              continue;
            }

            if (awaitingLink[from]) {
  const mode = awaitingLink[from];
  delete awaitingLink[from];
  saveQueue(awaitingLink);
              const linkMatch = text.match(/(https?:\/\/[^\s]+)/);
              if (!linkMatch) {
                console.log(`[LINK] No link found in message`);
                continue;
              }
              const channelLink = linkMatch[0];
              const extraText = text.replace(channelLink, '').trim();
              const finalText = extraText ? extraText + '\n' + channelLink : channelLink;
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
                  try { await post(g); s++; } catch (e) { f++; }
                  await new Promise(r => setTimeout(r, 8000));
                }
                await sock.sendMessage(from, { text: `✅ Done. Success: ${s}, Failed: ${f}` });
              } else {
                try { await post(from); await sock.sendMessage(from, { text: '✅ Posted!' }); }
                catch (e) { await sock.sendMessage(from, { text: '❌ Failed: ' + e.message }); }
              }
              continue;
            }
            continue;
          }

          // ---- Non-owner: admin commands ----
          if (isAdminCommand(t)) {
            const isAdmin = await isParticipantAdmin(sock, telegramId, from, senderJid);
            if (!isAdmin) {
              await sock.sendMessage(from, { text: '❌ This command is for the admin.' }, { quoted: msg });
            }
            continue;
          }

          // ---- Group description question ----
          if (asksAboutGroup(text)) {
            await sock.sendMessage(from, { text: '📖 Please read the group description.' }, { quoted: msg });
            continue;
          }

          // ---- Protection ----
          if (session.protectionEnabled && session.ownerNumber) {
            const ownerAdmin = await isOwnerAdmin(sock, telegramId, from, session.ownerNumber);
            if (!ownerAdmin) continue;
            const senderAdmin = await isParticipantAdmin(sock, telegramId, from, senderJid);
            if (senderAdmin) continue;

            const violations = detectViolations(msg);
            if (violations.length > 0) {
              try { await sock.sendMessage(from, { delete: msg.key }); } catch (e) {}
              const wkey = `${from}-${senderJid}`;
              const count = (warnings.get(wkey) || 0) + 1;
              warnings.set(wkey, count);
              if (count >= 3) {
                try {
                  await sock.groupParticipantsUpdate(from, [senderJid], 'remove');
                  await sock.sendMessage(from, { text: `🚫 @${senderNum} removed after 3 warnings.`, mentions: [senderJid] });
                  warnings.delete(wkey);
                } catch (e) {}
              } else {
                await sock.sendMessage(from, { text: `⚠️ @${senderNum} Warning ${count}/3 — ${violations.join(', ')}.`, mentions: [senderJid] }, { quoted: msg });
              }
            }
          }
        } catch (e) {
          console.log(`[MSG ERROR] ${e.message}`);
        }
      }
    } catch (e) {
      console.log(`[UPSERT ERROR] ${e.message}`);
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
    const docs = await coll.find({ _id: { $regex: `^user_${telegramId}-` } }).toArray();
    for (const d of docs) await coll.deleteOne({ _id: d._id });
  } catch (e) {}
}

function getSession(telegramId) { return activeSessions.get(telegramId); }

function setProtection(telegramId, enabled) {
  const s = activeSessions.get(telegramId);
  if (s) s.protectionEnabled = !!enabled;
}

function resetPairingCode(telegramId) {
  pairingCodeSent.delete(telegramId);
}

async function restoreAllSessions() {
  try {
    const users = await getDB().collection('users')
      .find({ status: { $in: ['connected', 'reconnecting'] } }).toArray();
    console.log(`Restoring ${users.length} session(s)...`);
    for (const user of users) {
      try {
        await createSession(user.telegram_id, user.phone_number, true);
        await new Promise(r => setTimeout(r, 3000));
      } catch (e) { console.log(`Restore fail ${user.telegram_id}: ${e.message}`); }
    }
  } catch (e) { console.log('Restore error:', e.message); }
}

module.exports = {
  createSession, removeSession, getSession,
  restoreAllSessions, setNotifier, setProtection, resetPairingCode
};
