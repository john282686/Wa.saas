// sessionManager.js
const { default: makeWASocket, DisconnectReason, fetchLatestBaileysVersion, Browsers } = require('@whiskeysockets/baileys');
const pino = require('pino');
const axios = require('axios');
const { getDB } = require('./db');
const { useMongoAuthState } = require('./authState');
const { getText, detectViolations, isAdminCommand, asksAboutGroup } = require('./groupProtection');

const activeSessions = new Map();
const adminCache = new Map(); // key: `${telegramId}-${groupJid}` → { admins, ts }
let notifyUserFn = null;

function setNotifier(fn) { notifyUserFn = fn; }

async function notifyUser(telegramId, message, extra = {}) {
  if (notifyUserFn) {
    try { await notifyUserFn(telegramId, message, extra); }
    catch (e) { console.log('Notify err:', e.message); }
  }
}

// ================ ADMIN CHECK (cached 5 min) ================
async function getGroupAdmins(sock, telegramId, groupJid) {
  const key = `${telegramId}-${groupJid}`;
  const cached = adminCache.get(key);
  if (cached && Date.now() - cached.ts < 5 * 60 * 1000) {
    return cached.admins;
  }
  try {
    const meta = await sock.groupMetadata(groupJid);
    const admins = meta.participants
      .filter(p => p.admin === 'admin' || p.admin === 'superadmin')
      .map(p => p.id.split('@')[0].split(':')[0]);
    adminCache.set(key, { admins, ts: Date.now() });
    return admins;
  } catch (e) {
    return [];
  }
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

// ================ CREATE SESSION ================
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

  // Load user settings from DB
  const db = getDB();
  let user = await db.collection('users').findOne({ telegram_id: telegramId });
  const protectionEnabled = user ? !!user.protection_enabled : false;

  const session = {
    sock,
    status: 'pending',
    phone: phoneNumber,
    groups: 0,
    protectionEnabled
  };
  activeSessions.set(telegramId, session);

  let codeRequested = false;

  // ================ CONNECTION EVENTS ================
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && !sock.authState.creds.registered && !codeRequested) {
      codeRequested = true;
      try {
        const code = await sock.requestPairingCode(phoneNumber);
        console.log(`Pair code for ${telegramId}: ${code}`);
        // Send commands to user's own WhatsApp (Message Yourself chat)
try {
  const selfJid = session.ownerNumber + '@s.whatsapp.net';
  const commandsMessage =
    `🤖 *WhatsApp Guardian Bot — Commands*\n\n` +
    `*Owner commands (type in any group you admin):*\n` +
    `\`.send\` — Post message to this group\n` +
    `\`.sendall\` — Post message to ALL your groups\n` +
    `\`.status\` — Post as status in this group\n` +
    `\`.statusall\` — Post as status in ALL groups\n\n` +
    `*Auto protection (turn on in Telegram with /protect on):*\n` +
    `🚫 Deletes: links, phone numbers, group invites, forwards, contact cards\n` +
    `⚠️ 3 warnings → user removed from group\n` +
    `✅ Admins are exempt\n\n` +
    `*Automatic replies:*\n` +
    `📖 "What is this group for" → "Read the group description"\n` +
    `❌ Non-admin using admin command → "This command is for the admin"\n\n` +
    `*Control this bot from Telegram.*`;

  await sock.sendMessage(selfJid, { text: commandsMessage });
  console.log(`📩 Commands sent to WhatsApp self-chat for ${telegramId}`);
} catch (e) {
  console.log(`Failed to send WhatsApp commands: ${e.message}`);
}

// Also notify on Telegram
await notifyUser(telegramId,
  `✅ *WhatsApp connected!*\n\n` +
  `📱 Phone: ${phoneNumber}\n` +
  `👥 Groups: ${session.groups}\n` +
  `🛡️ Protection: ${session.protectionEnabled ? 'ON' : 'OFF'}\n\n` +
  `📩 The full command list has been sent to your WhatsApp (Message Yourself).\n\n` +
  `Use /commands to see them here, or /protect on to enable group protection.`,
  { parse_mode: 'Markdown' }
);
      } catch (e) {
        console.log(`Pair err ${telegramId}: ${e.message}`);
        await notifyUser(telegramId, `❌ Pairing failed: ${e.message}`);
      }
    }

    if (connection === 'connecting') session.status = 'connecting';

    if (connection === 'open') {
  if (session.hasSentConnectMsg) return;
  session.hasSentConnectMsg = true;
  session.status = 'connected';
  session.ownerNumber = String(phoneNumber).replace(/\D/g, '');

      try {
        const groups = await sock.groupFetchAllParticipating();
        session.groups = Object.keys(groups).length;
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

      await notifyUser(telegramId,
        `✅ *WhatsApp connected!*\n\n` +
        `📱 Phone: ${phoneNumber}\n` +
        `👥 Groups: ${session.groups}\n` +
        `🛡️ Protection: ${session.protectionEnabled ? 'ON' : 'OFF'}\n\n` +
        `Send /commands to see all commands.`,
        { parse_mode: 'Markdown' }
      );
    }

    if (connection === 'close') {
      const code = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output
        ? lastDisconnect.error.output.statusCode : 0;
      console.log(`Session closed ${telegramId}. Code: ${code}`);

      if (code === DisconnectReason.loggedOut) {
        session.status = 'logged_out';
        activeSessions.delete(telegramId);
        await db.collection('users').updateOne(
          { telegram_id: telegramId }, { $set: { status: 'logged_out' } }
        );
        await notifyUser(telegramId, '⚠️ WhatsApp disconnected. Send /pair to link again.');
      } else {
        session.status = 'reconnecting';
        setTimeout(() => {
          console.log(`Reconnecting ${telegramId}...`);
          createSession(telegramId, phoneNumber);
        }, 8000);
      }
    }
  });

  // ================ MESSAGE HANDLER ================
  const awaitingLink = {};
  const warnings = new Map(); // `${groupJid}-${userJid}` → count

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    const msg = messages[0];
    if (!msg.message) return;

    const from = msg.key.remoteJid;

    // NEVER touch channels or broadcasts
    if (from.endsWith('@newsletter')) return;
    if (from.endsWith('@broadcast')) return;

    // Only handle groups
    if (!from.endsWith('@g.us')) return;

    const text = getText(msg);
    const t = text.trim().toLowerCase();
    const senderJid = msg.key.participant || msg.key.remoteJid;
    const senderNum = senderJid.split('@')[0].split(':')[0];

    // ---- Owner commands (.send, .sendall, .status, .statusall) ----
    if (msg.key.fromMe) {
      if (t === '.send' || t === '.sendall' || t === '.status' || t === '.statusall') {
        const mode = t.replace('.', '');
        awaitingLink[from] = mode;
        const hint = t.includes('status') ? 'status' : 'message';
        const scope = t.includes('all') ? 'ALL groups' : 'THIS group';
        await sock.sendMessage(from, { text: `Send your channel link to post as ${hint} to ${scope}.` }, { quoted: msg });
        return;
      }
      return; // ignore everything else from owner
    }

    // ---- Non-owner: check for admin command ----
    if (isAdminCommand(t)) {
      const isAdmin = await isParticipantAdmin(sock, telegramId, from, senderJid);
      if (!isAdmin) {
        await sock.sendMessage(from, { text: '❌ This command is for the admin.' }, { quoted: msg });
        return;
      }
      // If admin, ignore here (future: implement admin commands)
      return;
    }

    // ---- Handle "what is this group for" ----
    if (asksAboutGroup(text)) {
      await sock.sendMessage(from, { text: '📖 Please read the group description.' }, { quoted: msg });
      return;
    }

    // ---- Protection checks (only if enabled AND owner is admin) ----
    if (session.protectionEnabled && session.ownerNumber) {
      const ownerAdmin = await isOwnerAdmin(sock, telegramId, from, session.ownerNumber);
      if (!ownerAdmin) return; // owner not admin here → skip protection

      const senderAdmin = await isParticipantAdmin(sock, telegramId, from, senderJid);
      if (senderAdmin) return; // admins exempt

      const violations = detectViolations(msg);
      if (violations.length > 0) {
        // Delete the violating message
        try { await sock.sendMessage(from, { delete: msg.key }); } catch (e) {}

        const wkey = `${from}-${senderJid}`;
        const count = (warnings.get(wkey) || 0) + 1;
        warnings.set(wkey, count);

        if (count >= 3) {
          try {
            await sock.groupParticipantsUpdate(from, [senderJid], 'remove');
            await sock.sendMessage(from, { text: `🚫 @${senderNum} has been removed after 3 warnings.`, mentions: [senderJid] });
            warnings.delete(wkey);
          } catch (e) {
            await sock.sendMessage(from, { text: `⚠️ Warning 3/3 for @${senderNum} (could not remove).`, mentions: [senderJid] });
          }
        } else {
          const reason = violations.join(', ');
          await sock.sendMessage(from, { text: `⚠️ @${senderNum} Warning ${count}/3 — ${reason} not allowed.`, mentions: [senderJid] }, { quoted: msg });
        }
      }
    }

    // ---- Handle incoming link when awaiting ----
    if (awaitingLink[from]) {
      // Only owner can trigger (checked above with fromMe)
      // This block only runs if fromMe was true and awaitingLink set
      // (Actually fromMe returns early, so this section is unreachable here)
    }
  });

  // ---- Owner message handler (still needs to process the link after .send) ----
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    const msg = messages[0];
    if (!msg.message) return;
    if (!msg.key.fromMe) return;

    const from = msg.key.remoteJid;
    if (!from.endsWith('@g.us')) return;
    if (!awaitingLink[from]) return;

    const mode = awaitingLink[from];
    delete awaitingLink[from];

    const text = getText(msg);
    const linkMatch = text.match(/(https?:\/\/[^\s]+)/);
    if (!linkMatch) return;
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
      try {
        await post(from);
        await sock.sendMessage(from, { text: '✅ Posted!' });
      } catch (e) {
        await sock.sendMessage(from, { text: '❌ Failed: ' + e.message });
      }
    }
  });

  return sock;
}

// ================ HELPERS ================
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

async function restoreAllSessions() {
  try {
    const users = await getDB().collection('users')
      .find({ status: { $in: ['connected', 'reconnecting'] } }).toArray();
    console.log(`Restoring ${users.length} session(s)...`);
    for (const user of users) {
      try {
        await createSession(user.telegram_id, user.phone_number);
        await new Promise(r => setTimeout(r, 3000));
      } catch (e) { console.log(`Restore fail ${user.telegram_id}: ${e.message}`); }
    }
  } catch (e) { console.log('Restore error:', e.message); }
}

module.exports = {
  createSession, removeSession, getSession,
  restoreAllSessions, setNotifier, setProtection
};
