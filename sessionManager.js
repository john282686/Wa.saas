// sessionManager.js
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestWaWebVersion, Browsers } = require('@whiskeysockets/baileys');
const pino = require('pino');
const { getDB } = require('./db');
// ... (keep your auth state and admin check functions) ...

// ... (keep your createSession function, but update the message handler below) ...

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

          const text = msg.message.conversation || (msg.message.extendedTextMessage && msg.message.extendedTextMessage.text) || '';
          const t = text.trim().toLowerCase();

          // ---- Command Triggers ----
          if (t === '.send' || t === '.sendall' || t === '.status' || t === '.statusall') {
            const mode = t.replace('.', '');
            awaitingLink[from] = mode;
            const hint = t.includes('status') ? 'status' : 'message';
            const scope = t.includes('all') ? 'ALL groups' : 'THIS group';
            await sock.sendMessage(from, { text: `Send your message with the link to post as ${hint} to ${scope}.` }, { quoted: msg });
            continue;
          }

          // ---- Handle the link reply ----
          if (awaitingLink[from]) {
            const mode = awaitingLink[from];
            delete awaitingLink[from];
            const isStatus = mode.includes('status');
            const toAll = mode.includes('all');

            // This is the critical fix: use the correct method for statuses.
            async function post(jid) {
              if (isStatus) {
                // Use the native group status method from stian-baileys
                await sock.stianStatus.sendGroupStatus(jid, { text: text });
              } else {
                // Use the standard sendMessage for regular messages
                const opts = { text: text };
                await sock.sendMessage(jid, opts);
              }
            }
            // ... (the rest of the broadcast logic remains the same) ...
          }
        } catch (e) { console.log('[MSG ERR]', e.message); }
      }
    } catch (e) { console.log('[UPSERT ERR]', e.message); }
  });

// ... (rest of the file) ...
