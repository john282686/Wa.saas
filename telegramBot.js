const { Telegraf, Markup } = require('telegraf');
const { createSession, removeSession, getSession, broadcastToAll, setNotifier } = require('./sessionManager');
const { getDB } = require('./db');

const userState = new Map();

function startTelegramBot() {
  const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

  setNotifier(async (telegramId, message, extra = {}) => {
    try { await bot.telegram.sendMessage(telegramId, message, extra); }
    catch (e) { console.log(`Notify to ${telegramId} failed: ${e.message}`); }
  });

  bot.start((ctx) => {
    ctx.reply(
      '🤖 *WhatsApp Bot Controller*\n\n' +
      '/pair — Link your WhatsApp\n' +
      '/dashboard — Live dashboard\n' +
      '/broadcast — Send message to all groups\n' +
      '/status — Post status to all groups\n' +
      '/unpair — Disconnect WhatsApp\n' +
      '/help — Full guide',
      { parse_mode: 'Markdown' }
    );
  });

  bot.command('help', (ctx) => {
    ctx.reply(
      '📖 *How to use*\n\n' +
      '1. Send /pair\n' +
      '2. Send your WhatsApp number with country code (no +, e.g. 233206391674)\n' +
      '3. Bot gives you a pairing code\n' +
      '4. Open WhatsApp → Settings → Linked Devices → Link a Device → Link with phone number instead\n' +
      '5. Enter the code\n' +
      '6. Done! Use /dashboard to control',
      { parse_mode: 'Markdown' }
    );
  });

  bot.command('pair', async (ctx) => {
    const telegramId = ctx.from.id;
    const existing = getSession(telegramId);
    if (existing && existing.status === 'connected') {
      return ctx.reply('⚠️ WhatsApp already linked. Use /unpair first to link a different number.');
    }
    userState.set(telegramId, { action: 'awaiting_number' });
    ctx.reply('📱 Send your WhatsApp number with country code (digits only).\n\nExample: `233206391674`', { parse_mode: 'Markdown' });
  });

  bot.command('unpair', async (ctx) => {
    const telegramId = ctx.from.id;
    await removeSession(telegramId);
    await getDB().collection('users').updateOne(
      { telegram_id: telegramId }, { $set: { status: 'logged_out' } }
    );
    ctx.reply('✅ WhatsApp unlinked.');
  });

  bot.command('dashboard', async (ctx) => {
    const telegramId = ctx.from.id;
    const session = getSession(telegramId);
    if (!session || session.status !== 'connected') {
      return ctx.reply('❌ No WhatsApp linked.\n\nSend /pair to link.');
    }
    let groups = 0;
    try {
      const g = await session.sock.groupFetchAllParticipating();
      groups = Object.keys(g).length;
      session.groups = groups;
    } catch (e) {}
    const user = await getDB().collection('users').findOne({ telegram_id: telegramId });
    const broadcasts = user?.broadcasts_count || 0;
    ctx.reply(
      `📊 *Dashboard*\n\n` +
      `Status: 🟢 Live\n` +
      `Groups: ${groups}\n` +
      `Broadcasts: ${broadcasts}\n` +
      `Phone: ${session.phone}\n\n` +
      `Choose an action:`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('📤 Broadcast to All Groups', 'action_broadcast')],
          [Markup.button.callback('🔗 Post Status to All Groups', 'action_status')],
          [Markup.button.callback('🔄 Refresh', 'action_refresh')]
        ])
      }
    );
  });

  bot.command('broadcast', (ctx) => {
    const telegramId = ctx.from.id;
    const session = getSession(telegramId);
    if (!session || session.status !== 'connected') return ctx.reply('❌ No WhatsApp linked. Send /pair first.');
    userState.set(telegramId, { action: 'awaiting_broadcast_message' });
    ctx.reply('📝 Send the message you want to broadcast to all your groups.\n\nInclude your channel link for the preview card.');
  });

  bot.command('status', (ctx) => {
    const telegramId = ctx.from.id;
    const session = getSession(telegramId);
    if (!session || session.status !== 'connected') return ctx.reply('❌ No WhatsApp linked. Send /pair first.');
    userState.set(telegramId, { action: 'awaiting_status_message' });
    ctx.reply('📝 Send the message you want to post as a *group status* in all your groups.', { parse_mode: 'Markdown' });
  });

  bot.on('text', async (ctx) => {
    const telegramId = ctx.from.id;
    const text = ctx.message.text.trim();
    const state = userState.get(telegramId);
    if (!state) return;

    if (state.action === 'awaiting_number') {
      if (!/^\d{8,15}$/.test(text)) return ctx.reply('❌ Invalid. Send digits only (e.g. 233206391674).');
      userState.delete(telegramId);
      await ctx.reply('⏳ Creating session...');
      try { await createSession(telegramId, text); }
      catch (e) { ctx.reply(`❌ Error: ${e.message}`); }
      return;
    }

    if (state.action === 'awaiting_broadcast_message' || state.action === 'awaiting_status_message') {
      const isStatus = state.action === 'awaiting_status_message';
      userState.delete(telegramId);
      const session = getSession(telegramId);
      if (!session || session.status !== 'connected') return ctx.reply('❌ Session disconnected. Use /pair.');
      const groups = await session.sock.groupFetchAllParticipating();
      const total = Object.keys(groups).length;
      await ctx.reply(`📤 ${isStatus ? 'Posting status' : 'Broadcasting'} to ${total} groups...\n\nThis may take ${Math.ceil(total * 8 / 60)} minutes.`);
      const result = await broadcastToAll(telegramId, text, isStatus);
      ctx.reply(
        `✅ *Done*\n\nSuccess: ${result.success}\nFailed: ${result.failed}\nTotal: ${result.total}`,
        { parse_mode: 'Markdown' }
      );
      return;
    }
  });

  bot.action('action_broadcast', async (ctx) => {
    await ctx.answerCbQuery();
    userState.set(ctx.from.id, { action: 'awaiting_broadcast_message' });
    ctx.reply('📝 Send the message you want to broadcast to all your groups.');
  });

  bot.action('action_status', async (ctx) => {
    await ctx.answerCbQuery();
    userState.set(ctx.from.id, { action: 'awaiting_status_message' });
    ctx.reply('📝 Send the message you want to post as a group status in all your groups.');
  });

  bot.action('action_refresh', async (ctx) => {
    await ctx.answerCbQuery('Refreshed');
    ctx.reply('Send /dashboard to refresh.');
  });

  bot.launch();
  console.log('✅ Telegram bot launched');
  return bot;
}

module.exports = { startTelegramBot };
