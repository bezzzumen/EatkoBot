// server.js
// Express server that (1) serves the WebApp frontend, (2) exposes the JSON
// API the frontend calls to read/write diet data, and (3) runs the Telegram
// bot that opens the WebApp via a button.

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
// timezone the server itself happens to run in (e.g. a US-hosted server).
// This keeps the midnight reset, the evening summary, and the WebApp's own
// idea of "today" all pointing at the same date.
const DIET_TIMEZONE = 'Europe/Kyiv';

if (!BOT_TOKEN || BOT_TOKEN === 'your_token_here') {
  console.error('\n[!] BOT_TOKEN is not set. Put your real token in the .env file.\n');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Telegram WebApp initData validation
// ---------------------------------------------------------------------------
// Telegram signs the data it hands to the WebApp with your bot token. We
// re-derive that signature on the server and reject anything that doesn't
// match, so nobody can pretend to be a different Telegram user.
// Docs: https://core.telegram.org/bots/webapps#validating-data-received-via-the-web-app

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
    return JSON.parse(userJson); // { id, first_name, username, ... }
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
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

// Wraps a route handler so thrown Errors become clean 400 JSON responses
// instead of crashing the process or leaking stack traces.
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

// --- Read-only reference data -----------------------------------------------

// Fixed rules of the diet, so the frontend never has to hardcode them.
app.get('/api/config', requireTelegramAuth, (req, res) => {
  res.json({
    daily_calorie_target: db.DAILY_CALORIE_TARGET,
    protein_goal: db.PROTEIN_TARGET_G,
    carbs_goal: db.CARBS_TARGET_G,
    fat_goal: db.FAT_TARGET_G,
    meals_per_day: db.MEALS_PER_DAY,
    swap_category_letter: db.SWAP_CATEGORY_LETTER,
    swap_category_total_grams: db.SWAP_CATEGORY_TOTAL_GRAMS,
  });
});

// Full product catalog, grouped by category, plus the fruit pool used for
// the category swap. Fetched once when the app opens.
app.get('/api/catalog', requireTelegramAuth, (req, res) => {
  const categories = db.listCategories(); // includes the 'fruit' pseudo-category
  const productsByCategory = {};
  for (const cat of categories) {
    productsByCategory[cat.category_letter] = db.getProductsByCategory(cat.category_letter);
  }
  res.json({ categories, productsByCategory });
});

// --- State --------------------------------------------------------------

app.get('/api/state', requireTelegramAuth, safe((req, res) => {
  const date = req.query.date || todayISO();
  res.json(db.getTodayStatus(req.dbUser.id, date));
}));

// --- Logging actions ---------------------------------------------------

// Regular pick: a product from a category, at 100% or 50%.
app.post('/api/logs', requireTelegramAuth, safe((req, res) => {
  const { date, meal_number, category_letter, product_id, portion_percentage } = req.body;
  if (!category_letter || !product_id) {
    return res.status(400).json({ error: 'category_letter and product_id are required' });
  }
  const entry = db.markItemEaten(req.dbUser.id, date || todayISO(), meal_number, category_letter, {
    productId: product_id,
    portionPercentage: portion_percentage,
  });
  res.status(201).json(entry);
}));

// Swap: use part (or all) of the 'в' snacks/sweets budget as fruit instead.
app.post('/api/logs/swap', requireTelegramAuth, safe((req, res) => {
  const { date, meal_number, fruit_product_id, original_grams } = req.body;
  if (!fruit_product_id || original_grams == null) {
    return res.status(400).json({ error: 'fruit_product_id and original_grams are required' });
  }
  const entry = db.markSwapEaten(req.dbUser.id, date || todayISO(), meal_number, {
    fruitProductId: fruit_product_id,
    originalGrams: original_grams,
  });
  res.status(201).json(entry);
}));

// Rotation: move every entry for a category from one meal to another.
app.post('/api/logs/move', requireTelegramAuth, safe((req, res) => {
  const { date, category_letter, from_meal, to_meal } = req.body;
  if (!category_letter || from_meal == null || to_meal == null) {
    return res.status(400).json({ error: 'category_letter, from_meal and to_meal are required' });
  }
  const result = db.moveCategoryEntries(req.dbUser.id, date || todayISO(), category_letter, from_meal, to_meal);
  res.json(result);
}));

// Undo a single log entry.
app.delete('/api/logs/:id', requireTelegramAuth, safe((req, res) => {
  const result = db.deleteLogEntry(req.dbUser.id, Number(req.params.id));
  res.json(result);
}));

// Wipe a whole day and start over.
app.post('/api/reset', requireTelegramAuth, safe((req, res) => {
  const { date } = req.body;
  const result = db.resetDailyState(req.dbUser.id, date || todayISO());
  res.json(result);
}));

// ---------------------------------------------------------------------------
// Telegram bot
// ---------------------------------------------------------------------------

const bot = new Bot(BOT_TOKEN);

bot.command('start', async (ctx) => {
  if (!WEBAPP_URL || WEBAPP_URL.includes('your-public-url-here')) {
    return ctx.reply(
      'The app is not fully configured yet: WEBAPP_URL is missing in .env.\n' +
      'Ask whoever is running this bot to set it to a public HTTPS URL, then try /start again.'
    );
  }

  const keyboard = new InlineKeyboard().webApp('🍽️ Open Diet Tracker', WEBAPP_URL);

  await ctx.reply(
    `Hi ${ctx.from.first_name || ''}! Tap the button below to log meals and track your daily diet plan.`,
    { reply_markup: keyboard }
  );
});

bot.command('help', (ctx) =>
  ctx.reply('Use /start to open the diet tracker. Everything else happens inside the app.')
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

// Turns a getTodayStatus() snapshot into a friendly Telegram message: closed
// (completed) categories per meal, categories that were half-used and never
// finished, categories never touched at all today, and an overall adherence
// read against the daily calorie target.
function buildEveningSummaryMessage(status, allCategories) {
  const target = status.daily_calorie_target;
  const pct = target ? Math.round((status.total_calories / target) * 100) : 0;

  let adherenceLine;
  if (pct >= 90 && pct <= 110) {
    adherenceLine = '✅ <b>On track</b> — nice work today.';
  } else if (pct < 90) {
    adherenceLine = '⚠️ <b>Under target</b> — you still had room left today.';
  } else {
    adherenceLine = '🔴 <b>Over target</b> — a bit past today\u2019s goal.';
  }

  const touchedLetters = new Set();

  const mealLines = status.meals.map((meal) => {
    const completed = meal.categories.filter((c) => c.is_completed);
    const half = meal.categories.filter((c) => !c.is_completed);
    completed.forEach((c) => touchedLetters.add(c.category_letter));
    half.forEach((c) => touchedLetters.add(c.category_letter));

    const bits = [];
    if (completed.length) {
      bits.push(`✅ ${completed.map((c) => escapeHtml(c.category_letter.toUpperCase())).join(', ')}`);
    }
    if (half.length) {
      bits.push(`🕗 half-used: ${half.map((c) => escapeHtml(c.category_letter.toUpperCase())).join(', ')}`);
    }
    const body = bits.length ? bits.join('  ·  ') : 'nothing logged';

    return `<b>Meal ${meal.meal_number}</b> — ${Math.round(meal.calories)} kcal\n${body}`;
  });

  const untouched = allCategories
    .map((c) => c.category_letter)
    .filter((letter) => letter !== 'fruit' && !touchedLetters.has(letter));

  const untouchedLine = untouched.length
    ? `📋 <b>Not logged at all today:</b> ${untouched.map((l) => escapeHtml(l.toUpperCase())).join(', ')}`
    : '📋 Every category was touched today.';

  return [
    `🌙 <b>Evening Summary</b> — ${escapeHtml(status.date)}`,
    '',
    `🔥 <b>${Math.round(status.total_calories)} / ${Math.round(target)} kcal</b>  (${pct}%)`,
    adherenceLine,
    '',
    ...mealLines,
    '',
    untouchedLine,
  ].join('\n');
}

// 22:00 Europe/Kyiv, every day — send each user a summary of their day.
cron.schedule(
  '0 22 * * *',
  async () => {
    const date = todayISO();
    const allCategories = db.listCategories();
    const users = db.listUsers();
    console.log(`[cron] Evening summary: sending to ${users.length} user(s) for ${date}`);

    for (const user of users) {
      try {
        const status = db.getTodayStatus(user.id, date);
        const message = buildEveningSummaryMessage(status, allCategories);
        await bot.api.sendMessage(user.telegram_id, message, { parse_mode: 'HTML' });
      } catch (err) {
        console.error(`[cron] Evening summary failed for user ${user.id}:`, err.message);
      }
    }
  },
  { timezone: DIET_TIMEZONE }
);

// 00:00 Europe/Kyiv, every day — fresh checklist for the new day. In
// practice today's log is already empty at midnight (entries are stored per
// calendar date, so a new date has nothing logged yet) — this call is a
// safety net in case anything was ever logged against the wrong date, and
// gives every user a clean "Good morning" nudge with an empty checklist.
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
          `☀️ <b>New day, fresh checklist!</b>\nToday\u2019s target is <b>${db.DAILY_CALORIE_TARGET} kcal</b> across ${db.MEALS_PER_DAY} meals. Open the app to get started.`,
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
