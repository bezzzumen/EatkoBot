// database.js
// -----------------------------------------------------------------------------
// SQLite setup + all diet-tracking logic, encoding these custom rules:
//
//   1. Daily target: ~2020 kcal, split across 4 meals.
//   2. The diet is organized into lettered categories ('a' through 'y').
//   3. Picking ONE product from a category uses up ("completes") that
//      category FOR THAT MEAL ONLY — the same category can still be used in
//      a different meal, or on a different day (categories are not tied to
//      a fixed meal; see rule 4).
//   4. 50/50 rule: instead of one full product, a user may pick 50% of
//      product X and 50% of product Y from the same category to complete it.
//      No other split percentages are allowed (only 50 or 100).
//   5. Category 'в' (a 425 kcal snacks/sweets budget) may be swapped for
//      fruit: 10g of the 'в' allowance = 100g of a standard fruit, OR 50g of
//      a high-sugar fruit (banana, grapes, persimmon, ...).
//   6. Categories/items are not locked to a specific meal number — the same
//      category can be used in meal 1 today and meal 3 tomorrow. This is why
//      daily_logs stores meal_number per entry rather than products having a
//      fixed meal assignment.
//
// NOTE on category 'в': that's a Cyrillic letter, kept exactly as specified
// in the requirements, even though the rest of the categories are Latin
// (a-y). If your real diet plan actually uses a different letter for the
// snacks/sweets slot, just change SWAP_CATEGORY_LETTER below (and the
// matching category_letter in seed-data.js) to whatever letter you use.
// -----------------------------------------------------------------------------

const path = require('path');
const Database = require('better-sqlite3');
const seedData = require('./seed-data');

const db = new Database(path.join(__dirname, 'diet.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ---------------------------------------------------------------------------
// Configuration constants — the fixed rules of this diet
// ---------------------------------------------------------------------------

const DAILY_CALORIE_TARGET = 2020;
const PROTEIN_TARGET_G = 135;
const FAT_TARGET_G = 62;
const CARBS_TARGET_G = 215;
const MEALS_PER_DAY = 4;
const ALLOWED_PORTION_PERCENTAGES = [50, 100]; // the only splits the 50/50 rule allows

const SWAP_CATEGORY_LETTER = 'в';           // category that can be swapped for fruit
const SWAP_CATEGORY_TOTAL_GRAMS = 50;       // TODO: set this to the real gram weight behind
                                             // the 425 kcal 'в' budget in your actual plan
const STANDARD_FRUIT_RATIO = 10;            // 10g of 'в' => 100g standard fruit  (100/10)
const HIGH_SUGAR_FRUIT_RATIO = 5;           // 10g of 'в' => 50g high-sugar fruit  (50/10)

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

  -- The full product catalog: every item you're allowed to eat, grouped by
  -- lettered category, with the calories/macros for a stated portion size.
  CREATE TABLE IF NOT EXISTS products (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    category_letter  TEXT NOT NULL,
    category_name    TEXT,
    product_name     TEXT NOT NULL,
    portion_size     REAL NOT NULL,           -- grams the calories/macros values refer to
    portion_unit     TEXT NOT NULL DEFAULT 'g',
    calories         REAL NOT NULL,           -- kcal per portion_size
    protein          REAL NOT NULL DEFAULT 0, -- grams of protein per portion_size
    carbs            REAL NOT NULL DEFAULT 0, -- grams of carbs per portion_size
    fat              REAL NOT NULL DEFAULT 0, -- grams of fat per portion_size
    is_fruit         INTEGER NOT NULL DEFAULT 0, -- usable in the 'в' fruit swap
    is_high_sugar    INTEGER NOT NULL DEFAULT 0, -- high-sugar fruit -> 50g ratio
    notes            TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_letter);

  -- One row per product picked, per meal, per day. A completed category for
  -- a given meal will have either one row at 100%, or two rows at 50% each
  -- (the 50/50 rule).
  CREATE TABLE IF NOT EXISTS daily_logs (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    log_date            TEXT NOT NULL,              -- 'YYYY-MM-DD'
    meal_number         INTEGER NOT NULL CHECK (meal_number BETWEEN 1 AND 4),
    category_letter     TEXT NOT NULL,
    product_id          INTEGER REFERENCES products(id),
    chosen_product       TEXT NOT NULL,               -- snapshot of the name at log time
    portion_percentage   REAL NOT NULL DEFAULT 100,    -- 50 or 100 only
    grams                REAL,                          -- actual grams this entry represents
    calories             REAL NOT NULL DEFAULT 0,
    protein              REAL NOT NULL DEFAULT 0,
    carbs                REAL NOT NULL DEFAULT 0,
    fat                  REAL NOT NULL DEFAULT 0,
    is_swap               INTEGER NOT NULL DEFAULT 0,    -- 1 if this used the 'в'-for-fruit swap
    is_completed          INTEGER NOT NULL DEFAULT 0,    -- category reached 100% for this meal
    created_at             TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_logs_user_date ON daily_logs(user_id, log_date);
  CREATE INDEX IF NOT EXISTS idx_logs_meal_cat ON daily_logs(user_id, log_date, meal_number, category_letter);
`);

// Auto-migration: if this file is running against a diet.db created before
// protein/carbs/fat existed, add the missing columns instead of erroring.
function ensureColumn(table, column, definition) {
  const existing = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!existing.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
ensureColumn('products', 'protein', 'REAL NOT NULL DEFAULT 0');
ensureColumn('products', 'carbs', 'REAL NOT NULL DEFAULT 0');
ensureColumn('products', 'fat', 'REAL NOT NULL DEFAULT 0');
ensureColumn('daily_logs', 'protein', 'REAL NOT NULL DEFAULT 0');
ensureColumn('daily_logs', 'carbs', 'REAL NOT NULL DEFAULT 0');
ensureColumn('daily_logs', 'fat', 'REAL NOT NULL DEFAULT 0');

// ---------------------------------------------------------------------------
// Seeding — loads seed-data.js into `products` only if the table is empty,
// so re-running the app never wipes out data you've already customized.
// ---------------------------------------------------------------------------

function seedProductsIfEmpty() {
  const { count } = db.prepare('SELECT COUNT(*) AS count FROM products').get();
  if (count > 0) return { seeded: false, count };

  const insert = db.prepare(`
    INSERT INTO products
      (category_letter, category_name, product_name, portion_size, portion_unit, calories, protein, carbs, fat, is_fruit, is_high_sugar, notes)
    VALUES
      (@category_letter, @category_name, @product_name, @portion_size, 'g', @calories, @protein, @carbs, @fat, @is_fruit, @is_high_sugar, @notes)
  `);

  const insertMany = db.transaction((categories) => {
    for (const cat of categories) {
      // Перевіряємо, чи містить категорія вкладений список продуктів (items)
      if (cat.items && Array.isArray(cat.items)) {
        for (const item of cat.items) {
          insert.run({
            category_letter: cat.category || cat.category_letter || '',
            category_name: cat.title || cat.category_name || '',
            product_name: item.name || '',
            portion_size: parseInt(item.portion) || 0,
            calories: cat.calories || item.calories || 0,
            protein: item.protein || 0,
            carbs: item.carbs || 0,
            fat: item.fat || 0,
            is_fruit: cat.isFlexible ? 1 : 0,
            is_high_sugar: 0,
            notes: cat.mealName || null,
          });
        }
      } else {
        // Якщо масив вже плаский
        insert.run({
          category_letter: cat.category_letter || cat.category || '',
          category_name: cat.category_name || cat.title || '',
          product_name: cat.product_name || cat.name || '',
          portion_size: parseInt(cat.portion_size || cat.portion) || 0,
          calories: cat.calories || 0,
          protein: cat.protein || 0,
          carbs: cat.carbs || 0,
          fat: cat.fat || 0,
          is_fruit: cat.is_fruit ? 1 : 0,
          is_high_sugar: cat.is_high_sugar ? 1 : 0,
          notes: cat.notes || null,
        });
      }
    }
  });

  insertMany(seedData);
  return { seeded: true, count: seedData.length };
}

// ---------------------------------------------------------------------------
// User helpers

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

// All registered users — used by scheduled jobs that need to act on every
// user's data (evening summary, daily reset), not just the caller.
function listUsers() {
  return db.prepare('SELECT * FROM users').all();
}

// ---------------------------------------------------------------------------
// Product catalog helpers
// ---------------------------------------------------------------------------

function listCategories() {
  return db
    .prepare(`
      SELECT category_letter, MIN(category_name) AS category_name, COUNT(*) AS product_count
      FROM products
      GROUP BY category_letter
      ORDER BY category_letter
    `)
    .all();
}

function getProductsByCategory(categoryLetter) {
  return db
    .prepare('SELECT * FROM products WHERE category_letter = ? ORDER BY product_name')
    .all(categoryLetter);
}

function getProduct(productId) {
  return db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
}

// kcal for an arbitrary gram amount of a product, scaled from its stored portion
function computeCalories(product, grams) {
  if (!product || !product.portion_size) return 0;
  return Math.round(product.calories * (grams / product.portion_size) * 10) / 10;
}

// protein/carbs/fat (grams) for an arbitrary gram amount, scaled the same way
function computeMacros(product, grams) {
  if (!product || !product.portion_size) return { protein: 0, carbs: 0, fat: 0 };
  const ratio = grams / product.portion_size;
  return {
    protein: Math.round(product.protein * ratio * 10) / 10,
    carbs: Math.round(product.carbs * ratio * 10) / 10,
    fat: Math.round(product.fat * ratio * 10) / 10,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers shared by the "mark eaten" paths
// ---------------------------------------------------------------------------

function _getMealCategoryRows(userId, date, mealNumber, categoryLetter) {
  return db
    .prepare(`
      SELECT * FROM daily_logs
      WHERE user_id = ? AND log_date = ? AND meal_number = ? AND category_letter = ?
      ORDER BY created_at
    `)
    .all(userId, date, mealNumber, categoryLetter);
}

// Re-checks how much of a category has been used for a meal and updates
// is_completed on every row for that (meal, category) pair to match.
function _recalculateCompletion(userId, date, mealNumber, categoryLetter) {
  const rows = _getMealCategoryRows(userId, date, mealNumber, categoryLetter);
  const totalPct = rows.reduce((sum, r) => sum + r.portion_percentage, 0);
  const completed = totalPct >= 100 ? 1 : 0;

  if (rows.length) {
    const ids = rows.map((r) => r.id);
    db.prepare(`UPDATE daily_logs SET is_completed = ? WHERE id IN (${ids.map(() => '?').join(',')})`)
      .run(completed, ...ids);
  }

  return { totalPct, completed, rows: _getMealCategoryRows(userId, date, mealNumber, categoryLetter) };
}

// ---------------------------------------------------------------------------
// Marking items as eaten
// ---------------------------------------------------------------------------

// Normal path: pick a product from the catalog for a given meal/category.
// portionPercentage must be 100 (the whole category, done in one pick) or 50
// (half — leaving room for a second, different product to complete the
// other half, per the 50/50 rule).
function markItemEaten(userId, date, mealNumber, categoryLetter, { productId, portionPercentage = 100 }) {
  mealNumber = Number(mealNumber);
  portionPercentage = Number(portionPercentage);

  if (!Number.isInteger(mealNumber) || mealNumber < 1 || mealNumber > MEALS_PER_DAY) {
    throw new Error(`meal_number must be an integer between 1 and ${MEALS_PER_DAY}`);
  }
  if (!ALLOWED_PORTION_PERCENTAGES.includes(portionPercentage)) {
    throw new Error('portion_percentage must be 100 (full pick) or 50 (for the 50/50 rule)');
  }

  const product = getProduct(productId);
  if (!product) throw new Error('Unknown product_id');
  if (product.category_letter !== categoryLetter) {
    throw new Error(`Product belongs to category '${product.category_letter}', not '${categoryLetter}'`);
  }

  const existing = _getMealCategoryRows(userId, date, mealNumber, categoryLetter);
  const usedPct = existing.reduce((sum, r) => sum + r.portion_percentage, 0);

  if (usedPct >= 100) {
    throw new Error(`Category '${categoryLetter}' is already completed for meal ${mealNumber}`);
  }
  if (usedPct + portionPercentage > 100) {
    throw new Error(
      `That would exceed 100% for category '${categoryLetter}' in meal ${mealNumber} (already at ${usedPct}%)`
    );
  }
  if (existing.some((r) => r.product_id === product.id)) {
    throw new Error('The 50/50 rule requires the second half to be a different product');
  }

  const grams = product.portion_size * (portionPercentage / 100);
  const calories = computeCalories(product, grams);
  const macros = computeMacros(product, grams);

  const info = db
    .prepare(`
      INSERT INTO daily_logs
        (user_id, log_date, meal_number, category_letter, product_id, chosen_product, portion_percentage, grams, calories, protein, carbs, fat, is_swap, is_completed)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)
    `)
    .run(userId, date, mealNumber, categoryLetter, product.id, product.product_name, portionPercentage, grams, calories, macros.protein, macros.carbs, macros.fat);

  _recalculateCompletion(userId, date, mealNumber, categoryLetter);
  return db.prepare('SELECT * FROM daily_logs WHERE id = ?').get(info.lastInsertRowid);
}

// Swap path: use some (or all) of the category 'в' budget as fruit instead.
// originalGrams is how many grams of the 'в' allowance you're converting —
// must equal 50% or 100% of SWAP_CATEGORY_TOTAL_GRAMS, matching the 50/50 rule.
function markSwapEaten(userId, date, mealNumber, { fruitProductId, originalGrams }) {
  mealNumber = Number(mealNumber);
  originalGrams = Number(originalGrams);

  if (!Number.isInteger(mealNumber) || mealNumber < 1 || mealNumber > MEALS_PER_DAY) {
    throw new Error(`meal_number must be an integer between 1 and ${MEALS_PER_DAY}`);
  }

  const fruit = getProduct(fruitProductId);
  if (!fruit) throw new Error('Unknown fruit product_id');
  if (!fruit.is_fruit) {
    throw new Error(`'${fruit.product_name}' is not marked as a fruit; only fruit products can be used for the '${SWAP_CATEGORY_LETTER}' swap`);
  }

  const portionPercentage = Math.round((originalGrams / SWAP_CATEGORY_TOTAL_GRAMS) * 100);
  if (!ALLOWED_PORTION_PERCENTAGES.includes(portionPercentage)) {
    throw new Error(
      `originalGrams must equal 50% or 100% of the '${SWAP_CATEGORY_LETTER}' budget (${SWAP_CATEGORY_TOTAL_GRAMS}g total), per the 50/50 rule`
    );
  }

  const existing = _getMealCategoryRows(userId, date, mealNumber, SWAP_CATEGORY_LETTER);
  const usedPct = existing.reduce((sum, r) => sum + r.portion_percentage, 0);

  if (usedPct >= 100) {
    throw new Error(`Category '${SWAP_CATEGORY_LETTER}' is already completed for meal ${mealNumber}`);
  }
  if (usedPct + portionPercentage > 100) {
    throw new Error(`That would exceed the '${SWAP_CATEGORY_LETTER}' budget for meal ${mealNumber}`);
  }

  const ratio = fruit.is_high_sugar ? HIGH_SUGAR_FRUIT_RATIO : STANDARD_FRUIT_RATIO;
  const equivalentGrams = originalGrams * ratio;
  const calories = computeCalories(fruit, equivalentGrams);
  const macros = computeMacros(fruit, equivalentGrams);

  const info = db
    .prepare(`
      INSERT INTO daily_logs
        (user_id, log_date, meal_number, category_letter, product_id, chosen_product, portion_percentage, grams, calories, protein, carbs, fat, is_swap, is_completed)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0)
    `)
    .run(
      userId, date, mealNumber, SWAP_CATEGORY_LETTER, fruit.id,
      `${fruit.product_name} (swap for ${SWAP_CATEGORY_LETTER})`,
      portionPercentage, equivalentGrams, calories, macros.protein, macros.carbs, macros.fat
    );

  _recalculateCompletion(userId, date, mealNumber, SWAP_CATEGORY_LETTER);
  return db.prepare('SELECT * FROM daily_logs WHERE id = ?').get(info.lastInsertRowid);
}

// Move an already-logged entry to a different meal (the "rotation" rule —
// categories/items aren't locked to one meal). Refuses the move if the
// category doesn't have room left in the target meal.
function moveLogEntry(userId, logId, newMealNumber) {
  newMealNumber = Number(newMealNumber);
  if (!Number.isInteger(newMealNumber) || newMealNumber < 1 || newMealNumber > MEALS_PER_DAY) {
    throw new Error(`meal_number must be an integer between 1 and ${MEALS_PER_DAY}`);
  }

  const row = db.prepare('SELECT * FROM daily_logs WHERE id = ? AND user_id = ?').get(logId, userId);
  if (!row) throw new Error('Log entry not found');
  if (row.meal_number === newMealNumber) return row;

  const existingAtTarget = _getMealCategoryRows(userId, row.log_date, newMealNumber, row.category_letter);
  const usedPct = existingAtTarget.reduce((sum, r) => sum + r.portion_percentage, 0);
  if (usedPct + row.portion_percentage > 100) {
    throw new Error(`Category '${row.category_letter}' doesn't have room in meal ${newMealNumber} (already at ${usedPct}%)`);
  }

  const oldMealNumber = row.meal_number;
  db.prepare('UPDATE daily_logs SET meal_number = ? WHERE id = ?').run(newMealNumber, logId);

  _recalculateCompletion(userId, row.log_date, oldMealNumber, row.category_letter);
  _recalculateCompletion(userId, row.log_date, newMealNumber, row.category_letter);

  return db.prepare('SELECT * FROM daily_logs WHERE id = ?').get(logId);
}

// Move all log rows for a category from one meal to another (the "rotation"
// rule — categories aren't locked to a meal). Fails if the target meal
// already has entries for that category, so you don't silently merge two
// different picks together.
function moveCategoryEntries(userId, date, categoryLetter, fromMeal, toMeal) {
  fromMeal = Number(fromMeal);
  toMeal = Number(toMeal);

  if (![1, 2, 3, 4].includes(fromMeal) || ![1, 2, 3, 4].includes(toMeal)) {
    throw new Error(`meal_number must be between 1 and ${MEALS_PER_DAY}`);
  }
  if (fromMeal === toMeal) throw new Error('Source and target meal are the same');

  const sourceRows = _getMealCategoryRows(userId, date, fromMeal, categoryLetter);
  if (!sourceRows.length) {
    throw new Error(`No '${categoryLetter}' entries logged in meal ${fromMeal} to move`);
  }

  const targetRows = _getMealCategoryRows(userId, date, toMeal, categoryLetter);
  if (targetRows.length) {
    throw new Error(`Meal ${toMeal} already has '${categoryLetter}' entries — remove them first`);
  }

  const ids = sourceRows.map((r) => r.id);
  db.prepare(`UPDATE daily_logs SET meal_number = ? WHERE id IN (${ids.map(() => '?').join(',')})`)
    .run(toMeal, ...ids);

  _recalculateCompletion(userId, date, fromMeal, categoryLetter);
  _recalculateCompletion(userId, date, toMeal, categoryLetter);

  return { moved: ids.length, from_meal: fromMeal, to_meal: toMeal, category_letter: categoryLetter };
}

// Undo a single log entry (and re-checks completion for what's left).
function deleteLogEntry(userId, logId) {
  const row = db.prepare('SELECT * FROM daily_logs WHERE id = ? AND user_id = ?').get(logId, userId);
  if (!row) throw new Error('Log entry not found');

  db.prepare('DELETE FROM daily_logs WHERE id = ?').run(logId);
  _recalculateCompletion(userId, row.log_date, row.meal_number, row.category_letter);
  return { deleted: true, id: logId };
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

// Full picture of a given day: every meal, every category touched in it,
// completion state, and calories/macros vs the daily targets.
function getTodayStatus(userId, date) {
  const rows = db
    .prepare(`
      SELECT * FROM daily_logs
      WHERE user_id = ? AND log_date = ?
      ORDER BY meal_number, category_letter, created_at
    `)
    .all(userId, date);

  const meals = [1, 2, 3, 4].map((mealNumber) => {
    const mealRows = rows.filter((r) => r.meal_number === mealNumber);

    const categoriesMap = {};
    for (const r of mealRows) {
      if (!categoriesMap[r.category_letter]) {
        categoriesMap[r.category_letter] = {
          category_letter: r.category_letter,
          portion_used: 0,
          calories: 0,
          protein: 0,
          carbs: 0,
          fat: 0,
          is_completed: false,
          entries: [],
        };
      }
      const cat = categoriesMap[r.category_letter];
      cat.entries.push(r);
      cat.portion_used += r.portion_percentage;
      cat.calories += r.calories;
      cat.protein += r.protein;
      cat.carbs += r.carbs;
      cat.fat += r.fat;
      cat.is_completed = !!r.is_completed;
    }

    return {
      meal_number: mealNumber,
      calories: mealRows.reduce((sum, r) => sum + r.calories, 0),
      protein: mealRows.reduce((sum, r) => sum + r.protein, 0),
      carbs: mealRows.reduce((sum, r) => sum + r.carbs, 0),
      fat: mealRows.reduce((sum, r) => sum + r.fat, 0),
      categories: Object.values(categoriesMap),
    };
  });

  const round1 = (n) => Math.round(n * 10) / 10;
  const totalCalories = rows.reduce((sum, r) => sum + r.calories, 0);
  const totalProtein = rows.reduce((sum, r) => sum + r.protein, 0);
  const totalCarbs = rows.reduce((sum, r) => sum + r.carbs, 0);
  const totalFat = rows.reduce((sum, r) => sum + r.fat, 0);

  return {
    date,
    daily_calorie_target: DAILY_CALORIE_TARGET,
    total_calories: round1(totalCalories),
    remaining_calories: round1(DAILY_CALORIE_TARGET - totalCalories),
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
    meals,
  };
}

// Clears all logged entries for a user on a given date (defaults to today),
// so they can start that day over.
function resetDailyState(userId, date) {
  const info = db.prepare('DELETE FROM daily_logs WHERE user_id = ? AND log_date = ?').run(userId, date);
  return { date, deleted: info.changes };
}

// ---------------------------------------------------------------------------
// Boot: make sure the catalog has something in it
// ---------------------------------------------------------------------------

seedProductsIfEmpty();

module.exports = {
  db,
  // config, exported so server.js/app.js can stay in sync with these rules
  DAILY_CALORIE_TARGET,
  PROTEIN_TARGET_G,
  CARBS_TARGET_G,
  FAT_TARGET_G,
  MEALS_PER_DAY,
  SWAP_CATEGORY_LETTER,
  SWAP_CATEGORY_TOTAL_GRAMS,
  // users
  getOrCreateUser,
  listUsers,
  // catalog
  listCategories,
  getProductsByCategory,
  getProduct,
  seedProductsIfEmpty,
  // logging
  markItemEaten,
  markSwapEaten,
  moveLogEntry,
  moveCategoryEntries,
  deleteLogEntry,
  getTodayStatus,
  resetDailyState,
};
