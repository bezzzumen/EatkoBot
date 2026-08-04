// database.js
// -----------------------------------------------------------------------------
// SQLite setup + logic for the Flexible Daily Grams Budget Tracker.
//
// Model: 8 fixed daily categories (garnish, dairy, freebie, protein, veggies,
// fats, fruits, nuts), each with a total target calorie count and a list of
// items with a maximum daily allowance in grams (or pieces, e.g. eggs).
// There are no meals and no 50/50 rule anymore — you just log grams against
// an item, any number of times a day, and it accumulates.
//
//   category usage ratio  = sum(logged_grams / max_grams) across its items
//   category kcal consumed = category.target_calories * usage_ratio
//   (ratio — and therefore calories — can exceed 1.0 / 100% on purpose)
//
// BREAKING CHANGE: this replaces the earlier meal-based/50-50/swap model.
// If diet.db already exists from that version, its `products`/`daily_logs`
// tables use incompatible columns (meal_number, portion_percentage, ...) —
// migrateSchema() below detects that and drops+recreates them. Any
// previously logged history is lost; there's no way to carry it forward
// since the data model itself changed.
// -----------------------------------------------------------------------------

const path = require('path');
const Database = require('better-sqlite3');
const seedData = require('./seed-data');

const db = new Database(path.join(__dirname, 'diet.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ---------------------------------------------------------------------------
// Fixed category configuration — the 8 daily buckets and their kcal targets.
// Product rows reference these by `category_key`; seed-data.js uses the same
// keys. This lives in code (not just derived from the products table)
// because emoji/display name/target calories need to exist even before any
// products are seeded.
// ---------------------------------------------------------------------------

const CATEGORIES = [
  { key: 'garnish', name: 'Гарнір', emoji: '🌾', target_calories: 360 },
  { key: 'dairy', name: 'Молочні продукти', emoji: '🥛', target_calories: 260 },
  { key: 'freebie', name: 'Будь-чого', emoji: '🍫', target_calories: 425 },
  { key: 'protein', name: "М'ясо / Риба / Яйця", emoji: '🍗', target_calories: 400 },
  { key: 'veggies', name: 'Овочі та гриби', emoji: '🥦', target_calories: 120 },
  { key: 'fats', name: 'Жири та соуси', emoji: '🥑', target_calories: 220 },
  { key: 'fruits', name: 'Фрукти та ягоди', emoji: '🍎', target_calories: 290 },
  { key: 'nuts', name: 'Горіхи та насіння', emoji: '🌰', target_calories: 145 },
];
const CATEGORY_KEYS = new Set(CATEGORIES.map((c) => c.key));

const DAILY_CALORIE_TARGET = CATEGORIES.reduce((sum, c) => sum + c.target_calories, 0); // 2220
// Macro goals are inherited from the previous version (not respecified this
// round) — update these if your real targets differ.
const PROTEIN_TARGET_G = 135;
const CARBS_TARGET_G = 215;
const FAT_TARGET_G = 62;

// ---------------------------------------------------------------------------
// Migration: drop the old meal-based schema if present (incompatible columns)
// ---------------------------------------------------------------------------

function migrateSchema() {
  const cols = db.prepare("PRAGMA table_info(products)").all();
  const hasNewSchema = cols.some((c) => c.name === 'category_key');
  if (cols.length > 0 && !hasNewSchema) {
    console.log('[migrate] Old meal-based schema detected — recreating products/daily_logs for the new gram-budget model.');
    db.exec('DROP TABLE IF EXISTS daily_logs');
    db.exec('DROP TABLE IF EXISTS products');
  }
}
migrateSchema();

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id      TEXT UNIQUE NOT NULL,
    first_name       TEXT,
    username         TEXT,
    created_at       TEXT DEFAULT (datetime('now'))
  );

  -- Every item you're allowed to eat, grouped by one of the 8 fixed
  -- categories, with its own daily max allowance and the macros that eating
  -- the FULL max_grams of it would represent (scaled down proportionally to
  -- however much is actually logged).
  CREATE TABLE IF NOT EXISTS products (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    category_key     TEXT NOT NULL,
    product_name     TEXT NOT NULL,
    max_grams        REAL NOT NULL,           -- daily allowance (grams, or a piece count — see unit)
    unit             TEXT NOT NULL DEFAULT 'г',
    protein          REAL NOT NULL DEFAULT 0, -- macros for eating the FULL max_grams
    carbs            REAL NOT NULL DEFAULT 0,
    fat              REAL NOT NULL DEFAULT 0,
    notes            TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_key);

  -- One row per (user, date, product) — logging more of the same item on the
  -- same day accumulates into this same row rather than creating new rows.
  CREATE TABLE IF NOT EXISTS daily_logs (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    log_date         TEXT NOT NULL,
    product_id       INTEGER NOT NULL REFERENCES products(id),
    logged_grams     REAL NOT NULL DEFAULT 0,
    updated_at       TEXT DEFAULT (datetime('now')),
    UNIQUE(user_id, log_date, product_id)
  );
  CREATE INDEX IF NOT EXISTS idx_daily_logs_user_date ON daily_logs(user_id, log_date);
`);

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

function seedProductsIfEmpty() {
  const { count } = db.prepare('SELECT COUNT(*) AS count FROM products').get();
  if (count > 0) return { seeded: false, count };

  const insert = db.prepare(`
    INSERT INTO products (category_key, product_name, max_grams, unit, protein, carbs, fat, notes)
    VALUES (@category_key, @product_name, @max_grams, @unit, @protein, @carbs, @fat, @notes)
  `);

  const insertMany = db.transaction((items) => {
    for (const item of items) {
      if (!CATEGORY_KEYS.has(item.category_key)) {
        throw new Error(`seed-data.js: unknown category_key "${item.category_key}" for "${item.product_name}"`);
      }
      insert.run({
        ...item,
        unit: item.unit || 'г',
        protein: item.protein || 0,
        carbs: item.carbs || 0,
        fat: item.fat || 0,
        notes: item.notes || null,
      });
    }
  });

  insertMany(seedData);
  return { seeded: true, count: seedData.length };
}

// ---------------------------------------------------------------------------
// User helpers
// ---------------------------------------------------------------------------

function getOrCreateUser({ telegram_id, first_name, username }) {
  const existing = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(String(telegram_id));

  if (existing) {
    db.prepare('UPDATE users SET first_name = ?, username = ? WHERE id = ?')
      .run(first_name || existing.first_name, username || existing.username, existing.id);
    return db.prepare('SELECT * FROM users WHERE id = ?').get(existing.id);
  }

  const info = db
    .prepare('INSERT INTO users (telegram_id, first_name, username) VALUES (?, ?, ?)')
    .run(String(telegram_id), first_name || null, username || null);

  return db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
}

function listUsers() {
  return db.prepare('SELECT * FROM users').all();
}

// ---------------------------------------------------------------------------
// Product catalog helpers
// ---------------------------------------------------------------------------

function getProduct(productId) {
  return db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
}

function getProductsByCategory(categoryKey) {
  return db.prepare('SELECT * FROM products WHERE category_key = ? ORDER BY product_name').all(categoryKey);
}

// ---------------------------------------------------------------------------
// Logging: accumulating grams against a product for a given day
// ---------------------------------------------------------------------------

// Adds `grams` to whatever is already logged for this (user, date, product) —
// e.g. logging 10g then 5g later accumulates to 15g. Pass a negative number
// to correct a mistake; the total is clamped at 0. Returns the fresh daily
// status (same shape as getTodayStatus) so the caller never needs a second
// round trip.
function logGrams(userId, date, productId, grams) {
  grams = Number(grams);
  if (!Number.isFinite(grams) || grams === 0) {
    throw new Error('grams must be a non-zero number');
  }

  const product = getProduct(productId);
  if (!product) throw new Error('Unknown product_id');

  const existing = db
    .prepare('SELECT * FROM daily_logs WHERE user_id = ? AND log_date = ? AND product_id = ?')
    .get(userId, date, productId);

  const newGrams = Math.max(0, (existing ? existing.logged_grams : 0) + grams);

  if (existing) {
    db.prepare(`UPDATE daily_logs SET logged_grams = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(newGrams, existing.id);
  } else {
    db.prepare(`INSERT INTO daily_logs (user_id, log_date, product_id, logged_grams) VALUES (?, ?, ?, ?)`)
      .run(userId, date, productId, newGrams);
  }

  return getTodayStatus(userId, date);
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

const round1 = (n) => Math.round(n * 10) / 10;

// Full picture of a given day: every category, every item's logged amount
// vs its max, category usage % (can exceed 100), calories/macros consumed
// (uncapped — overeating a category inflates its calories proportionally),
// and day-wide totals vs the fixed goals.
function getTodayStatus(userId, date) {
  const logs = db.prepare('SELECT * FROM daily_logs WHERE user_id = ? AND log_date = ?').all(userId, date);
  const loggedByProduct = Object.fromEntries(logs.map((l) => [l.product_id, l.logged_grams]));

  const allProducts = db.prepare('SELECT * FROM products ORDER BY category_key, product_name').all();

  let totalCalories = 0;
  let totalProtein = 0;
  let totalCarbs = 0;
  let totalFat = 0;

  const categories = CATEGORIES.map((catMeta) => {
    const items = allProducts
      .filter((p) => p.category_key === catMeta.key)
      .map((p) => {
        const loggedGrams = loggedByProduct[p.id] || 0;
        const ratio = p.max_grams ? loggedGrams / p.max_grams : 0;
        return {
          product_id: p.id,
          product_name: p.product_name,
          max_grams: p.max_grams,
          unit: p.unit,
          logged_grams: round1(loggedGrams),
          percent: round1(ratio * 100),
          protein: round1(ratio * p.protein),
          carbs: round1(ratio * p.carbs),
          fat: round1(ratio * p.fat),
        };
      });

    const usageRatio = items.reduce((sum, it) => sum + it.percent / 100, 0);
    const caloriesConsumed = catMeta.target_calories * usageRatio;
    const proteinConsumed = items.reduce((sum, it) => sum + it.protein, 0);
    const carbsConsumed = items.reduce((sum, it) => sum + it.carbs, 0);
    const fatConsumed = items.reduce((sum, it) => sum + it.fat, 0);

    totalCalories += caloriesConsumed;
    totalProtein += proteinConsumed;
    totalCarbs += carbsConsumed;
    totalFat += fatConsumed;

    let status = 'active';
    if (usageRatio >= 1.005) status = 'over';
    else if (usageRatio >= 0.995) status = 'complete';

    return {
      category_key: catMeta.key,
      category_name: catMeta.name,
      emoji: catMeta.emoji,
      target_calories: catMeta.target_calories,
      usage_percent: round1(usageRatio * 100),
      calories_consumed: round1(caloriesConsumed),
      status,
      protein: round1(proteinConsumed),
      carbs: round1(carbsConsumed),
      fat: round1(fatConsumed),
      items,
    };
  });

  return {
    date,
    daily_calorie_target: DAILY_CALORIE_TARGET,
    total_calories: round1(totalCalories),
    totals: {
      calories: round1(totalCalories),
      protein: round1(totalProtein),
      carbs: round1(totalCarbs),
      fat: round1(totalFat),
    },
    goals: {
      calories: DAILY_CALORIE_TARGET,
      protein: PROTEIN_TARGET_G,
      carbs: CARBS_TARGET_G,
      fat: FAT_TARGET_G,
    },
    categories,
  };
}

// Clears every logged gram for a user on a given date (defaults to today).
function resetDailyState(userId, date) {
  const info = db.prepare('DELETE FROM daily_logs WHERE user_id = ? AND log_date = ?').run(userId, date);
  return { date, deleted: info.changes };
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

seedProductsIfEmpty();

module.exports = {
  db,
  CATEGORIES,
  DAILY_CALORIE_TARGET,
  PROTEIN_TARGET_G,
  CARBS_TARGET_G,
  FAT_TARGET_G,
  getOrCreateUser,
  listUsers,
  getProduct,
  getProductsByCategory,
  seedProductsIfEmpty,
  logGrams,
  getTodayStatus,
  resetDailyState,
};
