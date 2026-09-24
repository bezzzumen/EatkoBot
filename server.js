// server.js
// Express server: serves the WebApp frontend, exposes the static product
// catalog, runs the Telegram bot, and triggers AI-written evening-summary
// and Monday weight-reminder broadcasts (see /api/trigger-evening-summary
// and /api/trigger-weight-reminder below).
//
// There is no per-user server-side state for daily logs — those live in the
// browser via Telegram CloudStorage (localStorage as a fallback), computed
// client-side from the catalog this server hands out once on load. See
// public/app.js for that logic, and database.js for why the catalog itself
// doesn't need a database.
//
// The evening-summary flow: the CLIENT (which already has the day's
// computed status) calls POST /api/sync-status after every log action; the
// server never reads CloudStorage itself, it just stores that status and,
// once a day, turns it into an AI-written message sent via the bot.

require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cron = require('node-cron');
const { Bot, InlineKeyboard, GrammyError } = require('grammy');

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
// AI Fridge: recipe generation from whatever ingredients the user has
// ---------------------------------------------------------------------------
// Reuses GEMINI_ENDPOINT / GEMINI_MODEL / GEMINI_API_KEY from the top of this
// file — NOT a hardcoded "gemini-1.5-flash" call. Per the comment on
// GEMINI_MODEL above, 1.5/2.5 Flash 404 for projects that didn't have access
// before Google's cutoff, so hardcoding 1.5 here would silently break this
// feature on some deployments while the fortune-line feature kept working.
// If this project's key specifically needs 1.5 Flash, set
// GEMINI_MODEL=gemini-1.5-flash in .env — no code change required.

function buildAiFridgeSystemInstruction({ ingredients, mealType, remainingCalories, remainingProteins, remainingFats, remainingCarbs, maxCalories }) {
  // Two different constraints depending on whether maxCalories was sent:
  // a hard cap (e.g. "I only want a 400kcal snack right now", independent
  // of how much room is actually left in the day) vs the default of fitting
  // within whatever's left of today's targets. maxCalories, when present,
  // takes priority over remainingCalories even if remainingCalories is
  // larger — it does NOT lower an already-smaller remainingCalories either;
  // it's a ceiling on top of it, not a replacement macro target.
  const calorieInstruction = (maxCalories !== undefined && maxCalories !== null)
    ? `The recipe's total_calories MUST NOT exceed ${maxCalories} kcal — treat this as a hard ceiling, even though the user's remaining daily calories are ${remainingCalories} kcal (which may be higher).`
    : `The recipe should fit within the user's remaining daily calories: ${remainingCalories} kcal.`;

  return `You are a fitness nutritionist chef. The user has the following ingredients: ${ingredients}. Their remaining daily macro targets are: ${remainingProteins}g proteins, ${remainingFats}g fats, ${remainingCarbs}g carbs. ${calorieInstruction}${mealType ? ` This recipe is specifically for: ${mealType}.` : ''} Generate a simple, healthy recipe in Ukrainian.

Return STRICT raw JSON only, with exactly this shape (no markdown code fences, no commentary before or after):
{
  "title": string,
  "description": string,
  "ingredients_list": [{ "name": string, "amount": string }],
  "total_calories": number,
  "proteins": number,
  "fats": number,
  "carbs": number,
  "steps": [string]
}`;
}

// Separate from callGemini() above on purpose: that one is tuned for a
// 1-2 sentence fortune line (MINIMAL thinking, low token cap, and it trims
// quote characters off the result). A recipe is structurally different —
// it needs a much bigger output budget, JSON mode instead of free text, and
// the raw text handed back untouched so parseAiFridgeRecipe below can parse
// it as-is.
async function callGeminiForRecipe(systemInstruction) {
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
      contents: [{ role: 'user', parts: [{ text: 'Generate the recipe now, as raw JSON only.' }] }],
      generationConfig: {
        temperature: 0.9,
        // Recipes run longer than the fortune-line use case (title,
        // description, ingredient list, macro breakdown, steps) — 2000
        // leaves real headroom on top of MINIMAL thinking so a genuine
        // MAX_TOKENS truncation below means the recipe was actually long,
        // not that the budget was too tight.
        maxOutputTokens: 2000,
        thinkingConfig: { thinkingLevel: 'MINIMAL' },
        // Ask Gemini itself to constrain output to valid JSON. Belt-and-
        // suspenders: parseAiFridgeRecipe still defensively strips markdown
        // fences below, in case a given model/version doesn't fully honor
        // this for a particular request.
        responseMimeType: 'application/json',
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

  if (candidate?.finishReason === 'MAX_TOKENS') {
    throw new Error(`Gemini recipe response was truncated (finishReason=MAX_TOKENS, ${text.length} chars received)`);
  }

  return text.trim();
}

// Validates the shape of whatever Gemini handed back — deliberately strict
// (throws on missing fields or wrong array types) rather than passing
// something malformed through to the frontend, which is the caller's cue to
// fall back to a 502 instead of shipping a broken recipe card.
function parseAiFridgeRecipe(rawText) {
  const cleaned = rawText.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`Gemini did not return valid JSON: ${err.message}`);
  }

  const requiredFields = ['title', 'description', 'ingredients_list', 'total_calories', 'proteins', 'fats', 'carbs', 'steps'];
  const missing = requiredFields.filter((key) => parsed[key] === undefined || parsed[key] === null);
  if (missing.length) {
    throw new Error(`Gemini JSON is missing required field(s): ${missing.join(', ')}`);
  }
  if (!Array.isArray(parsed.ingredients_list) || !Array.isArray(parsed.steps)) {
    throw new Error('Gemini JSON has ingredients_list and/or steps that are not arrays');
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// Summary message
// ---------------------------------------------------------------------------

const CATEGORY_STATUS_ICON = { over: '⚠️', complete: '✅', active: '🔸' };

// The app's current, active categories — anything else found in a
// `categories` array (most notably the legacy "Погане їдло", whose budget
// and logging were merged into "Будь-чого" and which was fully removed
// from the app's category list) is stale data and must be filtered out
// before the summary is built. This also protects against old stored
// daily_status rows from before that migration, which may still contain
// a "Погане їдло" entry (typically with no target_calories and 0 ккал
// consumed), so it never shows up as a stray line again.
const ACTIVE_CATEGORY_NAMES = new Set([
  'Гарнір',
  'Молочні продукти',
  'Будь-чого',
  "М'ясо / Риба / Яйця",
  'Овочі та гриби',
  'Жири та соуси',
  'Фрукти та ягоди',
  'Горіхи та насіння',
]);

function buildSummaryMessage({ total_calories, daily_calorie_target, streak, categories, fortuneLine }) {
  const pct = daily_calorie_target ? Math.round((total_calories / daily_calorie_target) * 100) : 0;

  const lines = [
    '📊 <b>Eatko: Підсумки дня!</b>',
    '',
    `🔥 <b>${Math.round(total_calories)} / ${Math.round(daily_calorie_target)} ккал</b>  (${pct}%)`,
    `🔥 <b>Серія: ${streak} ${pluralizeDays(streak)} поспіль</b>`,
    '',
  ];

  // Drop anything that isn't a current active category (legacy "Погане
  // їдло" entries included) before rendering, rather than trying to
  // special-case it by name inside the loop below.
  const activeCategories = (categories || []).filter(
    (c) => c && ACTIVE_CATEGORY_NAMES.has(c.category_name)
  );

  for (const c of activeCategories) {
    const icon = CATEGORY_STATUS_ICON[c.status] || '🔸';
    const label = `${icon} ${escapeHtml(c.emoji || '')} <b>${escapeHtml(c.category_name || '')}</b>`;
    // Categories with no target_calories (a direct kcal entry, uncapped by
    // design) have no meaningful usage percent, so just show the kcal
    // figure instead of a "X% (Y ккал)" pair.
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

// Holds the http.Server returned by app.listen() once boot finishes below,
// so handleShutdown() can close it gracefully (stop accepting new
// connections, let in-flight requests finish) instead of only killing the
// bot and hard-exiting.
let httpServer = null;

// --- Keep-alive ping endpoints (registered first, before any other route
// including static file serving) ---
//
// External cron pingers (e.g. cron-job.org) hit the root URL `/` to keep
// Render's free-tier instance from sleeping. `/` is served by
// express.static below and returns the full index.html bundle, which some
// cron providers reject with "Failed (output too large)" once it exceeds
// their response size limit — and a rejected ping doesn't count as
// activity, so the instance goes to sleep anyway. These two routes give
// pingers a trivially small, fast response instead.
app.get('/ping', (req, res) => res.status(200).send('OK'));
app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));

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
    if (!authorized) {
      return res.json({ authorized: false });
    }

    // Authorized — also hand back this user's targets here, since this
    // endpoint is what the client already calls on every app open. Falls
    // back to the app-wide default (2220) inside getUserTargets for anyone
    // who hasn't set a custom one via POST /api/user/settings.
    //
    // target_protein/fat/carbs are returned as-is, nulls included: a null
    // tells the client "derive this macro by scaling the base catalog",
    // which is a different instruction from any concrete number.
    const userId = await db.getOrCreateUser({
      telegram_id: tgUser.id,
      first_name: tgUser.first_name,
      username: tgUser.username,
    });
    const targets = await db.getUserTargets(userId);
    res.json({
      authorized: true,
      daily_target: targets.daily_target,
      target_protein: targets.target_protein,
      target_fat: targets.target_fat,
      target_carbs: targets.target_carbs,
    });
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

// Generates a recipe from ingredients the user says they have on hand,
// tailored to fit whatever calories/macros they have left for the day.
// Uses authenticateAllowedUser (defined below, hoisted) — same auth +
// allowlist gate as sync-status/weight endpoints, since this is a
// user-initiated action that spends a real Gemini API call and should be
// gated the same way as everything else that costs something server-side.
app.post('/api/ai-fridge', async (req, res) => {
  const tgUser = await authenticateAllowedUser(req, res);
  if (!tgUser) return; // authenticateAllowedUser already sent the response

  const { ingredients, mealType, remainingCalories, remainingProteins, remainingFats, remainingCarbs, maxCalories } = req.body || {};

  if (!ingredients || typeof ingredients !== 'string' || !ingredients.trim()) {
    return res.status(400).json({ error: 'ingredients is required' });
  }
  if (mealType !== undefined && typeof mealType !== 'string') {
    return res.status(400).json({ error: 'mealType must be a string if provided' });
  }
  // Optional hard calorie ceiling — distinct from remainingCalories (see
  // buildAiFridgeSystemInstruction above). null is accepted as an explicit
  // "no cap", same as omitting the field entirely; only a non-number,
  // non-null value is rejected.
  if (maxCalories !== undefined && maxCalories !== null && (typeof maxCalories !== 'number' || Number.isNaN(maxCalories) || maxCalories <= 0)) {
    return res.status(400).json({ error: 'maxCalories must be a positive number if provided' });
  }

  const macros = { remainingCalories, remainingProteins, remainingFats, remainingCarbs };
  const invalidMacro = Object.entries(macros).find(([, v]) => typeof v !== 'number' || Number.isNaN(v));
  if (invalidMacro) {
    return res.status(400).json({ error: `${invalidMacro[0]} is required and must be a number` });
  }

  if (!GEMINI_API_KEY || GEMINI_API_KEY === 'your_gemini_api_key_here') {
    return res.status(503).json({ error: 'AI recipe generation is not configured (GEMINI_API_KEY missing)' });
  }

  try {
    const systemInstruction = buildAiFridgeSystemInstruction({
      ingredients: ingredients.trim(),
      mealType,
      remainingCalories,
      remainingProteins,
      remainingFats,
      remainingCarbs,
      maxCalories: maxCalories ?? null,
    });
    const rawText = await callGeminiForRecipe(systemInstruction);
    const recipe = parseAiFridgeRecipe(rawText);
    res.json(recipe);
  } catch (err) {
    console.error('[ai-fridge] failed:', err.message);
    res.status(502).json({ error: 'Не вдалося згенерувати рецепт. Спробуйте ще раз.' });
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

// ---------------------------------------------------------------------------
// Named food entries (Calculator "Назва страви" + "Історія за сьогодні")
// ---------------------------------------------------------------------------
// Unlike sync-status above (a once-a-day rollup the client already
// computed), these four endpoints are a genuine per-item CRUD surface —
// each Calculator submission that carries a food name becomes its own row
// in food_entries (see database.js), editable and deletable individually.
// Same auth + allowlist gate as the weight/settings endpoints
// (authenticateAllowedUser, defined above), since this both reads and
// writes real user data.

const MAX_FOOD_NAME_LEN = 80;
const MIN_ENTRY_CALORIES = 0;
const MAX_ENTRY_CALORIES = 20000;
const MAX_ENTRY_MACRO_GRAMS = 2000; // generous ceiling, same spirit as MACRO_LIMITS below — rejects fat-finger garbage, not diet choices

// Validates + normalizes a create/update body. Returns { ok: true, value }
// with value ready to hand straight to db.createFoodEntry/updateFoodEntry,
// or { ok: false, error }. calories is required; food_name and the three
// macros are all optional and independent of each other (unlike
// /api/user/settings' macro fields, there's no "all three or none" rule
// here — a Calculator entry can have calories with no macros at all).
function parseFoodEntryBody(body) {
  const rawName = typeof body?.food_name === 'string' ? body.food_name.trim() : '';
  const food_name = rawName ? rawName.slice(0, MAX_FOOD_NAME_LEN) : null;

  const calories = Number(body?.calories);
  if (!Number.isFinite(calories) || calories < MIN_ENTRY_CALORIES || calories > MAX_ENTRY_CALORIES) {
    return { ok: false, error: `calories must be a number between ${MIN_ENTRY_CALORIES} and ${MAX_ENTRY_CALORIES}` };
  }

  const parseOptionalMacro = (raw, label) => {
    if (raw === undefined || raw === null || raw === '') return { ok: true, value: null };
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0 || value > MAX_ENTRY_MACRO_GRAMS) {
      return { ok: false, error: `${label} must be a non-negative number of grams if provided` };
    }
    return { ok: true, value };
  };

  const protein = parseOptionalMacro(body?.protein, 'protein');
  if (!protein.ok) return protein;
  const fat = parseOptionalMacro(body?.fat, 'fat');
  if (!fat.ok) return fat;
  const carbs = parseOptionalMacro(body?.carbs, 'carbs');
  if (!carbs.ok) return carbs;

  return {
    ok: true,
    value: {
      food_name,
      calories: Math.round(calories),
      protein: protein.value,
      fat: fat.value,
      carbs: carbs.value,
    },
  };
}

// Creates one entry, always dated "today" (Europe/Kyiv) — there's no way
// to backdate via this endpoint, matching how weight's week_start is
// always server-computed rather than client-supplied.
app.post('/api/food-entries', async (req, res) => {
  const tgUser = await authenticateAllowedUser(req, res);
  if (!tgUser) return;

  const parsed = parseFoodEntryBody(req.body);
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });

  try {
    const userId = await db.getOrCreateUser({
      telegram_id: tgUser.id,
      first_name: tgUser.first_name,
      username: tgUser.username,
    });
    const entry = await db.createFoodEntry(userId, todayISO(), parsed.value);
    res.json({ entry });
  } catch (err) {
    console.error('[food-entries:post] failed:', err.message);
    res.status(502).json({ error: 'Не вдалося зберегти запис. Спробуйте ще раз.' });
  }
});

// Lists entries for one day — defaults to today, but accepts ?date= for
// completeness (the client's "Історія за сьогодні" only ever asks for
// today, since the entries themselves also live in that day's local
// CloudStorage log, which is the client's real source of truth for the UI).
app.get('/api/food-entries', async (req, res) => {
  const tgUser = await authenticateAllowedUser(req, res);
  if (!tgUser) return;

  const requestedDate = typeof req.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)
    ? req.query.date
    : todayISO();

  try {
    const userId = await db.getOrCreateUser({
      telegram_id: tgUser.id,
      first_name: tgUser.first_name,
      username: tgUser.username,
    });
    const entries = await db.getFoodEntriesForDate(userId, requestedDate);
    res.json({ entries });
  } catch (err) {
    console.error('[food-entries:get] failed:', err.message);
    res.status(502).json({ error: 'Не вдалося завантажити історію.' });
  }
});

app.put('/api/food-entries/:id', async (req, res) => {
  const tgUser = await authenticateAllowedUser(req, res);
  if (!tgUser) return;

  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid entry id' });
  }

  const parsed = parseFoodEntryBody(req.body);
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });

  try {
    const userId = await db.getOrCreateUser({
      telegram_id: tgUser.id,
      first_name: tgUser.first_name,
      username: tgUser.username,
    });
    const entry = await db.updateFoodEntry(userId, id, parsed.value);
    if (!entry) return res.status(404).json({ error: 'Entry not found' });
    res.json({ entry });
  } catch (err) {
    console.error('[food-entries:put] failed:', err.message);
    res.status(502).json({ error: 'Не вдалося оновити запис.' });
  }
});

app.delete('/api/food-entries/:id', async (req, res) => {
  const tgUser = await authenticateAllowedUser(req, res);
  if (!tgUser) return;

  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid entry id' });
  }

  try {
    const userId = await db.getOrCreateUser({
      telegram_id: tgUser.id,
      first_name: tgUser.first_name,
      username: tgUser.username,
    });
    await db.deleteFoodEntry(userId, id);
    res.json({ deleted: true });
  } catch (err) {
    console.error('[food-entries:delete] failed:', err.message);
    res.status(502).json({ error: 'Не вдалося видалити запис.' });
  }
});

// ---------------------------------------------------------------------------
// Per-user settings (currently just the custom daily calorie target)
// ---------------------------------------------------------------------------

const MIN_DAILY_TARGET = 800;
const MAX_DAILY_TARGET = 6000;

// Per-macro gram ceilings. Generous on purpose — the real constraint is
// the derived calorie total below (4/9/4), which these can't individually
// breach. They exist to reject obvious garbage (a fat-finger 9999) before
// it reaches the database, not to police anyone's diet.
const MACRO_LIMITS = {
  target_protein: { min: 0, max: 600 },
  target_fat: { min: 0, max: 400 },
  target_carbs: { min: 0, max: 1200 },
};

// How far the macros' own 4/9/4 total may sit from the submitted
// daily_target before we treat the pair as incoherent.
//
// Zero tolerance would be wrong: when the user edits the CALORIE field the
// client scales the three macros by the ratio and rounds each to a whole
// gram, so the derived total lands up to ~9 kcal off the number the user
// actually typed (0.5g of fat alone is 4.5). Showing them 2497 after they
// typed 2500 would be worse than carrying the drift, so the drift is
// allowed — but only at a size rounding can explain. Anything larger means
// a genuine client bug, and silently storing a calorie total that the hero
// card's own macro rows contradict is exactly the kind of thing that's
// miserable to debug later.
const MACRO_KCAL_TOLERANCE = 25;

// Parses one optional macro field. Returns { ok: true, value } where value
// is an integer or null (null = "clear it, go back to deriving this macro
// from the scaled catalog"), or { ok: false, error }.
//
// Missing and explicitly-null are deliberately treated the SAME, as
// "clear": this endpoint always receives the client's complete intended
// state, never a patch, so an absent macro genuinely means absent.
function parseMacroField(body, field) {
  const raw = body?.[field];
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: null };

  const value = Number(raw);
  const { min, max } = MACRO_LIMITS[field];
  if (!Number.isInteger(value) || value < min || value > max) {
    return { ok: false, error: `${field} must be a whole number of grams between ${min} and ${max}` };
  }
  return { ok: true, value };
}

// Updates this user's calorie target and optional custom macro targets (the
// base default, DAILY_CALORIE_TARGET, is 2220 — see database.js). Same auth
// + allowlist check as the weight endpoints above. Whatever is saved here is
// what GET /api/check-auth returns to the client on the next app open.
//
// Macros are all-or-nothing: either all three grams arrive, or none do.
// A partial set has no coherent meaning — the calorie total is a function
// of all three, so storing (protein, carbs) with fat left to be derived
// from a scaling ratio would produce a total that agrees with neither.
app.post('/api/user/settings', async (req, res) => {
  const tgUser = await authenticateAllowedUser(req, res);
  if (!tgUser) return;

  const dailyTarget = Number(req.body?.daily_target);
  if (!Number.isInteger(dailyTarget) || dailyTarget < MIN_DAILY_TARGET || dailyTarget > MAX_DAILY_TARGET) {
    return res.status(400).json({
      error: `daily_target must be a whole number between ${MIN_DAILY_TARGET} and ${MAX_DAILY_TARGET}`,
    });
  }

  const protein = parseMacroField(req.body, 'target_protein');
  const fat = parseMacroField(req.body, 'target_fat');
  const carbs = parseMacroField(req.body, 'target_carbs');
  for (const parsed of [protein, fat, carbs]) {
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
  }

  const provided = [protein.value, fat.value, carbs.value].filter((v) => v !== null).length;
  if (provided !== 0 && provided !== 3) {
    return res.status(400).json({
      error: 'target_protein, target_fat and target_carbs must be sent together, or not at all',
    });
  }

  if (provided === 3) {
    const derivedKcal = protein.value * 4 + fat.value * 9 + carbs.value * 4;
    if (derivedKcal < MIN_DAILY_TARGET || derivedKcal > MAX_DAILY_TARGET) {
      return res.status(400).json({
        error: `Макроси дають ${derivedKcal} ккал — поза межами ${MIN_DAILY_TARGET}–${MAX_DAILY_TARGET}.`,
      });
    }
    if (Math.abs(derivedKcal - dailyTarget) > MACRO_KCAL_TOLERANCE) {
      return res.status(400).json({
        error: `daily_target (${dailyTarget}) does not match the macros' 4/9/4 total (${derivedKcal})`,
      });
    }
  }

  try {
    const userId = await db.getOrCreateUser({
      telegram_id: tgUser.id,
      first_name: tgUser.first_name,
      username: tgUser.username,
    });
    await db.updateUserTargets(userId, {
      dailyTarget,
      targetProtein: protein.value,
      targetFat: fat.value,
      targetCarbs: carbs.value,
    });
    res.json({
      daily_target: dailyTarget,
      target_protein: protein.value,
      target_fat: fat.value,
      target_carbs: carbs.value,
    });
  } catch (err) {
    console.error('[user-settings] failed:', err.message);
    res.status(502).json({ error: 'Не вдалося зберегти денну ціль. Спробуйте ще раз.' });
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
  // transient statuses lookup failure (e.g. a Turso cold-start 404 that
  // outlasts runTursoQuery's own retries) should mean "nobody got a
  // summary this run", not "the endpoint is down".
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
// rejected with a 409. This used to be fatal — an uncaught rejection here
// took the whole Node process down, Express API and all, over what's
// really just a few seconds of overlap during a routine deploy.
// startBotWithRetry() below catches that specific error and waits for the
// old instance to finish closing out (see handleShutdown further down —
// that's what actually frees up the polling slot) instead of crashing.
const BOT_START_RETRY_DELAY_MS = 3000;

// Set by handleShutdown() so a retry that's already scheduled via
// setTimeout doesn't fire again once THIS instance has itself been asked
// to shut down (e.g. it's the one being redeployed away this time).
let botShuttingDown = false;
let botRetryTimer = null;

async function startBotWithRetry() {
  if (botShuttingDown) return;

  try {
    // bot.start() resolves only once bot.stop() is called — it IS the
    // long-poll loop, not a one-off request — so this await normally
    // never returns while polling is healthy. It only rejects (or
    // returns early) if something goes wrong getting that loop started
    // in the first place, which is exactly what the catch below handles.
    // onStart fires once the very first getUpdates call actually
    // succeeds, which is the accurate place to log success — unlike a
    // log line placed right after a fire-and-forget bot.start() call,
    // which would fire immediately regardless of whether polling ever
    // actually started.
    await bot.start({
      onStart: () => console.log('✅ Telegram bot is polling for updates'),
    });
  } catch (err) {
    if (botShuttingDown) return; // already shutting down — nothing to retry for

    const is409 = err instanceof GrammyError && err.error_code === 409;

    if (is409) {
      console.warn('[bot] 409 Conflict detected (previous instance closing), retrying in 3 seconds...');
    } else {
      // Anything else unexpected (a network blip, Telegram briefly
      // unreachable) also retries with the same backoff rather than
      // crashing the process — same reasoning as the 409 case, just a
      // different root cause.
      console.error('[bot] Failed to start polling, retrying in 3 seconds:', err?.message || err);
    }

    botRetryTimer = setTimeout(() => {
      botRetryTimer = null;
      startBotWithRetry();
    }, BOT_START_RETRY_DELAY_MS);
  }
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------
// Render sends SIGTERM to the old container during a zero-downtime deploy
// (SIGINT covers a local Ctrl+C). Closing the long-poll connection here —
// rather than just letting the process die — is what lets the NEW
// instance's own startBotWithRetry() above succeed quickly instead of
// sitting through repeated 409s until Telegram's session eventually times
// out on its own.
// Hard ceiling on the whole shutdown sequence below: if bot.stop() or the
// HTTP server's close() ever hangs (a stuck request, a network edge case),
// Render/the OS will eventually SIGKILL anyway, but that's much slower and
// noisier than just forcing our own exit once we've given cleanup a fair
// chance to finish.
const SHUTDOWN_TIMEOUT_MS = 5000;

const handleShutdown = async (signal) => {
  console.log(`[shutdown] ${signal} received — stopping gracefully...`);
  botShuttingDown = true;
  if (botRetryTimer) {
    clearTimeout(botRetryTimer);
    botRetryTimer = null;
  }

  const forceExit = setTimeout(() => {
    console.warn('[shutdown] Cleanup did not finish in time, forcing exit.');
    process.exit(0);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExit.unref(); // never keeps the process alive on its own

  try {
    await bot.stop();
  } catch (err) {
    // Ignore if already stopped.
  }

  if (httpServer) {
    await new Promise((resolve) => httpServer.close(() => resolve()));
  }

  clearTimeout(forceExit);
  process.exit(0);
};

process.once('SIGTERM', () => handleShutdown('SIGTERM'));
process.once('SIGINT', () => handleShutdown('SIGINT'));

// Safety net: an uncaught error anywhere (a bad Gemini response shape we
// didn't guard, a rejected promise nobody attached a .catch to, etc.)
// should not silently kill the whole bot + API with no trace of why. Log
// it clearly, then shut down the same clean way SIGTERM does rather than
// leaving the process in a possibly-corrupt state — Render will restart
// the container automatically either way, so favor a clean, logged exit
// over an ambiguous one.
process.on('unhandledRejection', (reason) => {
  console.error('[!] Unhandled promise rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[!] Uncaught exception:', err);
  handleShutdown('uncaughtException').catch(() => process.exit(1));
});

db.ensureSchema()
  .then(async () => {
    httpServer = app.listen(PORT, () => {
      console.log(`✅ Server listening on http://localhost:${PORT}`);
    });

    await bot.api.deleteWebhook({ drop_pending_updates: true });
    startBotWithRetry(); // fire-and-forget — logs its own success (onStart) or retries on failure, never blocks boot

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
