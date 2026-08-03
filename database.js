const Database = require('better-sqlite3');
const path = require('path');
const seedData = require('./seed-data');

const dbPath = path.join(__dirname, 'diet.db');
const db = new Database(dbPath);

// Налаштування таблиць бази даних
db.exec(`
  CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    emoji TEXT NOT NULL,
    target_calories INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    max_grams INTEGER NOT NULL,
    unit TEXT DEFAULT 'г',
    FOREIGN KEY (category_id) REFERENCES categories(id)
  );

  CREATE TABLE IF NOT EXISTS daily_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    product_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    logged_grams REAL DEFAULT 0,
    FOREIGN KEY (product_id) REFERENCES products(id),
    UNIQUE(user_id, product_id, date)
  );
`);

function seedDatabase() {
  db.prepare('DELETE FROM products').run();
  db.prepare('DELETE FROM categories').run();

  const insertCategory = db.prepare(`
    INSERT INTO categories (id, name, emoji, target_calories)
    VALUES (@id, @name, @emoji, @targetCalories)
  `);

  const insertProduct = db.prepare(`
    INSERT INTO products (category_id, name, max_grams, unit)
    VALUES (@categoryId, @name, @maxGrams, @unit)
  `);

  const transaction = db.transaction((data) => {
    for (const cat of data) {
      insertCategory.run({
        id: cat.id,
        name: cat.category,
        emoji: cat.emoji,
        targetCalories: cat.targetCalories
      });

      for (const item of cat.items) {
        insertProduct.run({
          categoryId: cat.id,
          name: item.name,
          maxGrams: item.maxGrams,
          unit: item.unit
        });
      }
    }
  });

  transaction(seedData);
}

seedDatabase();

function getTodaySummary(userId, dateStr) {
  const categories = db.prepare('SELECT * FROM categories ORDER BY id ASC').all();
  const products = db.prepare(`
    SELECT p.*, COALESCE(l.logged_grams, 0) AS logged_grams
    FROM products p
    LEFT JOIN daily_logs l ON p.id = l.product_id AND l.user_id = ? AND l.date = ?
  `).all(userId, dateStr);

  let totalTargetCalories = 0;
  let totalConsumedCalories = 0;

  const categorySummaries = categories.map((cat) => {
    totalTargetCalories += cat.target_calories;
    const catProducts = products.filter((p) => p.category_id === cat.id);

    let usageRatio = 0;
    catProducts.forEach((p) => {
      if (p.max_grams > 0) {
        usageRatio += p.logged_grams / p.max_grams;
      }
    });

    const consumedCalories = Math.round(cat.target_calories * usageRatio);
    totalConsumedCalories += consumedCalories;

    return {
      id: cat.id,
      name: cat.name,
      emoji: cat.emoji,
      targetCalories: cat.target_calories,
      consumedCalories,
      usagePercentage: Math.round(usageRatio * 100),
      isCompleted: usageRatio >= 1.0,
      isOverconsumed: usageRatio > 1.0,
      products: catProducts.map((p) => ({
        id: p.id,
        name: p.name,
        maxGrams: p.max_grams,
        unit: p.unit,
        loggedGrams: p.logged_grams,
        remainingGrams: Math.max(0, p.max_grams - p.logged_grams)
      }))
    };
  });

  return {
    date: dateStr,
    totalTargetCalories,
    totalConsumedCalories,
    totalPercentage: Math.round((totalConsumedCalories / totalTargetCalories) * 100) || 0,
    categories: categorySummaries
  };
}

function logGrams(userId, productId, grams, dateStr) {
  const existing = db.prepare(`
    SELECT logged_grams FROM daily_logs WHERE user_id = ? AND product_id = ? AND date = ?
  `).get(userId, productId, dateStr);

  const newTotal = (existing ? existing.logged_grams : 0) + Number(grams);

  db.prepare(`
    INSERT INTO daily_logs (user_id, product_id, date, logged_grams)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, product_id, date) DO UPDATE SET logged_grams = excluded.logged_grams
  `).run(userId, productId, dateStr, newTotal);

  return getTodaySummary(userId, dateStr);
}

function resetToday(userId, dateStr) {
  db.prepare('DELETE FROM daily_logs WHERE user_id = ? AND date = ?').run(userId, dateStr);
  return getTodaySummary(userId, dateStr);
}

module.exports = {
  getTodaySummary,
  logGrams,
  resetToday
};
