// telegramBot.js
const { Telegraf, Markup } = require('telegraf');
const { createSession, removeSession, getSession, setNotifier, setProtection } = require('./sessionManager');
const { getDB } = require('./db');

const userState = new Map();

function startTelegramBot() {
  const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

  setNotifier(async (telegramId, message, extra = {}) => {
    try { await bot.telegram.sendMessage(telegramId, message, extra); }
    catch (e) { console.log(`Notify ${telegramId} fail: ${e.message}`); }
  });

  const MAIN_MENU = Markup.keyboard([
    ['🔗 Link WhatsApp', '📊 Dashboard'],
    ['🛡️ Protect ON', '🛑 Protect OFF'],
    ['📋 Commands', '❓ Help']
  ]).resize();

  bot.start((ctx) => {
    ctx.reply(
      '🤖 *Welcome to WhatsApp Guardian Bot*\n\n' +
      'I protect your WhatsApp groups from:\n' +
      '• Links & spam\n' +
      '• Forwards & contact cards\n' +
      '• Phone numbers & group invites\n\n' +
      'I can also post messages & statuses to all your groups.\n\n' +
      'Choose an option below to begin 👇',
      { parse_mode: 'Markdown', ...MAIN_MENU }
    );
  });

  bot.hears('🔗 Link WhatsApp', (ctx) => {
    const telegramId = ctx.from.id;
    const existing = getSession(telegramId);
    if (existing && existing.status === 'connected') {
      return ctx.reply('⚠️ WhatsApp already linked. Send /unpair first to link a different number.');
    }
    userState.set(telegramId, { action: 'awaiting_number' });
    ctx.reply('📱 Send your WhatsApp number with country code (digits only).\n\nExample: `233XXXXXXXXX`', { parse_mode: 'Markdown' });
  });

  bot.hears('📊 Dashboard', async (ctx) => {
    const telegramId = ctx.from.id;
    const session = getSession(telegramId);
    if (!session || session.status !== 'connected') {
      return ctx.reply('❌ No WhatsApp linked yet.\n\nTap "🔗 Link WhatsApp" to begin.');
    }
    let groups = 0;
    try {
      const g = await session.sock.groupFetchAllParticipating();
      groups = Object.keys(g).filter(k => !k.endsWith('@newsletter')).length;
    } catch (e) {}
    const user = await getDB().collection('users').findOne({ telegram_id: telegramId });
    ctx.reply(
      `📊 *Your Dashboard*\n\n` +
      `Status: 🟢 Live\n` +
      `Phone: \`${session.phone}\`\n` +
      `Groups: ${groups}\n` +
      `Protection: ${session.protectionEnabled ? '🛡️ ON' : '🛑 OFF'}\n` +
      `Broadcasts sent: ${user?.broadcasts_count || 0}`,
      { parse_mode: 'Markdown' }
    );
  });

  bot.hears('🛡️ Protect ON', async (ctx) => {
    const session = getSession(ctx.from.id);
    if (!session || session.status !== 'connected') return ctx.reply('❌ Link WhatsApp first.');
    setProtection(ctx.from.id, true);
    await getDB().collection('users').updateOne(
      { telegram_id: ctx.from.id }, { $set: { protection_enabled: true } }
    );
    ctx.reply('🛡️ Protection *ON*.\n\nYour groups will now be guarded where you are admin.', { parse_mode: 'Markdown' });
  });

  bot.hears('🛑 Protect OFF', async (ctx) => {
    const session = getSession(ctx.from.id);
    if (!session || session.status !== 'connected') return ctx.reply('❌ Link WhatsApp first.');
    setProtection(ctx.from.id, false);
    await getDB().collection('users').updateOne(
      { telegram_id: ctx.from.id }, { $set: { protection_enabled: false } }
    );
    ctx.reply('🛑 Protection *OFF*.', { parse_mode: 'Markdown' });
  });

  bot.hears('📋 Commands', (ctx) => {
    ctx.reply(
      '📋 *WhatsApp Commands*\n\n' +
      '*Owner (send in a group you admin):*\n' +
      '`.send` — Post to this group\n' +
      '`.sendall` — Post to all your groups\n' +
      '`.status` — Status in this group\n' +
      '`.statusall` — Status in all groups\n\n' +
      '*Auto protection (when ON):*\n' +
      '🚫 Links, phone numbers, invites, forwards, contacts\n' +
      '⚠️ 3 warnings → removal\n' +
      '✅ Admins exempt',
      { parse_mode: 'Markdown' }
    );
  });

  bot.hears('❓ Help', (ctx) => {
    ctx.reply(
      '📖 *How to use*\n\n' +
      '1. Tap "🔗 Link WhatsApp"\n' +
      '2. Send your number\n' +
      '3. Enter the pairing code in WhatsApp\n' +
      '4. Bot sends commands to your WhatsApp\n' +
      '5. Tap "🛡️ Protect ON" to guard your groups',
      { parse_mode: 'Markdown' }
    );
  });

  // Old command-style inputs (still work)
  bot.command('pair', (ctx) => {
    userState.set(ctx.from.id, { action: 'awaiting_number' });
    ctx.reply('📱 Send your WhatsApp number with country code (digits only).\n\nExample: `233XXXXXXXXX`', { parse_mode: 'Markdown' });
  });

  bot.command('unpair', async (ctx) => {
    await removeSession(ctx.from.id);
    await getDB().collection('users').updateOne(
      { telegram_id: ctx.from.id }, { $set: { status: 'logged_out' } }
    );
    ctx.reply('✅ WhatsApp unlinked.');
  });

  bot.command('commands', (ctx) => {
    ctx.reply(
      '📋 *WhatsApp Commands*\n\n' +
      '`.send` / `.sendall` / `.status` / `.statusall`\n\n' +
      'Use "🛡️ Protect ON" to enable group protection.',
      { parse_mode: 'Markdown' }
    );
  });

  bot.command('protect', async (ctx) => {
    const arg = (ctx.message.text.split(' ')[1] || '').toLowerCase();
    const session = getSession(ctx.from.id);
    if (!session || session.status !== 'connected') return ctx.reply('❌ Link WhatsApp first.');
    if (arg === 'on') {
      setProtection(ctx.from.id, true);
      await getDB().collection('users').updateOne(
        { telegram_id: ctx.from.id }, { $set: { protection_enabled: true } }
      );
      ctx.reply('🛡️ Protection ON.');
    } else if (arg === 'off') {
      setProtection(ctx.from.id, false);
      await getDB().collection('users').updateOne(
        { telegram_id: ctx.from.id }, { $set: { protection_enabled: false } }
      );
      ctx.reply('🛑 Protection OFF.');
    } else {
      ctx.reply('Usage: `/protect on` or `/protect off`', { parse_mode: 'Markdown' });
    }
  });

  bot.command('dashboard', async (ctx) => {
    const session = getSession(ctx.from.id);
    if (!session || session.status !== 'connected') return ctx.reply('❌ No WhatsApp linked.');
    ctx.reply(`📊 Status: 🟢 Live\nPhone: ${session.phone}\nProtection: ${session.protectionEnabled ? 'ON' : 'OFF'}`);
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
  });

  bot.launch();
  console.log('✅ Telegram bot launched');
}

module.exports = { startTelegramBot };
