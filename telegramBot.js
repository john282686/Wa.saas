// telegramBot.js
const { Telegraf, Markup } = require('telegraf');
const { createSession, removeSession, getSession, restoreAllSessions, setNotifier, setProtection } = require('./sessionManager');
const { getDB } = require('./db');

const userState = new Map();

function startTelegramBot() {
  const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

  setNotifier(async (telegramId, message, extra = {}) => {
    try { await bot.telegram.sendMessage(telegramId, message, extra); }
    catch (e) { console.log(`Notify ${telegramId} fail: ${e.message}`); }
  });

  bot.start((ctx) => {
    ctx.reply(
      '🤖 *WhatsApp Group Guardian Bot*\n\n' +
      '/pair — Link your WhatsApp\n' +
      '/commands — All WhatsApp commands\n' +
      '/protect on — Turn on protection\n' +
      '/protect off — Turn off protection\n' +
      '/dashboard — Live status\n' +
      '/broadcast — Send message to all groups\n' +
      '/status — Post to all groups as status\n' +
      '/unpair — Disconnect WhatsApp\n' +
      '/help — Guide',
      { parse_mode: 'Markdown' }
    );
  });

  bot.command('help', (ctx) => {
    ctx.reply(
      '📖 *How to use*\n\n' +
      '1. /pair → send your WhatsApp number (e.g. 233XXXXXXXXX)\n' +
      '2. Bot gives you a pairing code\n' +
      '3. WhatsApp → Settings → Linked Devices → Link a Device → Link with phone number instead\n' +
      '4. Enter the code\n' +
      '5. Done! Send /commands to see what the bot can do\n\n' +
      '🛡️ Protection only works in groups where YOU are an admin.',
      { parse_mode: 'Markdown' }
    );
  });

  bot.command('commands', (ctx) => {
    ctx.reply(
      '📋 *WhatsApp Commands*\n\n' +
      '*Owner only (typed in WhatsApp group):*\n' +
      '`.send` — Post message to this group\n' +
      '`.sendall` — Post message to ALL your groups\n' +
      '`.status` — Post as status in this group\n' +
      '`.statusall` — Post as status in ALL groups\n\n' +
      '*Auto protection (when ON):*\n' +
      '🚫 Deletes: links, phone numbers, group invites, forwards, contact cards\n' +
      '⚠️ 3 warnings → user removed\n' +
      '✅ Admins are exempt\n\n' +
      '*Other replies:*\n' +
      '❌ Non-admins using admin commands get "This command is for the admin"\n' +
      '📖 "What is this group for" → "Read the group description"',
      { parse_mode: 'Markdown' }
    );
  });

  bot.command('pair', async (ctx) => {
    const telegramId = ctx.from.id;
    const existing = getSession(telegramId);
    if (existing && existing.status === 'connected') {
      return ctx.reply('⚠️ WhatsApp already linked. Use /unpair first.');
    }
    userState.set(telegramId, { action: 'awaiting_number' });
    ctx.reply('📱 Send your WhatsApp number with country code (digits only).\n\nExample: `233XXXXXXXXX`', { parse_mode: 'Markdown' });
  });

  bot.command('unpair', async (ctx) => {
    const telegramId = ctx.from.id;
    await removeSession(telegramId);
    await getDB().collection('users').updateOne(
      { telegram_id: telegramId }, { $set: { status: 'logged_out' } }
    );
    ctx.reply('✅ WhatsApp unlinked.');
  });

  bot.command('protect', async (ctx) => {
    const telegramId = ctx.from.id;
    const session = getSession(telegramId);
    if (!session || session.status !== 'connected') {
      return ctx.reply('❌ No WhatsApp linked. Send /pair first.');
    }
    const arg = (ctx.message.text.split(' ')[1] || '').toLowerCase();
    if (arg === 'on') {
      setProtection(telegramId, true);
      await getDB().collection('users').updateOne(
        { telegram_id: telegramId }, { $set: { protection_enabled: true } }
      );
      ctx.reply('🛡️ Protection ON.\n\nI will delete links, forwards, phone numbers, contact cards, and group invites in groups where you are admin.');
    } else if (arg === 'off') {
      setProtection(telegramId, false);
      await getDB().collection('users').updateOne(
        { telegram_id: telegramId }, { $set: { protection_enabled: false } }
      );
      ctx.reply('🛑 Protection OFF.');
    } else {
      ctx.reply('Usage: `/protect on` or `/protect off`', { parse_mode: 'Markdown' });
    }
  });

  bot.command('dashboard', async (ctx) => {
    const telegramId = ctx.from.id;
    const session = getSession(telegramId);
    if (!session || session.status !== 'connected') {
      return ctx.reply('❌ No WhatsApp linked. Send /pair to link.');
    }
    let groups = 0;
    try {
      const g = await session.sock.groupFetchAllParticipating();
      groups = Object.keys(g).filter(k => !k.endsWith('@newsletter')).length;
      session.groups = groups;
    } catch (e) {}
    const user = await getDB().collection('users').findOne({ telegram_id: telegramId });
    ctx.reply(
      `📊 *Dashboard*\n\n` +
      `Status: 🟢 Live\n` +
      `Phone: ${session.phone}\n` +
      `Groups: ${groups}\n` +
      `Protection: ${session.protectionEnabled ? '🛡️ ON' : '🛑 OFF'}\n` +
      `Broadcasts: ${user?.broadcasts_count || 0}`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🛡️ Toggle Protection', 'toggle_protect')],
          [Markup.button.callback('📋 Show Commands', 'show_commands')]
        ])
      }
    );
  });

  bot.command('broadcast', (ctx) => {
    const session = getSession(ctx.from.id);
    if (!session || session.status !== 'connected') return ctx.reply('❌ Link WhatsApp first.');
    userState.set(ctx.from.id, { action: 'awaiting_broadcast' });
    ctx.reply('📝 Send the message you want to send to all your groups.');
  });

  bot.command('status', (ctx) => {
    const session = getSession(ctx.from.id);
    if (!session || session.status !== 'connected') return ctx.reply('❌ Link WhatsApp first.');
    userState.set(ctx.from.id, { action: 'awaiting_status' });
    ctx.reply('📝 Send the message you want to post as a group status.');
  });

  bot.on('text', async (ctx) => {
    const telegramId = ctx.from.id;
    const text = ctx.message.text.trim();
    const state = userState.get(telegramId);
    if (!state) return;

    if (state.action === 'awaiting_number') {
      if (!/^\d{8,15}$/.test(text)) return ctx.reply('❌ Invalid. Send digits only (e.g. 233XXXXXXXXX).');
      userState.delete(telegramId);
      await ctx.reply('⏳ Creating session...');
      try { await createSession(telegramId, text); }
      catch (e) { ctx.reply(`❌ Error: ${e.message}`); }
      return;
    }

    if (state.action === 'awaiting_broadcast' || state.action === 'awaiting_status') {
      const isStatus = state.action === 'awaiting_status';
      userState.delete(telegramId);
      const session = getSession(telegramId);
      if (!session || session.status !== 'connected') return ctx.reply('❌ Session offline. /pair again.');
      const groups = await session.sock.groupFetchAllParticipating();
      const ids = Object.keys(groups).filter(k => !k.endsWith('@newsletter'));
      await ctx.reply(`📤 Posting to ${ids.length} groups...`);
      let s = 0, f = 0;
      for (const g of ids) {
        try {
          const opts = { text };
          if (isStatus) opts.groupStatus = true;
          await session.sock.sendMessage(g, opts);
          s++;
        } catch (e) { f++; }
        await new Promise(r => setTimeout(r, 8000));
      }
      await getDB().collection('users').updateOne(
        { telegram_id: telegramId }, { $inc: { broadcasts_count: 1 } }
      );
      ctx.reply(`✅ Done.\nSuccess: ${s}\nFailed: ${f}`);
      return;
    }
  });

  bot.action('toggle_protect', async (ctx) => {
    const telegramId = ctx.from.id;
    const session = getSession(telegramId);
    if (!session) return ctx.answerCbQuery('No session');
    const newVal = !session.protectionEnabled;
    setProtection(telegramId, newVal);
    await getDB().collection('users').updateOne(
      { telegram_id: telegramId }, { $set: { protection_enabled: newVal } }
    );
    await ctx.answerCbQuery(newVal ? 'Protection ON' : 'Protection OFF');
    ctx.reply(newVal ? '🛡️ Protection ON.' : '🛑 Protection OFF.');
  });

  bot.action('show_commands', async (ctx) => {
    await ctx.answerCbQuery();
    ctx.reply(
      '`.send` / `.sendall` / `.status` / `.statusall` — typed in WhatsApp group as the owner.',
      { parse_mode: 'Markdown' }
    );
  });

  bot.launch();
  console.log('✅ Telegram bot launched');
}

module.exports = { startTelegramBot };
