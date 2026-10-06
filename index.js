// index.js — runs BOTH Telegram bot AND WhatsApp bot
require('dotenv').config();
const http = require('http');
const { connectDB } = require('./db');
const { startTelegramBot } = require('./telegramBot');
const { restoreAllSessions } = require('./sessionManager');

const PORT = process.env.PORT || 10000;

http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('OK');
}).listen(PORT, () => console.log(`✅ Health server on port ${PORT}`));

async function main() {
  try {
    await connectDB();
    startTelegramBot();
    setTimeout(() => restoreAllSessions(), 5000);
    console.log('🚀 Bot started');
  } catch (e) {
    console.error('❌ Startup failed:', e);
    process.exit(1);
  }
}

main();
