// groupProtection.js
// Detects and handles group violations

const ADMIN_COMMANDS = [
  '.tagall', '.kick', '.promote', '.demote', '.warn',
  '.guardianlog', '.selfaudit', '.stats', '.pause',
  '.brief', '.sendbrief', '.silent', '.persona'
];

function getText(msg) {
  if (!msg.message) return '';
  return (
    msg.message.conversation ||
    (msg.message.extendedTextMessage && msg.message.extendedTextMessage.text) ||
    (msg.message.imageMessage && msg.message.imageMessage.caption) ||
    (msg.message.videoMessage && msg.message.videoMessage.caption) ||
    ''
  );
}

function detectViolations(msg) {
  const violations = [];
  const text = getText(msg);

  // 1. Links (any URL)
  if (/(https?:\/\/|www\.)/i.test(text)) violations.push('link');

  // 2. WhatsApp group invites
  if (/chat\.whatsapp\.com\//i.test(text)) violations.push('group-invite');

  // 3. Phone numbers (10-15 digits)
  if (/\b\d{10,15}\b/.test(text)) violations.push('phone');

  // 4. Forwarded messages
  const ctx = msg.message.extendedTextMessage && msg.message.extendedTextMessage.contextInfo;
  if (ctx && ctx.isForwarded) violations.push('forwarded');

  // 5. Contact cards
  if (msg.message.contactMessage || msg.message.contactsArrayMessage) violations.push('contact');

  // 6. Channel mentions / forwarded from channel
  if (ctx && ctx.forwardedNewsletterMessageInfo) violations.push('channel');

  return violations;
}

function isAdminCommand(text) {
  const t = (text || '').trim().toLowerCase();
  return ADMIN_COMMANDS.includes(t);
}

function asksAboutGroup(text) {
  const t = (text || '').toLowerCase();
  const patterns = [
    'what is this group',
    'whats this group',
    'what\'s this group',
    'what is the group',
    'wetn is this group',
    'wetin be this group',
    'what is this about',
    'what is this group for',
    'whats this group for'
  ];
  return patterns.some(p => t.includes(p));
}

module.exports = {
  getText,
  detectViolations,
  isAdminCommand,
  asksAboutGroup,
  ADMIN_COMMANDS
};
