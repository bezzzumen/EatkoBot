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

const { CATALOG } = require('./database');

const BOT_TOKEN = process.env.BOT_TOKEN;
const PORT = process.env.PORT || 3000;
const WEBAPP_URL = process.env.WEBAPP_URL;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

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
app.use(express.static(path.join(__dirname, 'public')));

// Static, read-only reference data: the 8 categories, their items, and the
// calorie/macro goals. No user data flows through this one, so no auth.
app.get('/api/catalog', (req, res) => {
  res.json(CATALOG);
});

// Triggered by the client with today's already-computed status. Generates
// the fortune-cookie / cozy-note line via Gemini, assembles the full
// Telegram message, and sends it to the requesting user.
app.post('/api/trigger-evening-summary', async (req, res) => {
  const tgUser = validateInitData(req.header('X-Telegram-Init-Data'));
  if (!tgUser) {
    return res.status(401).json({ error: 'Invalid or missing Telegram auth data' });
  }

  const { total_calories, daily_calorie_target, streak, categories } = req.body || {};
  if (total_calories == null || daily_calorie_target == null || !Array.isArray(categories)) {
    return res.status(400).json({ error: 'total_calories, daily_calorie_target and categories are required' });
  }

  const isSuccessful = total_calories <= daily_calorie_target;

  try {
    const fortuneLine = await getFortuneLine(isSuccessful);
    const message = buildSummaryMessage({
      total_calories,
      daily_calorie_target,
      streak: streak || 0,
      categories,
      fortuneLine,
    });

    await bot.api.sendMessage(tgUser.id, message, { parse_mode: 'HTML' });
    res.json({ sent: true });
  } catch (err) {
    console.error('[trigger-evening-summary] failed:', err.message);
    res.status(502).json({ error: 'Failed to send the evening summary' });
  }
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
