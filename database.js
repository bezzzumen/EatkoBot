// database.js
// -----------------------------------------------------------------------------
// This app no longer persists daily logs server-side. Render's free tier
// wipes the local filesystem (and therefore any SQLite file) whenever the
// service sleeps/restarts, which made `daily_logs` unreliable — so logging
// now happens entirely client-side via Telegram WebApp CloudStorage (with a
// localStorage fallback), see public/app.js.
//
// The only thing left on the server is the static product catalog — the 8
// categories and their items, straight from seed-data.js — which is safe to
// rebuild fresh in memory on every boot since it's read-only reference data,
// not user data. No database at all anymore, so better-sqlite3 is gone too
// (as a bonus, that also permanently resolves the native-module ABI
// mismatch we hit deploying to Render earlier).
// -----------------------------------------------------------------------------

const crypto = require('crypto');
const seedData = require('./seed-data');

const CATEGORIES_META = [
  { key: 'garnish', name: 'Гарнір', emoji: '🌾', target_calories: 360 },
  { key: 'dairy', name: 'Молочні продукти', emoji: '🥛', target_calories: 260 },
  { key: 'freebie', name: 'Будь-чого', emoji: '🍫', target_calories: 425 },
  { key: 'protein', name: "М'ясо / Риба / Яйця", emoji: '🍗', target_calories: 400 },
  { key: 'veggies', name: 'Овочі та гриби', emoji: '🥦', target_calories: 120 },
  { key: 'fats', name: 'Жири та соуси', emoji: '🥑', target_calories: 220 },
  { key: 'fruits', name: 'Фрукти та ягоди', emoji: '🍎', target_calories: 290 },
  { key: 'nuts', name: 'Горіхи та насіння', emoji: '🌰', target_calories: 145 },
];
const CATEGORY_KEYS = new Set(CATEGORIES_META.map((c) => c.key));

const DAILY_CALORIE_TARGET = CATEGORIES_META.reduce((sum, c) => sum + c.target_calories, 0); // 2220
const PROTEIN_TARGET_G = 135;
const CARBS_TARGET_G = 215;
const FAT_TARGET_G = 62;

// Stable, ASCII-only identifiers for CloudStorage keys — Telegram CloudStorage
// keys may only contain A-Z a-z 0-9 _ -, so the (Cyrillic) product names
// can't be used directly. Each item's key is `${category_key}_${index}`,
// where index is its position within seed-data.js's list for that category.
// This is stable across server restarts (the catalog rebuilds identically
// every time), but reordering items within a category in seed-data.js WILL
// shift these keys and orphan any grams a user already logged against the
// shifted items — safest to only ever append new items at the end of a
// category's list.
function buildCatalog() {
  const grouped = {};
  for (const item of seedData) {
    if (!CATEGORY_KEYS.has(item.category_key)) {
      throw new Error(`seed-data.js: unknown category_key "${item.category_key}" for "${item.product_name}"`);
    }
    (grouped[item.category_key] = grouped[item.category_key] || []).push(item);
  }

  const categories = CATEGORIES_META.map((meta) => ({
    key: meta.key,
    name: meta.name,
    emoji: meta.emoji,
    target_calories: meta.target_calories,
    items: (grouped[meta.key] || []).map((item, index) => ({
      product_key: `${meta.key}_${index}`,
      product_name: item.product_name,
      max_grams: item.max_grams,
      unit: item.unit || 'г',
      protein: item.protein || 0,
      carbs: item.carbs || 0,
      fat: item.fat || 0,
    })),
  }));

  return {
    daily_calorie_target: DAILY_CALORIE_TARGET,
    protein_goal: PROTEIN_TARGET_G,
    carbs_goal: CARBS_TARGET_G,
    fat_goal: FAT_TARGET_G,
    categories,
  };
}

// Built once at process boot — purely derived from seed-data.js, no I/O.
const CATALOG = buildCatalog();

// -----------------------------------------------------------------------------
// Persistence (Turso) — re-added for the multi-user evening broadcast feature.
//
// Daily LOGGING (grams against products) still lives entirely in each user's
// own Telegram CloudStorage/localStorage — that part hasn't changed, and this
// database does NOT store food logs. What it stores is a lightweight DAILY
// SUMMARY that the client pushes here after computing it locally (see
// syncDailyStatus() in public/app.js): total calories, streak, and a
// category-level breakdown. That's the minimum needed for the server to
// later loop over every user and send each their personalized evening
// message — something it has no way to do by reading CloudStorage directly
// (there's no API for that), so the client has to hand it over.
//
// Uses @tursodatabase/serverless: zero native dependencies (pure fetch),
// specifically to avoid a repeat of the better-sqlite3 native-binary ABI
// mismatch this project hit deploying to Render previously.
// -----------------------------------------------------------------------------

const { createClient } = require('@tursodatabase/serverless/compat');

const TURSO_DATABASE_URL = process.env.TURSO_DATABASE_URL;
const TURSO_AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN;

let turso = null;
if (TURSO_DATABASE_URL && TURSO_AUTH_TOKEN) {
  turso = createClient({ url: TURSO_DATABASE_URL, authToken: TURSO_AUTH_TOKEN });
} else {
  console.warn(
    '\n[!] TURSO_DATABASE_URL / TURSO_AUTH_TOKEN not set — daily status sync ' +
    '(POST /api/sync-status) and the evening broadcast (GET /api/trigger-evening-summary) ' +
    'will not work until both are configured.\n'
  );
}

function isDatabaseConfigured() {
  return !!turso;
}

async function ensureSchema() {
  if (!turso) return;

  await turso.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id TEXT UNIQUE NOT NULL,
      first_name TEXT,
      username TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // One row per (user, date) — a snapshot of that day's totals, upserted
  // every time the client syncs. Only the latest snapshot per day is kept.
  await turso.execute(`
    CREATE TABLE IF NOT EXISTS daily_status (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id              INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      log_date             TEXT NOT NULL,
      total_calories       REAL NOT NULL,
      daily_calorie_target REAL NOT NULL,
      streak               INTEGER NOT NULL DEFAULT 0,
      categories_json      TEXT NOT NULL,
      updated_at           TEXT DEFAULT (datetime('now')),
      UNIQUE(user_id, log_date)
    )
  `);

  // The invite-code allowlist. Kept deliberately separate from `users`
  // above (which just tracks "anyone who's ever synced data") — this is
  // specifically "who is permitted to use the app at all".
  await turso.execute(`
    CREATE TABLE IF NOT EXISTS allowed_users (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id    TEXT UNIQUE NOT NULL,
      first_name     TEXT,
      username       TEXT,
      authorized_at  TEXT DEFAULT (datetime('now'))
    )
  `);

  await turso.execute(`
    CREATE TABLE IF NOT EXISTS invite_codes (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      code                TEXT UNIQUE NOT NULL,
      is_used             INTEGER NOT NULL DEFAULT 0,
      used_by_telegram_id TEXT,
      created_at          TEXT DEFAULT (datetime('now')),
      used_at             TEXT
    )
  `);

  // Every evening-summary prediction/fortune line actually sent to a user,
  // so repeat-avoidance can be genuinely per-user and survive server
  // restarts — an in-memory-only, all-users-shared history (the previous
  // approach) neither of those things.
  await turso.execute(`
    CREATE TABLE IF NOT EXISTS sent_predictions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind        TEXT NOT NULL,
      prediction  TEXT NOT NULL,
      sent_at     TEXT DEFAULT (datetime('now'))
    )
  `);
  await turso.execute(`
    CREATE INDEX IF NOT EXISTS idx_sent_predictions_user ON sent_predictions(user_id, kind, sent_at)
  `);
}

async function getOrCreateUser({ telegram_id, first_name, username }) {
  if (!turso) throw new Error('Database not configured');

  const existing = await turso.execute({
    sql: 'SELECT id, first_name, username FROM users WHERE telegram_id = ?',
    args: [String(telegram_id)],
  });

  if (existing.rows.length) {
    const row = existing.rows[0];
    await turso.execute({
      sql: 'UPDATE users SET first_name = ?, username = ? WHERE id = ?',
      args: [first_name || row.first_name || null, username || row.username || null, row.id],
    });
    return Number(row.id);
  }

  const info = await turso.execute({
    sql: 'INSERT INTO users (telegram_id, first_name, username) VALUES (?, ?, ?)',
    args: [String(telegram_id), first_name || null, username || null],
  });
  return Number(info.lastInsertRowid);
}

// Upserts today's (or any date's) computed status for a user. Called by
// POST /api/sync-status, which the client hits after every log action.
async function upsertDailyStatus(userId, date, { total_calories, daily_calorie_target, streak, categories }) {
  if (!turso) throw new Error('Database not configured');

  await turso.execute({
    sql: `
      INSERT INTO daily_status (user_id, log_date, total_calories, daily_calorie_target, streak, categories_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(user_id, log_date) DO UPDATE SET
        total_calories = excluded.total_calories,
        daily_calorie_target = excluded.daily_calorie_target,
        streak = excluded.streak,
        categories_json = excluded.categories_json,
        updated_at = datetime('now')
    `,
    args: [userId, date, total_calories, daily_calorie_target, streak || 0, JSON.stringify(categories || [])],
  });
}

// Every user's synced status for a given date — what the evening broadcast
// loops over. Users who never synced anything for that date simply won't
// appear (there's nothing to send them).
async function getAllStatusForDate(date) {
  if (!turso) return [];

  const result = await turso.execute({
    sql: `
      SELECT u.id AS user_id, u.telegram_id, u.first_name, d.total_calories, d.daily_calorie_target, d.streak, d.categories_json
      FROM daily_status d
      JOIN users u ON u.id = d.user_id
      WHERE d.log_date = ?
    `,
    args: [date],
  });

  return result.rows.map((row) => ({
    user_id: row.user_id,
    telegram_id: row.telegram_id,
    first_name: row.first_name,
    total_calories: row.total_calories,
    daily_calorie_target: row.daily_calorie_target,
    streak: row.streak,
    categories: JSON.parse(row.categories_json || '[]'),
  }));
}

// ---------------------------------------------------------------------------
// Invite-code / authorization system
// ---------------------------------------------------------------------------

// Authorized if EITHER: this telegram_id is already in allowed_users (the
// normal case), OR it's recorded as having used a code in invite_codes but
// somehow never made it into allowed_users (e.g. the server died between
// the two writes in verifyAndConsumeInviteCode below — those aren't atomic).
// The second case also self-heals by backfilling the missing allowed_users
// row, so this only needs to run once per affected user.
async function isUserAllowed({ telegram_id, first_name, username }) {
  if (!turso) return false;
  const tgId = String(telegram_id);

  const allowed = await turso.execute({
    sql: 'SELECT 1 FROM allowed_users WHERE telegram_id = ?',
    args: [tgId],
  });
  if (allowed.rows.length) return true;

  const usedCode = await turso.execute({
    sql: 'SELECT 1 FROM invite_codes WHERE is_used = 1 AND used_by_telegram_id = ?',
    args: [tgId],
  });
  if (usedCode.rows.length) {
    await turso.execute({
      sql: `
        INSERT INTO allowed_users (telegram_id, first_name, username)
        VALUES (?, ?, ?)
        ON CONFLICT(telegram_id) DO UPDATE SET first_name = excluded.first_name, username = excluded.username
      `,
      args: [tgId, first_name || null, username || null],
    });
    return true;
  }

  return false;
}

// Human-typeable code: "EATKO-" prefix + 4 random uppercase letters/digits,
// excluding visually ambiguous characters (0/O, 1/I/L).
function generateCodeString() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let suffix = '';
  for (let i = 0; i < 4; i++) {
    suffix += chars[crypto.randomInt(chars.length)];
  }
  return `EATKO-${suffix}`;
}

// Creates a new unused invite code and persists it. Retries on the
// astronomically unlikely chance of a collision with an existing code.
async function generateInviteCode() {
  if (!turso) throw new Error('Database not configured');

  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateCodeString();
    try {
      await turso.execute({
        sql: 'INSERT INTO invite_codes (code) VALUES (?)',
        args: [code],
      });
      return code;
    } catch (err) {
      if (attempt === 4) throw err; // give up after a few collisions
    }
  }
}

// Validates a code, and if valid: marks it used and adds the user to
// allowed_users. Returns { ok: true } or { ok: false, reason } — reason is
// safe to show directly to the user (no internal detail leaked).
//
// If the code is already marked used, but by THIS SAME telegram_id (e.g.
// they're retrying after a previous attempt partially failed, or opening
// on another device and re-entering an old code out of habit), this treats
// it as a successful login rather than an error — matches how the "already
// used" state should behave for the person who legitimately used it.
async function verifyAndConsumeInviteCode(code, { telegram_id, first_name, username }) {
  if (!turso) throw new Error('Database not configured');

  const normalized = String(code || '').trim().toUpperCase();
  if (!normalized) return { ok: false, reason: 'Введіть код запрошення.' };

  const existing = await turso.execute({
    sql: 'SELECT id, is_used, used_by_telegram_id FROM invite_codes WHERE code = ?',
    args: [normalized],
  });

  if (!existing.rows.length) {
    return { ok: false, reason: 'Невірний код запрошення.' };
  }

  const row = existing.rows[0];

  if (row.is_used) {
    const usedByThisUser = row.used_by_telegram_id != null && String(row.used_by_telegram_id) === String(telegram_id);
    if (!usedByThisUser) {
      return { ok: false, reason: 'Цей код уже використано.' };
    }
    // Same person, re-submitting a code they already used — log them in
    // (and make sure allowed_users actually has them, in case that half of
    // the original write never completed).
    await turso.execute({
      sql: `
        INSERT INTO allowed_users (telegram_id, first_name, username)
        VALUES (?, ?, ?)
        ON CONFLICT(telegram_id) DO UPDATE SET first_name = excluded.first_name, username = excluded.username
      `,
      args: [String(telegram_id), first_name || null, username || null],
    });
    return { ok: true };
  }

  const codeId = row.id;

  await turso.execute({
    sql: `UPDATE invite_codes SET is_used = 1, used_by_telegram_id = ?, used_at = datetime('now') WHERE id = ?`,
    args: [String(telegram_id), codeId],
  });

  await turso.execute({
    sql: `
      INSERT INTO allowed_users (telegram_id, first_name, username)
      VALUES (?, ?, ?)
      ON CONFLICT(telegram_id) DO UPDATE SET first_name = excluded.first_name, username = excluded.username
    `,
    args: [String(telegram_id), first_name || null, username || null],
  });

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Evening-summary prediction history (per-user, persistent anti-repeat)
// ---------------------------------------------------------------------------

// Every prediction text sent to this user, for this branch (success/over),
// within the lookback window — used both to avoid re-sending a Gemini
// result that matches something recent, and to filter the static fallback
// pool down to lines this user hasn't seen lately.
async function getRecentPredictions(userId, kind, lookbackDays) {
  if (!turso) return [];
  const result = await turso.execute({
    sql: `
      SELECT prediction FROM sent_predictions
      WHERE user_id = ? AND kind = ? AND sent_at >= datetime('now', ?)
    `,
    args: [userId, kind, `-${lookbackDays} days`],
  });
  return result.rows.map((row) => row.prediction);
}

async function recordSentPrediction(userId, kind, prediction) {
  if (!turso) return;
  await turso.execute({
    sql: 'INSERT INTO sent_predictions (user_id, kind, prediction) VALUES (?, ?, ?)',
    args: [userId, kind, prediction],
  });
}

// Called when the static fallback pool is fully exhausted for this user
// (every line in it was sent within the lookback window) — clears their
// history for this kind so old entries don't keep piling up pointlessly
// once we're intentionally cycling back through the same finite pool.
async function resetUserPredictionHistory(userId, kind) {
  if (!turso) return;
  await turso.execute({
    sql: 'DELETE FROM sent_predictions WHERE user_id = ? AND kind = ?',
    args: [userId, kind],
  });
}

module.exports = {
  CATALOG,
  DAILY_CALORIE_TARGET,
  PROTEIN_TARGET_G,
  CARBS_TARGET_G,
  FAT_TARGET_G,
  isDatabaseConfigured,
  ensureSchema,
  getOrCreateUser,
  upsertDailyStatus,
  getAllStatusForDate,
  isUserAllowed,
  generateInviteCode,
  verifyAndConsumeInviteCode,
  getRecentPredictions,
  recordSentPrediction,
  resetUserPredictionHistory,
};
