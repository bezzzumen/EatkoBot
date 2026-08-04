// server.js
// Express server: serves the WebApp frontend, exposes the static product
// catalog, and runs the Telegram bot that opens the WebApp.
//
// There is no per-user server-side state anymore — daily logs live in the
// browser via Telegram CloudStorage (localStorage as a fallback), computed
// entirely client-side from the catalog this server hands out once on load.
// See public/app.js for that logic, and database.js for why the catalog
// itself no longer needs a database.
//
// NOTE — dropped along with SQLite: the 22:00 evening-summary and 00:00
// daily-reset cron jobs from the previous version. Both required the server
// to read a user's logged data, which is no longer possible (CloudStorage is
// only readable from inside the Mini App itself, not via the Bot API) — so
// rather than leave cron jobs that silently do nothing, they're removed. The
// "daily reset" need also disappears naturally: a new date is just a
// CloudStorage key that doesn't exist yet.

require('dotenv').config();
const path = require('path');
const express = require('express');
const { Bot, InlineKeyboard } = require('grammy');

const { CATALOG } = require('./database');

const BOT_TOKEN = process.env.BOT_TOKEN;
const PORT = process.env.PORT || 3000;
const WEBAPP_URL = process.env.WEBAPP_URL;

if (!BOT_TOKEN || BOT_TOKEN === 'your_token_here') {
  console.error('\n[!] BOT_TOKEN is not set. Put your real token in the .env file.\n');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

// Static, read-only reference data: the 8 categories, their items, and the
// calorie/macro goals. No user data flows through the server at all, so this
// needs no auth — fetched once when the WebApp opens, then cached client-side.
app.get('/api/catalog', (req, res) => {
  res.json(CATALOG);
});

// ---------------------------------------------------------------------------
// Telegram bot
// ---------------------------------------------------------------------------

const bot = new Bot(BOT_TOKEN);

bot.command('start', async (ctx) => {
  if (!WEBAPP_URL || WEBAPP_URL.includes('your-public-url-here')) {
    return ctx.reply(
      'Застосунок ще не повністю налаштований: у .env відсутній WEBAPP_URL.\n' +
      'Попросіть того, хто запускає бота, вказати публічну HTTPS-адресу, і спробуйте /start ще раз.'
    );
  }

  const keyboard = new InlineKeyboard().webApp('🍽️ Відкрити щоденник харчування', WEBAPP_URL);

  await ctx.reply(
    `Привіт, ${ctx.from.first_name || ''}! Натисніть кнопку нижче, щоб вести облік харчування на сьогодні.`,
    { reply_markup: keyboard }
  );
});

bot.command('help', (ctx) =>
  ctx.reply('Натисніть /start, щоб відкрити трекер. Все інше відбувається всередині застосунку.')
);

bot.catch((err) => {
  console.error('Bot error:', err);
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`✅ Server listening on http://localhost:${PORT}`);
});

bot.start();
console.log('✅ Telegram bot is polling for updates');
