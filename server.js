// server.js
// Express server: serves the WebApp frontend, exposes the static product
// catalog, runs the Telegram bot, and (new) triggers an AI-written evening
// summary message on demand.
//
// There is still no per-user server-side state for daily logs — those live
// in the browser via Telegram CloudStorage (localStorage as a fallback),
// computed client-side from the catalog this server hands out once on load.
// See public/app.js for that logic, and database.js for why the catalog
// itself no longer needs a database.
//
// IMPORTANT — this endpoint did not exist before this change. The old
// cron-based evening summary was removed when logs moved to CloudStorage,
// because the server had no way to read a user's data anymore. This new
// /api/trigger-evening-summary endpoint solves that differently: the CLIENT
// (which already has the day's computed status) calls this endpoint and
// sends that status along; the server never reads storage itself, it just
// turns what it's given into an AI-written message and sends it via the bot.
// Nothing calls this endpoint automatically yet — wiring up public/app.js to
// call it (e.g. once per day, after some local evening-time check) is a
// separate, not-yet-done step.

require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { Bot, InlineKeyboard } = require('grammy');

const db = require('./database');
const { CATALOG } = db;

const BOT_TOKEN = process.env.BOT_TOKEN;
const PORT = process.env.PORT || 3000;
const WEBAPP_URL = process.env.WEBAPP_URL;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

// The diet's "day" always means a calendar day in Kyiv time, no matter what
// timezone the server itself runs in.
const DIET_TIMEZONE = 'Europe/Kyiv';
function todayISO(timeZone = DIET_TIMEZONE) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

if (!BOT_TOKEN || BOT_TOKEN === 'your_token_here') {
  console.error('\n[!] BOT_TOKEN is not set. Put your real token in the .env file.\n');
  process.exit(1);
}
if (!GEMINI_API_KEY || GEMINI_API_KEY === 'your_gemini_api_key_here') {
  console.warn(
    '\n[!] GEMINI_API_KEY is not set — /api/trigger-evening-summary will still work, ' +
    'but will fall back to a static line instead of an AI-generated one.\n'
  );
}

// ---------------------------------------------------------------------------
// Telegram WebApp initData validation
// ---------------------------------------------------------------------------
// The catalog endpoint below is public (no user data involved), but this
// endpoint actually causes a side effect — sending a Telegram message to
// someone — so unlike the rest of this CloudStorage-era server, it's worth
// re-adding auth here specifically: we need to know the REAL Telegram user
// making the request, both to send the message to the right chat and to
// stop an arbitrary client from claiming to be a different user.

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
    return JSON.parse(userJson); // { id, first_name, ... }
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function escapeHtml(str) {
  return String(str).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

// Ukrainian noun inflection for "день" — kept in sync by hand with the
// identical function in public/app.js (they run in different JS contexts,
// client vs server, so there's no shared module between them).
function pluralizeDays(n) {
  const mod100 = Math.abs(n) % 100;
  const mod10 = mod100 % 10;
  if (mod100 >= 11 && mod100 <= 14) return 'днів';
  if (mod10 === 1) return 'день';
  if (mod10 >= 2 && mod10 <= 4) return 'дні';
  return 'днів';
}

// ---------------------------------------------------------------------------
// Gemini: fortune-cookie / cozy-note generation
// ---------------------------------------------------------------------------

const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const SUCCESS_SYSTEM_INSTRUCTION = `Ти — класичний, загадковий, трохи дотепний автор передбачень з печива-гадання (fortune cookie). Пиши українською мовою, максимум 1-2 короткі речення.

СУВОРІ ОБМЕЖЕННЯ:
- Жодної дешевої мотивації, жодної теми "фітнес-хардкору" чи культу дисципліни.
- НЕ згадуй їжу, калорії, дієту чи фізичні вправи — взагалі, навіть натяком.

Тон і зміст: задумливе, злегка філософське, інтригуюче або м'яко гумористичне спостереження про життя — не про здоров'я чи харчування.

Приклади стилю (це лише орієнтир, не копіюй їх — придумай нове, у такому ж дусі):
- "Іноді найважливіший крок за день — це просто дозволити речам іти своїм чередом."
- "Незабаром ви отримаєте новину з боку, звідки найменше її чекаєте."
- "Спокій — це не відсутність думок, а вміння не обирати кожну з них."
- "Завтра чудовий день, щоб нарешті закрити одну зі старих вкладок у голові."

Згенеруй ОДНЕ нове передбачення в такому ж дусі. У відповіді — лише сам текст передбачення, без лапок, без префіксів, без пояснень.`;

const OVER_SYSTEM_INSTRUCTION = `Ти пишеш коротку, затишну, філософську нотатку про відпочинок, баланс і людську природу. Пиши українською мовою, максимум 1-2 короткі речення.

СУВОРІ ОБМЕЖЕННЯ:
- Жодного почуття провини, жодного докору.
- НЕ згадуй їжу, калорії чи дієту — взагалі, навіть натяком.
- Без повчального чи повчально-мотиваційного тону.

Приклад стилю (це лише орієнтир, не копіюй дослівно — придумай нове, у такому ж дусі):
"Ідеальність нудна. Найкращі історії завжди відбуваються там, де щось пішло не за планом. Видихай і відпочивай."

Згенеруй ОДНУ нову нотатку в такому ж дусі. У відповіді — лише сам текст, без лапок, без префіксів, без пояснень.`;

const FALLBACK_SUCCESS_LINE = 'Іноді найкраща відповідь на складний день — просто дати йому закінчитися самому.';
const FALLBACK_OVER_LINE = 'Не кожен день мусить бути ідеальним. Видихай і відпочивай.';

async function callGemini(systemInstruction) {
  if (!GEMINI_API_KEY || GEMINI_API_KEY === 'your_gemini_api_key_here') {
    throw new Error('GEMINI_API_KEY is not set');
  }

  const res = await fetch(GEMINI_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': GEMINI_API_KEY,
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemInstruction }] },
      contents: [{ role: 'user', parts: [{ text: 'Згенеруй зараз.' }] }],
      generationConfig: { temperature: 1.0, maxOutputTokens: 120 },
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Gemini API error ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text || !text.trim()) throw new Error('Gemini returned no text');

  return text.trim().replace(/^["'«»]+|["'«»]+$/g, '').trim();
}

// Returns an emoji-prefixed line for the given day outcome, using Gemini
// when available and falling back to a static (still on-brand) line if the
// API key is missing or the call fails, so a Gemini outage never blocks the
// whole summary from sending.
async function getFortuneLine(isSuccessful) {
  const emoji = isSuccessful ? '🥠' : '✨';
  try {
    const text = await callGemini(isSuccessful ? SUCCESS_SYSTEM_INSTRUCTION : OVER_SYSTEM_INSTRUCTION);
    return `${emoji} ${text}`;
  } catch (err) {
    console.warn('[gemini] falling back to a static line:', err.message);
    return `${emoji} ${isSuccessful ? FALLBACK_SUCCESS_LINE : FALLBACK_OVER_LINE}`;
  }
}

// ---------------------------------------------------------------------------
// Summary message
// ---------------------------------------------------------------------------

const CATEGORY_STATUS_ICON = { over: '⚠️', complete: '✅', active: '🔸' };

function buildSummaryMessage({ total_calories, daily_calorie_target, streak, categories, fortuneLine }) {
  const pct = daily_calorie_target ? Math.round((total_calories / daily_calorie_target) * 100) : 0;

  const lines = [
    '📊 <b>Eatko: Підсумки дня!</b>',
    '',
    `🔥 <b>${Math.round(total_calories)} / ${Math.round(daily_calorie_target)} ккал</b>  (${pct}%)`,
    `🔥 <b>Серія: ${streak} ${pluralizeDays(streak)} поспіль</b>`,
    '',
  ];

  for (const c of categories) {
    const icon = CATEGORY_STATUS_ICON[c.status] || '🔸';
    lines.push(
      `${icon} ${escapeHtml(c.emoji || '')} <b>${escapeHtml(c.category_name || '')}</b> — ${Math.round(c.usage_percent ?? 0)}% (${Math.round(c.calories_consumed ?? 0)} ккал)`
    );
  }

  lines.push('', fortuneLine, '', 'Гарного відпочинку! 🌙');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json());

// --- API routes (registered before static file serving) ---

// Static, read-only reference data: the 8 categories, their items, and the
// calorie/macro goals. No user data flows through this one, so no auth.
app.get('/api/catalog', (req, res) => {
  res.json(CATALOG);
});

// Called by the client (public/app.js) after every log action, with the
// day's status it already computed locally. Upserts one row per (user,
// date) — this is the ONLY thing persisted server-side; the actual food
// logs stay in the client's CloudStorage as before. Requires real Telegram
// initData, both to know who's syncing and to stop an arbitrary caller from
// writing fake data under someone else's account.
app.post('/api/sync-status', async (req, res) => {
  const tgUser = validateInitData(req.header('X-Telegram-Init-Data'));
  if (!tgUser) {
    return res.status(401).json({ error: 'Invalid or missing Telegram auth data' });
  }

  const { date, total_calories, daily_calorie_target, streak, categories } = req.body || {};
  if (!date || total_calories == null || daily_calorie_target == null || !Array.isArray(categories)) {
    return res.status(400).json({ error: 'date, total_calories, daily_calorie_target and categories are required' });
  }

  if (!db.isDatabaseConfigured()) {
    return res.status(500).json({ error: 'Database is not configured (TURSO_DATABASE_URL/TURSO_AUTH_TOKEN missing)' });
  }

  try {
    const userId = await db.getOrCreateUser({
      telegram_id: tgUser.id,
      first_name: tgUser.first_name,
      username: tgUser.username,
    });
    await db.upsertDailyStatus(userId, date, { total_calories, daily_calorie_target, streak, categories });
    res.json({ synced: true });
  } catch (err) {
    console.error('[sync-status] failed:', err.message);
    res.status(502).json({ error: 'Failed to sync status' });
  }
});

// The evening broadcast: hit by an external pinger (e.g. cron-job.org) or a
// plain browser visit — no request body, no Telegram initData needed, since
// it isn't acting on behalf of any one user. Instead it looks up every user
// who has synced a status for TODAY (via POST /api/sync-status above) and
// sends each of them their own personalized, Gemini-generated summary. This
// also doubles as a way to wake a sleeping Render free-tier instance on a
// schedule, which internal cron can't do while the instance is asleep.
app.get('/api/trigger-evening-summary', async (req, res) => {
  if (!db.isDatabaseConfigured()) {
    return res.status(500).json({ error: 'Database is not configured (TURSO_DATABASE_URL/TURSO_AUTH_TOKEN missing)' });
  }

  const date = todayISO();

  let users;
  try {
    users = await db.getAllStatusForDate(date);
  } catch (err) {
    console.error('[trigger-evening-summary] failed to load statuses:', err.message);
    return res.status(502).json({ error: 'Failed to load user statuses' });
  }

  let sentCount = 0;
  for (const u of users) {
    try {
      const isSuccessful = u.total_calories <= u.daily_calorie_target;
      const fortuneLine = await getFortuneLine(isSuccessful); // unique per user, based on THEIR actual day
      const message = buildSummaryMessage({
        total_calories: u.total_calories,
        daily_calorie_target: u.daily_calorie_target,
        streak: u.streak,
        categories: u.categories,
        fortuneLine,
      });
      await bot.api.sendMessage(u.telegram_id, message, { parse_mode: 'HTML' });
      sentCount++;
    } catch (err) {
      // One user's message failing (e.g. they blocked the bot) shouldn't
      // stop everyone else from getting theirs.
      console.error(`[trigger-evening-summary] failed for user ${u.telegram_id}:`, err.message);
    }
  }

  res.json({ success: true, count: sentCount, message: `Summaries sent to ${sentCount} users` });
});

// --- Static file serving (after API routes) ---
app.use(express.static(path.join(__dirname, 'public')));

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

db.ensureSchema()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`✅ Server listening on http://localhost:${PORT}`);
    });

    bot.start();
    console.log('✅ Telegram bot is polling for updates');
  })
  .catch((err) => {
    console.error('[!] Failed to set up the database schema:', err.message);
    process.exit(1);
  });
