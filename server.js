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
const cron = require('node-cron');
const { Bot, InlineKeyboard } = require('grammy');

const db = require('./database');
const { CATALOG } = db;

const BOT_TOKEN = process.env.BOT_TOKEN;
const PORT = process.env.PORT || 3000;
const WEBAPP_URL = process.env.WEBAPP_URL;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
// Default model: gemini-2.5-flash used to work here but started 404ing with
// "This model ... is no longer available to new users" — Google restricts
// some older models to accounts/projects that had access before a cutoff,
// separately from full deprecation. gemini-3.5-flash is the current GA
// model and isn't subject to that restriction. If you have an older
// project that DOES still have gemini-2.5-flash access, you can override
// this via the GEMINI_MODEL env var — no code change needed either way.
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
// Comma-separated numeric Telegram user IDs allowed to run /invite. Strictly
// validated: Telegram user IDs are always numeric, so anything else in this
// list is almost certainly a typo — dropped, with a warning, rather than
// silently kept around as a value that could never match anyway.
const ADMIN_TELEGRAM_IDS = new Set(
  (process.env.ADMIN_TELEGRAM_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => {
      if (!s) return false;
      if (!/^\d+$/.test(s)) {
        console.warn(`[!] ADMIN_TELEGRAM_IDS has a non-numeric entry, ignoring it: "${s}" (Telegram user IDs are always numeric).`);
        return false;
      }
      return true;
    })
);

if (ADMIN_TELEGRAM_IDS.size === 0) {
  console.warn(
    '\n[!] ADMIN_TELEGRAM_IDS is empty or unset — nobody will be able to run /invite. ' +
    'Set it to your own numeric Telegram user ID (get it from @userinfobot) in .env / Render\u2019s environment variables.\n'
  );
}

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

// Monday (Europe/Kyiv) of the week containing the given YYYY-MM-DD date —
// the canonical week_start used for weekly_weight rows. Used both to
// resolve "today's" week when saving/reading weight, and to derive
// current/previous from whatever weeks actually have an entry.
function mondayOfWeek(dateISO) {
  const [y, m, d] = dateISO.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const jsDay = dt.getUTCDay(); // 0=Sun..6=Sat
  const deltaToMonday = jsDay === 0 ? -6 : 1 - jsDay;
  dt.setUTCDate(dt.getUTCDate() + deltaToMonday);
  return dt.toISOString().slice(0, 10);
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
//
// IMPORTANT: this is deliberately the ONLY source of truth for who's
// making a request. `initDataUnsafe.user.id` (as the name says) is NOT
// signed — any client can set it to any value with a plain fetch() call,
// no real Telegram session needed. Falling back to it when signature
// verification fails would let anyone impersonate any telegram_id and get
// authorized under someone else's identity. So this never does that — a
// failed check always means "not authorized", never "trust the claim
// instead". What it DOES do differently now is log exactly which step
// failed, so a real misconfiguration (e.g. BOT_TOKEN not matching) is
// actually diagnosable instead of a silent, unexplained 401 every time.

function validateInitData(initData) {
  if (!initData) {
    console.warn('[auth] Rejected: no X-Telegram-Init-Data received at all.');
    return null;
  }

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) {
    console.warn('[auth] Rejected: initData present but has no "hash" param.');
    return null;
  }

  params.delete('hash');
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  // .trim() guards against the classic gotcha of a stray trailing
  // space/newline in the .env value (or Render's env var UI) silently
  // producing a different HMAC secret than the real bot token.
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN.trim()).digest();
  const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  if (computedHash !== hash) {
    console.warn(
      '[auth] Rejected: initData signature does not match. This almost always means BOT_TOKEN ' +
      'in this environment does not exactly match the token this initData was actually signed ' +
      'with — double check .env locally AND the BOT_TOKEN env var in Render\'s dashboard are both ' +
      'the current token from @BotFather, with no extra whitespace.'
    );
    return null;
  }

  const userJson = params.get('user');
  if (!userJson) {
    console.warn('[auth] Rejected: initData signature is valid, but it has no "user" param.');
    return null;
  }

  let user;
  try {
    user = JSON.parse(userJson); // { id, first_name, ... }
  } catch (err) {
    console.warn('[auth] Rejected: "user" param in initData is not valid JSON:', err.message);
    return null;
  }

  if (user == null || user.id == null) {
    console.warn('[auth] Rejected: parsed user object has no id:', userJson);
    return null;
  }

  return user;
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

// Varied fallback pools (used when Gemini is unavailable, AND as a backstop
// when Gemini keeps producing something we've already sent recently — see
// getFortuneLine below). Each respects the same constraints as the Gemini
// prompts: no food/calories/diet/exercise, no hustle-culture motivation.
//
// Object.freeze() + the length assertions below are a deliberate integrity
// guard: these arrays must stay exactly as authored — the selection logic
// silently degrades to a smaller effective pool if either one is ever
// accidentally truncated or reassigned somewhere, which would be very easy
// to miss just by reading behavior alone.
const FALLBACK_SUCCESS_LINES = Object.freeze([
  'Іноді найважливіший крок за день — це просто дозволити речам іти своїм чередом.',
  'Незабаром ви отримаєте новину з боку, звідки найменше її чекаєте.',
  'Спокій — це не відсутність думок, а вміння не обирати кожну з них.',
  'Завтра чудовий день, щоб нарешті закрити одну зі старих вкладок у голові.',
  'Хтось згадає про вас сьогодні ввечері — і посміхнеться.',
  'Найкращі рішення часто приходять саме тоді, коли ви перестаєте їх шукати.',
  'Той дзвінок, який ви відкладаєте, насправді чекає на вас, а не навпаки.',
  'Іноді загублена річ сама знаходить дорогу назад — просто не зараз.',
  'Ваша інтуїція вже знає відповідь; питання лише в тому, чи ви їй довіряєте.',
  'Одна маленька зміна звички здатна непомітно змінити цілий тиждень.',
]);
const FALLBACK_OVER_LINES = Object.freeze([
  'Ідеальність нудна. Найкращі історії завжди відбуваються там, де щось пішло не за планом. Видихай і відпочивай.',
  'Не кожен день мусить бути ідеальним. Видихай і відпочивай.',
  'Навіть найрівніша дорога іноді петляє — і це нормально.',
  'Дозволь собі сьогодні просто побути, без жодних підсумків і висновків.',
  'Рівновага — це не пряма лінія, а танець, у якому іноді збиваєшся з ритму.',
  'Завтра почнеться саме собою, як завжди. Сьогодні можна просто видихнути.',
  'Найтепліші спогади рідко народжуються з ідеальних днів.',
  'Іноді найкращий план на вечір — це взагалі відсутність плану.',
]);

const EXPECTED_FALLBACK_COUNTS = { success: 10, over: 8 };
if (
  FALLBACK_SUCCESS_LINES.length !== EXPECTED_FALLBACK_COUNTS.success ||
  FALLBACK_OVER_LINES.length !== EXPECTED_FALLBACK_COUNTS.over
) {
  console.error(
    `[!] Fallback prediction pool size mismatch — expected ${EXPECTED_FALLBACK_COUNTS.success} success / ` +
    `${EXPECTED_FALLBACK_COUNTS.over} over, got ${FALLBACK_SUCCESS_LINES.length} / ${FALLBACK_OVER_LINES.length}. ` +
    'One of the arrays was edited without updating EXPECTED_FALLBACK_COUNTS to match — not fatal, but check it.'
  );
}

// How far back (14-30 days, per spec) a prediction counts as "recently
// sent" to a given user before it's eligible to be picked again.
const PREDICTION_LOOKBACK_DAYS = 21;

// Picks a random (Math.random(), true randomness — not a deterministic
// index) fallback line the given user hasn't received in the lookback
// window. If literally every line in the pool has been sent to them
// recently, the pool is "exhausted": per spec, that resets their history
// for this kind (handled by the caller) and this just picks fresh at
// random from the full pool rather than refusing to answer.
function pickFreshFallback(kind, recentTexts) {
  const pool = kind === 'success' ? FALLBACK_SUCCESS_LINES : FALLBACK_OVER_LINES;
  const unused = pool.filter((line) => !recentTexts.includes(line));
  if (unused.length) {
    return { text: unused[Math.floor(Math.random() * unused.length)], exhausted: false };
  }
  return { text: pool[Math.floor(Math.random() * pool.length)], exhausted: true };
}

async function callGemini(systemInstruction, userText) {
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
      contents: [{ role: 'user', parts: [{ text: userText }] }],
      // Gemini 3.x models "think" before answering by default, and those
      // invisible reasoning tokens are deducted from maxOutputTokens.
      // LOW still wasn't low enough — MINIMAL is the lowest tier the API
      // supports for Flash models (thinking can't be fully turned off on
      // 3.x the way it could pre-3.x, only minimized). NOTE: the legacy
      // `thinkingBudget` field is NOT combined with `thinkingLevel` here —
      // Gemini's API rejects requests that send both together, and
      // thinkingLevel is the current field for 3.x, so that's the one
      // actually driving this. maxOutputTokens raised to 1000 as extra
      // headroom on top of that.
      generationConfig: {
        temperature: 1.1,
        maxOutputTokens: 1000,
        thinkingConfig: { thinkingLevel: 'MINIMAL' },
      },
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Gemini API error ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  const candidate = data?.candidates?.[0];
  const text = candidate?.content?.parts?.[0]?.text;
  if (!text || !text.trim()) throw new Error('Gemini returned no text');

  // Belt-and-suspenders against the exact bug just reported: if the API
  // itself says the response got cut off (finishReason MAX_TOKENS — thinking
  // or otherwise eating the budget before the sentence finished), treat
  // that as a failed attempt rather than silently shipping a truncated
  // sentence like "...декорації ва". This is not text WE are truncating
  // (see the .slice() calls above — neither touches this text at all,
  // only a date string and a capped error-log excerpt) — it's Gemini's own
  // signal that ITS output was cut short. Throwing here means the existing
  // retry loop (MAX_GENERATION_ATTEMPTS, see getFortuneLine below) gets
  // another attempt instead of accepting the partial text.
  if (candidate?.finishReason === 'MAX_TOKENS') {
    const truncationErr = new Error(`Gemini response was truncated (finishReason=MAX_TOKENS, ${text.length} chars received): "${text}"`);
    // Whether a given generation gets cut off is stochastic (depends on how
    // much that specific call happened to "think"), unlike a genuine API
    // failure (bad auth, network, 404) — so this is worth retrying with a
    // fresh salt rather than giving up immediately. See the catch block in
    // getFortuneLine below, which checks this flag.
    truncationErr.retryable = true;
    throw truncationErr;
  }

  return text.trim().replace(/^["'«»]+|["'«»]+$/g, '').trim();
}

// Returns an emoji-prefixed line for the given day outcome, personalized
// per user via their own persistent prediction history (sent_predictions in
// Turso) — not a single global "recently sent" list shared across everyone,
// which would let one user's Gemini result block a completely different
// user from getting that same (to THEM, novel) line. Every call injects
// today's date plus a fresh random salt into the Gemini prompt (so the
// model isn't repeatedly asked the exact same question), and if the result
// matches something this specific user received within PREDICTION_LOOKBACK_DAYS,
// it retries with a new salt before falling back to the static pool. This
// makes exact repeats highly unlikely, though — being honest — nothing
// short of an endlessly growing blocklist could make it a true mathematical
// guarantee against an LLM; this is a strong best-effort, not a formal proof.
const MAX_GENERATION_ATTEMPTS = 3;

async function getFortuneLine(isSuccessful, userId) {
  const kind = isSuccessful ? 'success' : 'over';
  const emoji = isSuccessful ? '🥠' : '✨';
  const systemInstruction = isSuccessful ? SUCCESS_SYSTEM_INSTRUCTION : OVER_SYSTEM_INSTRUCTION;
  const date = todayISO();

  let recentTexts = [];
  try {
    recentTexts = await db.getRecentPredictions(userId, kind, PREDICTION_LOOKBACK_DAYS);
  } catch (err) {
    console.warn('[predictions] failed to load recent history, proceeding without dedup:', err.message);
  }

  for (let attempt = 1; attempt <= MAX_GENERATION_ATTEMPTS; attempt++) {
    try {
      const salt = crypto.randomUUID();
      const userText =
        `Дата: ${date}. Унікальний код цього запиту: ${salt} (спроба ${attempt} з ${MAX_GENERATION_ATTEMPTS}). ` +
        'Згенеруй ОДНЕ нове передбачення саме для цього моменту — воно має відрізнятися від будь-яких попередніх відповідей.';

      const text = await callGemini(systemInstruction, userText);

      if (!recentTexts.includes(text)) {
        await recordPredictionSafely(userId, kind, text);
        console.log(`[predictions] user ${userId} kind=${kind} source=gemini attempt=${attempt} text="${text}"`);
        return `${emoji} ${text}`;
      }
      // Exact repeat of something this user already received recently —
      // try again with a new salt.
    } catch (err) {
      if (err.retryable) {
        console.warn(`[gemini] attempt ${attempt} truncated, retrying:`, err.message);
        continue; // stochastic — a fresh attempt has a real chance of not truncating
      }
      console.warn(`[gemini] attempt ${attempt} failed, falling back:`, err.message);
      break; // a hard API failure won't fix itself by retrying immediately
    }
  }

  const { text: fallback, exhausted } = pickFreshFallback(kind, recentTexts);
  if (exhausted) {
    try {
      await db.resetUserPredictionHistory(userId, kind);
    } catch (err) {
      console.warn('[predictions] failed to reset exhausted history (non-fatal):', err.message);
    }
  }
  await recordPredictionSafely(userId, kind, fallback);
  console.log(`[predictions] user ${userId} kind=${kind} source=fallback exhausted=${exhausted} recentCount=${recentTexts.length} text="${fallback}"`);
  return `${emoji} ${fallback}`;
}

async function recordPredictionSafely(userId, kind, text) {
  try {
    await db.recordSentPrediction(userId, kind, text);
  } catch (err) {
    console.warn('[predictions] failed to record sent prediction (non-fatal):', err.message);
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
    const label = `${icon} ${escapeHtml(c.emoji || '')} <b>${escapeHtml(c.category_name || '')}</b>`;
    // Categories with no target_calories (e.g. "Погане їдло" — a direct
    // kcal entry, uncapped by design) have no meaningful usage percent, so
    // just show the kcal figure instead of a "X% (Y ккал)" pair.
    lines.push(
      c.target_calories
        ? `${label} — ${Math.round(c.usage_percent ?? 0)}% (${Math.round(c.calories_consumed ?? 0)} ккал)`
        : `${label} — ${Math.round(c.calories_consumed ?? 0)} ккал`
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

// Static, read-only reference data: the categories, their items, and the
// calorie/macro goals. No user data flows through this one, so no auth.
app.get('/api/catalog', (req, res) => {
  res.json(CATALOG);
});

// Checked by the client on every app open (after trusting a cached "I'm
// authorized" flag optimistically) to confirm access hasn't been revoked.
// Also usable as the very first check for a brand-new device with no cache.
app.get('/api/check-auth', async (req, res) => {
  const tgUser = validateInitData(req.header('X-Telegram-Init-Data'));
  if (!tgUser) {
    // req.query.telegram_id is whatever the client CLAIMS its id is —
    // unverified, logged purely to help correlate "is this the same real
    // user failing repeatedly" vs random/bot traffic. Never used to decide
    // authorization; see the big comment on validateInitData for why.
    console.warn('[check-auth] Rejected. Client-claimed (unverified) telegram_id:', req.query.telegram_id || '(none sent)');
    return res.status(401).json({ error: 'Invalid or missing Telegram auth data' });
  }

  if (!db.isDatabaseConfigured()) {
    return res.status(500).json({ error: 'Database is not configured (TURSO_DATABASE_URL/TURSO_AUTH_TOKEN missing)' });
  }

  try {
    const authorized = await db.isUserAllowed({
      telegram_id: tgUser.id,
      first_name: tgUser.first_name,
      username: tgUser.username,
    });
    res.json({ authorized });
  } catch (err) {
    console.error('[check-auth] failed:', err.message);
    res.status(502).json({ error: 'Failed to check authorization' });
  }
});

// The lock-screen submit action: validates an invite code and, on success,
// adds the requesting (real, initData-verified) Telegram user to the
// allowlist permanently.
app.post('/api/verify-invite', async (req, res) => {
  const tgUser = validateInitData(req.header('X-Telegram-Init-Data'));
  if (!tgUser) {
    console.warn('[verify-invite] Rejected. Client-claimed (unverified) telegram_id:', req.body?.telegram_id || '(none sent)');
    return res.status(401).json({ error: 'Invalid or missing Telegram auth data' });
  }

  if (!db.isDatabaseConfigured()) {
    return res.status(500).json({ error: 'Database is not configured (TURSO_DATABASE_URL/TURSO_AUTH_TOKEN missing)' });
  }

  const { code } = req.body || {};

  try {
    const result = await db.verifyAndConsumeInviteCode(code, {
      telegram_id: tgUser.id,
      first_name: tgUser.first_name,
      username: tgUser.username,
    });

    if (!result.ok) {
      return res.status(400).json({ authorized: false, error: result.reason });
    }
    res.json({ authorized: true });
  } catch (err) {
    console.error('[verify-invite] failed:', err.message);
    res.status(502).json({ authorized: false, error: 'Не вдалося перевірити код. Спробуйте ще раз.' });
  }
});

// Called by the client (public/app.js) after every log action, with the
// day's status it already computed locally. Upserts one row per (user,
// date) — this is the ONLY thing persisted server-side; the actual food
// logs stay in the client's CloudStorage as before. Requires real Telegram
// initData, both to know who's syncing and to stop an arbitrary caller from
// writing fake data under someone else's account — and now also requires
// the user to actually be on the invite allowlist, so the lock screen is
// enforced server-side too, not just cosmetically in the UI.
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
    const allowed = await db.isUserAllowed({
      telegram_id: tgUser.id,
      first_name: tgUser.first_name,
      username: tgUser.username,
    });
    if (!allowed) {
      return res.status(403).json({ error: 'Not authorized — an invite code is required' });
    }
  } catch (err) {
    console.error('[sync-status] authorization check failed:', err.message);
    return res.status(502).json({ error: 'Failed to check authorization' });
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

// ---------------------------------------------------------------------------
// Weekly weight tracking
// ---------------------------------------------------------------------------

// Picks "current" (this week's entry, if any) and "previous" (the most
// recent entry strictly before this week — not necessarily last week, in
// case the user skipped one) out of a newest-first list of entries.
function resolveCurrentAndPrevious(recentWeights, currentWeekStart) {
  const current = recentWeights.find((w) => w.week_start === currentWeekStart) || null;
  const previous = recentWeights.find((w) => w.week_start < currentWeekStart) || null;
  return { current_week: current, previous_week: previous };
}

// Shared auth + allowlist check for both weight endpoints below — identical
// to the check inline in /api/sync-status, factored out since two endpoints
// need it here.
async function authenticateAllowedUser(req, res) {
  const tgUser = validateInitData(req.header('X-Telegram-Init-Data'));
  if (!tgUser) {
    res.status(401).json({ error: 'Invalid or missing Telegram auth data' });
    return null;
  }
  if (!db.isDatabaseConfigured()) {
    res.status(500).json({ error: 'Database is not configured (TURSO_DATABASE_URL/TURSO_AUTH_TOKEN missing)' });
    return null;
  }
  try {
    const allowed = await db.isUserAllowed({
      telegram_id: tgUser.id,
      first_name: tgUser.first_name,
      username: tgUser.username,
    });
    if (!allowed) {
      res.status(403).json({ error: 'Not authorized — an invite code is required' });
      return null;
    }
  } catch (err) {
    console.error('[weight] authorization check failed:', err.message);
    res.status(502).json({ error: 'Failed to check authorization' });
    return null;
  }
  return tgUser;
}

// Returns this user's current-week and previous (most recent prior) weight
// entries, so the main-screen widget and the "Вага" sheet both have
// everything they need in one call.
app.get('/api/weight', async (req, res) => {
  const tgUser = await authenticateAllowedUser(req, res);
  if (!tgUser) return;

  try {
    const userId = await db.getOrCreateUser({
      telegram_id: tgUser.id,
      first_name: tgUser.first_name,
      username: tgUser.username,
    });
    const recent = await db.getRecentWeeklyWeights(userId);
    res.json(resolveCurrentAndPrevious(recent, mondayOfWeek(todayISO())));
  } catch (err) {
    console.error('[weight:get] failed:', err.message);
    res.status(502).json({ error: 'Failed to load weight' });
  }
});

// Saves this week's weight (upsert — re-entering just overwrites the same
// week_start row). week_start is always computed here, server-side, from
// today's real date — never taken from the request body, so a client can't
// write into an arbitrary past/future week.
app.post('/api/weight', async (req, res) => {
  const tgUser = await authenticateAllowedUser(req, res);
  if (!tgUser) return;

  const weightKg = Number(req.body?.weight_kg);
  if (!Number.isFinite(weightKg) || weightKg < 20 || weightKg > 400) {
    return res.status(400).json({ error: 'weight_kg must be a realistic number between 20 and 400' });
  }

  try {
    const userId = await db.getOrCreateUser({
      telegram_id: tgUser.id,
      first_name: tgUser.first_name,
      username: tgUser.username,
    });
    const weekStart = mondayOfWeek(todayISO());
    await db.upsertWeeklyWeight(userId, weekStart, weightKg);

    const recent = await db.getRecentWeeklyWeights(userId);
    res.json(resolveCurrentAndPrevious(recent, weekStart));
  } catch (err) {
    console.error('[weight:post] failed:', err.message);
    res.status(502).json({ error: 'Не вдалося зберегти вагу. Спробуйте ще раз.' });
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
  // Never let a config/DB problem surface as a 502 to the external pinger —
  // cron-job.org (and Render) will just see "the endpoint is broken" either
  // way, but a clean 200 with success:false is diagnosable from the
  // response body, where a 502 gives no information at all. This mirrors
  // /api/trigger-weight-reminder below, which already returns 200 no
  // matter what.
  if (!db.isDatabaseConfigured()) {
    console.warn('[trigger-evening-summary] Skipped — database not configured.');
    return res.json({ success: false, count: 0, error: 'Database is not configured (TURSO_DATABASE_URL/TURSO_AUTH_TOKEN missing)' });
  }

  const date = todayISO();

  // Fallback to an empty list rather than failing the whole request: a
  // transient/misconfigured statuses lookup (e.g. the 404 seen in Render's
  // logs) should mean "nobody got a summary this run", not "the endpoint is
  // down". NOTE: the "HTTP error! status: 404" that shows up here is thrown
  // inside db.getAllStatusForDate() itself (in database.js, not this file)
  // — that function is fetching a URL/route that no longer exists. This
  // try/catch stops it from taking the endpoint down, but the fetch call
  // inside getAllStatusForDate still needs its URL corrected at the source
  // to actually send anyone their summary again.
  let users = [];
  try {
    users = await db.getAllStatusForDate(date);
  } catch (err) {
    // database.js's runTursoQuery() already logs the detailed Turso-side
    // error (name/code/status/cause) right before this rethrows — this
    // line just confirms, at the endpoint level, that the request fell
    // back to an empty list rather than failing silently.
    console.error('[trigger-evening-summary] failed to load statuses, continuing with an empty list:', err.message);
    users = [];
  }

  let sentCount = 0;
  for (const u of users) {
    try {
      const isSuccessful = u.total_calories <= u.daily_calorie_target;
      const fortuneLine = await getFortuneLine(isSuccessful, u.user_id); // genuinely unique per user now — see getFortuneLine
      console.log(`[trigger-evening-summary] user ${u.telegram_id} (kind=${isSuccessful ? 'success' : 'over'}) got prediction: "${fortuneLine}"`);
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

  // Always a 200 with a valid JSON body — success reflects whether we
  // actually had statuses to work with, not just "the HTTP call didn't
  // throw", so callers can tell "ran, nobody due" apart from "ran, silently
  // found nobody because the DB lookup failed".
  res.json({
    success: users.length > 0 || sentCount > 0,
    count: sentCount,
    usersFound: users.length,
    message: users.length > 0
      ? `Summaries sent to ${sentCount} of ${users.length} users`
      : 'No user statuses could be loaded for today — sent to 0 users',
  });
});

// ---------------------------------------------------------------------------
// Monday weight reminder
// ---------------------------------------------------------------------------

const WEIGHT_REMINDER_TEXT = '⚖️ Новий тиждень! Зайдіть у додаток та зафіксуйте вашу поточну вагу.';

// Sends the Monday weight-reminder to every allowed user (the whole
// allowlist, not just people who've already logged a weight before — the
// point is to reach people who haven't). Shared by both the internal
// node-cron schedule below and the /api/trigger-weight-reminder fallback,
// same "one failure shouldn't block the rest" pattern as the evening
// broadcast above.
async function sendWeightReminders() {
  if (!db.isDatabaseConfigured()) {
    console.warn('[weight-reminder] Skipped — database not configured.');
    return 0;
  }

  let telegramIds;
  try {
    telegramIds = await db.getAllAllowedTelegramIds();
  } catch (err) {
    console.error('[weight-reminder] failed to load allowed users:', err.message);
    return 0;
  }

  const keyboard = WEBAPP_URL && !WEBAPP_URL.includes('your-public-url-here')
    ? new InlineKeyboard().webApp('⚖️ Відкрити застосунок', WEBAPP_URL)
    : undefined;

  let sentCount = 0;
  for (const telegramId of telegramIds) {
    try {
      await bot.api.sendMessage(telegramId, WEIGHT_REMINDER_TEXT, keyboard ? { reply_markup: keyboard } : undefined);
      sentCount++;
    } catch (err) {
      // One user blocking the bot (or similar) shouldn't stop the rest.
      console.error(`[weight-reminder] failed for user ${telegramId}:`, err.message);
    }
  }

  console.log(`[weight-reminder] Sent to ${sentCount}/${telegramIds.length} users`);
  return sentCount;
}

// Manual/external-pinger fallback for the reminder, mirroring
// /api/trigger-evening-summary above — same reasoning: Render's free tier
// puts the instance to sleep, and internal cron (below) simply doesn't fire
// while the process isn't running, so an external scheduler (e.g.
// cron-job.org) hitting this URL every Monday 09:00 Europe/Kyiv is the
// reliable way to guarantee delivery even if the node-cron schedule was
// asleep at 09:00. Safe to call more than once in the same week — it's
// just a broadcast, not tied to any "already sent today" state.
app.get('/api/trigger-weight-reminder', async (req, res) => {
  const count = await sendWeightReminders();
  res.json({ success: true, count, message: `Weight reminder sent to ${count} users` });
});

// --- Static file serving (after API routes) ---
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Telegram bot
// ---------------------------------------------------------------------------

const bot = new Bot(BOT_TOKEN);

bot.command('start', async (ctx) => {
  // Deep link: t.me/YourBot?start=invite behaves exactly like /invite.
  if (ctx.match === 'invite') {
    return handleInviteRequest(ctx);
  }

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

// Generates a new one-time invite code. Admin-only — ADMIN_TELEGRAM_IDS is
// the sole source of truth here. Deliberately NOT extended to general
// allowed_users/invite_codes-verified users: code generation stays under
// the bot owner's control rather than becoming a viral/referral mechanism.
// Handles both "/invite" and the "/start invite" deep link.
async function handleInviteRequest(ctx) {
  const callerId = String(ctx.from?.id || '');

  try {
    if (!ADMIN_TELEGRAM_IDS.has(callerId)) {
      return ctx.reply('❌ Створення інвайт-кодів доступне лише адміністратору бота.');
    }

    if (!db.isDatabaseConfigured()) {
      return ctx.reply('⚠️ Базу даних не налаштовано (TURSO_DATABASE_URL/TURSO_AUTH_TOKEN).');
    }

    const code = await db.generateInviteCode();
    await ctx.reply(
      `🎟 <b>Новий інвайт-код створено:</b> <code>${code}</code>\n\nНадішліть його користувачеві для входу.`,
      { parse_mode: 'HTML' }
    );
  } catch (err) {
    console.error('[invite] failed:', err.message);
    await ctx.reply('⚠️ Сталася помилка під час генерації коду. Спробуйте ще раз пізніше.');
  }
}

bot.command('invite', handleInviteRequest);

bot.catch((err) => {
  console.error('Bot error:', err);
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

// Fixes "409 Conflict: terminated by other getUpdates request" during
// Render zero-downtime redeploys: for a brief window, the old container and
// the new one can both be polling at once. Telegram only allows one
// long-poll connection per bot token, so the second one to connect gets
// rejected with a 409. Clearing any pending getUpdates session (and
// dropping whatever updates piled up while nothing was listening) before
// starting a fresh poll avoids fighting over that single connection slot.
async function stopBot() {
  try {
    await bot.stop();
    console.log('Telegram bot stopped gracefully');
  } catch (err) {
    console.error('Error stopping bot:', err);
  }
}
process.once('SIGINT', () => stopBot());
process.once('SIGTERM', () => stopBot());

db.ensureSchema()
  .then(async () => {
    app.listen(PORT, () => {
      console.log(`✅ Server listening on http://localhost:${PORT}`);
    });

    await bot.api.deleteWebhook({ drop_pending_updates: true });
    bot.start();
    console.log('✅ Telegram bot is polling for updates');

    // Every Monday at 09:00, Europe/Kyiv. NOTE: like the evening broadcast
    // above, this only fires if the process is actually awake at that
    // moment — Render's free tier sleeps an idle instance, and sleeping
    // instances don't run scheduled code, internal cron included. This is
    // still wired up exactly as requested (in-process node-cron); for a
    // guaranteed delivery even through a cold instance, also point an
    // external scheduler (e.g. cron-job.org) at GET /api/trigger-weight-reminder
    // for the same time — it does the identical send, just triggered
    // externally instead of by this in-process timer.
    cron.schedule('0 9 * * 1', () => {
      console.log('[weight-reminder] Monday 09:00 Kyiv — running scheduled reminder.');
      sendWeightReminders().catch((err) => {
        console.error('[weight-reminder] scheduled run failed:', err.message);
      });
    }, { timezone: DIET_TIMEZONE });
    console.log('✅ Monday weight-reminder cron scheduled (09:00 Europe/Kyiv)');
  })
  .catch((err) => {
    console.error('[!] Failed to set up the database schema:', err.message);
    process.exit(1);
  });
