// seed-data.js
// -----------------------------------------------------------------------------
// This is the starting list of products for the diet tracker. It is loaded
// into the `products` table automatically the first time the app runs (see
// seedProductsIfEmpty() in database.js), but ONLY if the table is empty — so
// editing this file later and restarting the app will NOT overwrite data you
// already have. To reload from scratch, clear the `products` table yourself.
//
// This file is plain data (an array of objects) — no programming knowledge
// needed to edit it. Copy a line, change the values, done.
//
// Fields for every product:
//   category_letter  the single-letter (or symbol) category it belongs to
//   category_name    human-readable label for the category (shown in the UI)
//   product_name     what shows up in the app
//   portion_size     how many grams the calorie/macro numbers below refer to
//   calories         kcal for that portion_size
//   protein          grams of protein for that portion_size
//   carbs            grams of carbs for that portion_size
//   fat              grams of fat for that portion_size
//   is_fruit         true ONLY for fruit items used in the category 'в' swap
//   is_high_sugar    true ONLY for high-sugar fruits (banana, grapes,
//                    persimmon, ...) — these use the 50g swap ratio instead
//                    of the standard 100g ratio
//   notes            anything you want to remember about this item
// -----------------------------------------------------------------------------

const LETTERS = 'abcdefghijklmnopqrstuvwxy'.split(''); // a through y, 25 categories

// One placeholder product per category so the app isn't empty on first run.
// REPLACE these with the real items (and real macro numbers) from your plan.
const placeholders = LETTERS.map((letter) => ({
  category_letter: letter,
  category_name: `Category ${letter.toUpperCase()} — TODO: rename me`,
  product_name: `TODO: add a real product for category ${letter}`,
  portion_size: 100,
  calories: 0,
  protein: 0,
  carbs: 0,
  fat: 0,
  is_fruit: false,
  is_high_sugar: false,
  notes: 'Placeholder — replace with an item from your real diet plan.',
}));

// Category 'в' — the 425 kcal snacks/sweets budget that can be swapped for
// fruit. NOTE: 'в' is a Cyrillic letter, kept exactly as you specified it —
// if your real category list actually uses a Latin letter for this slot
// (e.g. 'b'), just change SWAP_CATEGORY_LETTER in database.js to match, and
// update category_letter below to the same value.
const categoryV = [
  {
    category_letter: 'в',
    category_name: 'Snacks / Sweets (425 kcal budget)',
    product_name: 'TODO: add your real 425 kcal snack/sweet option',
    portion_size: 100,
    calories: 425,
    protein: 0,
    carbs: 0,
    fat: 0,
    is_fruit: false,
    is_high_sugar: false,
    notes: 'Placeholder — replace with a real snack/sweet from your plan.',
  },
];

// Fruits usable for the 'в' swap. Figures are standard per-100g reference
// values — double-check them against your own source if it matters for your
// plan. is_high_sugar = true means the 50g ratio applies instead of the
// 100g ratio when swapping.
const fruits = [
  { category_letter: 'fruit', category_name: 'Fruits (для заміни в)', product_name: 'Apple',     portion_size: 100, calories: 52, protein: 0.3, carbs: 14, fat: 0.2, is_fruit: true, is_high_sugar: false },
  { category_letter: 'fruit', category_name: 'Fruits (для заміни в)', product_name: 'Orange',    portion_size: 100, calories: 47, protein: 0.9, carbs: 12, fat: 0.1, is_fruit: true, is_high_sugar: false },
  { category_letter: 'fruit', category_name: 'Fruits (для заміни в)', product_name: 'Pear',      portion_size: 100, calories: 57, protein: 0.4, carbs: 15, fat: 0.1, is_fruit: true, is_high_sugar: false },
  { category_letter: 'fruit', category_name: 'Fruits (для заміни в)', product_name: 'Kiwi',      portion_size: 100, calories: 61, protein: 1.1, carbs: 15, fat: 0.5, is_fruit: true, is_high_sugar: false },
  { category_letter: 'fruit', category_name: 'Fruits (для заміни в)', product_name: 'Banana',    portion_size: 100, calories: 89, protein: 1.1, carbs: 23, fat: 0.3, is_fruit: true, is_high_sugar: true },
  { category_letter: 'fruit', category_name: 'Fruits (для заміни в)', product_name: 'Grapes',    portion_size: 100, calories: 69, protein: 0.6, carbs: 18, fat: 0.2, is_fruit: true, is_high_sugar: true },
  { category_letter: 'fruit', category_name: 'Fruits (для заміни в)', product_name: 'Persimmon', portion_size: 100, calories: 70, protein: 0.6, carbs: 19, fat: 0.2, is_fruit: true, is_high_sugar: true },
];

module.exports = [...placeholders, ...categoryV, ...fruits];
