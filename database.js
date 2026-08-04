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

const seedData = require('./seed-data');

const CATEGORIES_META = [
  { key: 'garnish', name: 'Гарнір', emoji: '🌾', target_calories: 360 },
  { key: 'dairy', name: 'Молочні продукти', emoji: '🥛', target_calories: 260 },
  { key: 'freebie', name: '3) Будь-чого (~425 Ккал)', emoji: '🍫', target_calories: 425 },
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

module.exports = {
  CATALOG,
  DAILY_CALORIE_TARGET,
  PROTEIN_TARGET_G,
  CARBS_TARGET_G,
  FAT_TARGET_G,
};
