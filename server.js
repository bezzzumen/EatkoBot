// server.js
// Express server: serves the WebApp frontend, exposes the JSON API for the
// flexible daily grams budget tracker, runs the Telegram bot, and schedules
// the evening-summary / midnight-reset jobs.

require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cron = require('node-cron');
const { Bot, InlineKeyboard } = require('grammy');

const db = require('./database');

const BOT_TOKEN = process.env.BOT_TOKEN;
const PORT = process.env.PORT || 3000;
const WEBAPP_URL = process.env.WEBAPP_URL;

// The diet's "day" always means a calendar day in Kyiv time, no matter what
// timezone the server itself runs in.
const DIET_TIMEZONE = 'Europe/Kyiv';

if (!BOT_TOKEN || BOT_TOKEN === 'your_token_here') {
  console.error('\n[!] BOT_TOKEN is not set. Put your real token in the .env file.\n');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Telegram WebApp initData validation
// ---------------------------------------------------------------------------

function validateInitData(initData) {
  if (!initData) return null;

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;

  params.delete('hash');
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  if (computedHash !== hash) return null;

  const userJson = params.get('user');
  if (!userJson) return null;

  try {
    return JSON.parse(userJson);
  } catch {
    return null;
  }
}

function requireTelegramAuth(req, res, next) {
  const initData = req.header('X-Telegram-Init-Data');
  const tgUser = validateInitData(initData);

  if (!tgUser) {
    return res.status(401).json({ error: 'Invalid or missing Telegram auth data' });
  }

  req.tgUser = tgUser;
  req.dbUser = db.getOrCreateUser({
    telegram_id: tgUser.id,
    first_name: tgUser.first_name,
    username: tgUser.username,
  });
  next();
}

function todayISO(timeZone = DIET_TIMEZONE) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function safe(handler) {
  return (req, res) => {
    try {
      handler(req, res);
    } catch (err) {
      res.status(400).json({ error: err.message || 'Something went wrong' });
    }
  };
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Full day snapshot: categories, items, max grams, logged grams, usage %,
// and total calories consumed vs the daily budget.
app.get('/api/today', requireTelegramAuth, safe((req, res) => {
  const date = req.query.date || todayISO();
  res.json(db.getTodayStatus(req.dbUser.id, date));
}));

// Add grams to an item for today (accumulates with whatever's already
// logged). Send a negative number to correct a mistake. Returns the fresh
// daily status so the frontend doesn't need a second request.
app.post('/api/log-grams', requireTelegramAuth, safe((req, res) => {
  const { productId, grams, date } = req.body;
  if (productId == null || grams == null) {
    return res.status(400).json({ error: 'productId and grams are required' });
  }
  const status = db.logGrams(req.dbUser.id, date || todayISO(), productId, grams);
  res.json(status);
}));

// Clears today's logs and returns the fresh (empty) daily status.
app.post('/api/reset', requireTelegramAuth, safe((req, res) => {
  const date = req.body?.date || todayISO();
  db.resetDailyState(req.dbUser.id, date);
  res.json(db.getTodayStatus(req.dbUser.id, date));
}));

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
// Scheduled jobs (node-cron, Europe/Kyiv time)
// ---------------------------------------------------------------------------

function escapeHtml(str) {
  return String(str).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

// Turns a getTodayStatus() snapshot into a friendly Telegram message: total
// calories vs budget, an adherence read, and each category's usage % with a
// status icon (🔸 active / ✅ complete / ⚠️ over budget).
function buildEveningSummaryMessage(status) {
  const target = status.daily_calorie_target;
  const pct = target ? Math.round((status.total_calories / target) * 100) : 0;

  let adherenceLine;
  if (pct >= 90 && pct <= 110) {
    adherenceLine = '✅ <b>В межах норми</b> — гарна робота сьогодні.';
  } else if (pct < 90) {
    adherenceLine = '⚠️ <b>Менше норми</b> — ще є запас на сьогодні.';
  } else {
    adherenceLine = '🔴 <b>Перевищено норму</b> — трохи більше за денну ціль.';
  }

  const catLines = status.categories.map((c) => {
    const icon = c.status === 'over' ? '⚠️' : c.status === 'complete' ? '✅' : '🔸';
    return `${icon} ${escapeHtml(c.emoji)} <b>${escapeHtml(c.category_name)}</b> — ${c.usage_percent}% (${Math.round(c.calories_consumed)} ккал)`;
  });

  return [
    `🌙 <b>Вечірній підсумок</b> — ${escapeHtml(status.date)}`,
    '',
    `🔥 <b>${Math.round(status.total_calories)} / ${Math.round(target)} ккал</b>  (${pct}%)`,
    adherenceLine,
    `🔥 <b>Серія: ${status.streak} ${status.streak === 1 ? 'день' : 'днів'} поспіль</b>`,
    '',
    ...catLines,
  ].join('\n');
}

// 22:00 Europe/Kyiv, every day — send each user their daily summary.
cron.schedule(
  '0 22 * * *',
  async () => {
    const date = todayISO();
    const users = db.listUsers();
    console.log(`[cron] Evening summary: sending to ${users.length} user(s) for ${date}`);

    for (const user of users) {
      try {
        const status = db.getTodayStatus(user.id, date);
        const message = buildEveningSummaryMessage(status);
        await bot.api.sendMessage(user.telegram_id, message, { parse_mode: 'HTML' });
      } catch (err) {
        console.error(`[cron] Evening summary failed for user ${user.id}:`, err.message);
      }
    }
  },
  { timezone: DIET_TIMEZONE }
);

// 00:00 Europe/Kyiv, every day — fresh checklist. A new calendar date has
// nothing logged yet by construction, so this is mostly a safety net; the
// good-morning message is the real point.
cron.schedule(
  '0 0 * * *',
  async () => {
    const date = todayISO();
    const users = db.listUsers();
    console.log(`[cron] Daily reset: clearing ${date} for ${users.length} user(s)`);

    for (const user of users) {
      try {
        db.resetDailyState(user.id, date);
        await bot.api.sendMessage(
          user.telegram_id,
          `☀️ <b>Новий день, чистий чек-лист!</b>\nСьогоднішня ціль — <b>${db.DAILY_CALORIE_TARGET} ккал</b>. Відкрийте застосунок, щоб почати.`,
          { parse_mode: 'HTML' }
        );
      } catch (err) {
        console.error(`[cron] Daily reset failed for user ${user.id}:`, err.message);
      }
    }
  },
  { timezone: DIET_TIMEZONE }
);

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`✅ Server listening on http://localhost:${PORT}`);
});

bot.start();
console.log('✅ Telegram bot is polling for updates');
