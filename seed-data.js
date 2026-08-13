// seed-data.js
// -----------------------------------------------------------------------------
// Starting product list for the Flexible Daily Grams Budget Tracker. Loaded
// into `products` automatically on first run (see seedProductsIfEmpty() in
// database.js) — ONLY if the table is empty, so editing this later and
// restarting won't overwrite data you already have.
//
// Each product belongs to one of the fixed categories (see CATEGORIES_META in
// database.js — category_key here must match one of: garnish, dairy,
// freebie, protein, veggies, fats, fruits, nuts, junk_food).
//
// junk_food ("Погане їдло") deliberately has NO items below — it's logged
// through a direct kcal-entry sheet in app.js (JUNK_KEY), not through
// max_grams products, so there's nothing product-shaped to seed here. It's
// still declared in CATEGORIES_META so its calories flow through the normal
// category pipeline (sync payload, Turso, evening report).
//
// Fields:
//   category_key   one of the 8 fixed keys above
//   product_name   what shows up in the app
//   max_grams      daily allowance — grams, or a quantity when unit isn't 'г'
//   unit           'г' (grams) by default, or e.g. 'шт' for pieces (eggs)
//   protein/carbs/fat   macros for eating the FULL max_grams of this item —
//                       the app scales these down by however much is
//                       actually logged
//   notes          anything worth flagging
//
// MACRO CAVEAT: you gave gram allowances and category kcal targets, not
// macros — protein/carbs/fat below are my estimates from standard nutrition
// reference values, scaled to each item's max_grams. Where a category here
// is exactly the combination of two categories from the previous meal-based
// version (see the comments below), I summed those already-estimated macros
// rather than re-deriving from scratch, so the numbers stay internally
// consistent — but they're still estimates to verify, not data you provided.
// -----------------------------------------------------------------------------

function cat(items, categoryKey) {
  return items.map((item) => ({ category_key: categoryKey, unit: 'г', protein: 0, carbs: 0, fat: 0, notes: null, ...item }));
}

// --- 1. Гарнір (~360 ккал) — was the old "carbs" category at ~180 ккал,
// every gram amount here is exactly double (this food group used to appear
// at breakfast AND lunch; now it's one consolidated daily allowance). ---
const GARNISH = cat([
  { product_name: 'Бобові (варені)', max_grams: 100, protein: 24, carbs: 60, fat: 2 },
  { product_name: 'Картопля', max_grams: 360, protein: 7.2, carbs: 66, fat: 0.4 },
  { product_name: 'Кукурудза свіжа', max_grams: 360, protein: 11.6, carbs: 68, fat: 4 },
  { product_name: 'Рис (не шліфований), сухий', max_grams: 100, protein: 7.6, carbs: 76, fat: 3 },
  { product_name: 'Будь-яка крупа, суха', max_grams: 100, protein: 12, carbs: 70, fat: 3 },
  { product_name: 'Цільнозернове борошно', max_grams: 100, protein: 13, carbs: 72, fat: 2 },
  { product_name: 'Хлібці', max_grams: 160, protein: 10, carbs: 70, fat: 3 },
  { product_name: 'Цільнозерновий хліб', max_grams: 170, protein: 14, carbs: 66, fat: 4 },
  { product_name: 'Макарони т.с. (тверді сорти), сухі', max_grams: 100, protein: 13, carbs: 72, fat: 1.6 },
  { product_name: 'Лаваш', max_grams: 160, protein: 12, carbs: 70, fat: 2 },
], 'garnish');

// --- 2. Молочні продукти (~260 ккал) — the sum of the two old dairy
// categories (breakfast ~110 ккал + snack ~150 ккал portions combined). ---
const DAIRY = cat([
  { product_name: 'Сир зернистий (творог нежирний) 0,2%', max_grams: 355, protein: 61, carbs: 12, fat: 1.1 },
  { product_name: 'Сир м\u2019який/твердий/плавлений', max_grams: 72, protein: 17, carbs: 2, fat: 21 },
  { product_name: 'Сметана 15%', max_grams: 145, protein: 5, carbs: 5, fat: 22 },
  { product_name: 'Кефір 1%', max_grams: 630, protein: 21, carbs: 28, fat: 6.3 },
  { product_name: 'Несолодкий йогурт 1%', max_grams: 600, protein: 29, carbs: 31, fat: 6 },
  { product_name: 'Молоко 1%', max_grams: 650, protein: 21, carbs: 30, fat: 6.5 },
], 'dairy');

// --- 3. Будь-чого (~425 ккал) ---
const FREEBIE = cat([
  { product_name: 'Солодощі', max_grams: 85, protein: 4, carbs: 55, fat: 20 },
  { product_name: 'Снеки', max_grams: 85, protein: 5, carbs: 45, fat: 25 },
  { product_name: 'Ковбаса, тощо', max_grams: 85, protein: 20, carbs: 3, fat: 38 },
], 'freebie');

// --- 4. М'ясо / Риба / Яйця (~400 ккал) — was old "protein" category
// (~200 ккал) used at both lunch and dinner; grams and macros doubled. ---
const PROTEIN = cat([
  { product_name: 'Телятина', max_grams: 320, protein: 74, carbs: 0, fat: 8 },
  { product_name: 'Печінка', max_grams: 320, protein: 60, carbs: 16, fat: 10 },
  { product_name: 'Куряче або індиче філе', max_grams: 380, protein: 88, carbs: 0, fat: 4 },
  { product_name: 'Риба (до 5% жиру)', max_grams: 370, protein: 80, carbs: 0, fat: 6 },
  { product_name: 'Риба (від 5% жиру)', max_grams: 250, protein: 48, carbs: 0, fat: 20 },
  { product_name: 'Яйця', max_grams: 6, unit: 'шт', protein: 36, carbs: 2, fat: 30 },
  { product_name: 'Морепродукти', max_grams: 440, protein: 76, carbs: 8, fat: 6 },
], 'protein');

// --- 5. Овочі та гриби (~120 ккал) — old veggies category (~60 ккал)
// doubled; the old separate "greens" line is folded into the veggies line. ---
const VEGGIES = cat([
  { product_name: 'Овочі квашені або зелень', max_grams: 600, protein: 6, carbs: 24, fat: 1 },
  { product_name: 'Гриби', max_grams: 600, protein: 12, carbs: 14, fat: 1.8 },
], 'veggies');

// --- 6. Жири та соуси (~220 ккал) — old fats category (~110 ккал) doubled. ---
const FATS = cat([
  { product_name: 'Будь-яка олія (рекомендуємо лляну)', max_grams: 24, protein: 0, carbs: 0, fat: 24 },
  { product_name: 'Авокадо', max_grams: 130, protein: 2.8, carbs: 12, fat: 20 },
  { product_name: 'Оливки', max_grams: 160, protein: 1.6, carbs: 10, fat: 20 },
  { product_name: 'Гірчиця', max_grams: 56, protein: 2, carbs: 4, fat: 6, notes: 'Перевірте калорійність — 220 ккал на 56г виглядає високо для гірчиці.' },
  { product_name: 'Майонез', max_grams: 30, protein: 0.4, carbs: 1, fat: 22 },
  { product_name: 'Кетчуп', max_grams: 84, protein: 1, carbs: 20, fat: 0.2, notes: 'Перевірте калорійність — 220 ккал на 84г виглядає високо для кетчупу.' },
  { product_name: 'Вершкове масло', max_grams: 28, protein: 0.2, carbs: 0, fat: 22 },
  { product_name: 'Сало', max_grams: 20, protein: 0.6, carbs: 0, fat: 20 },
], 'fats');

// --- 7. Фрукти та ягоди (~290 ккал) — unchanged from the previous version:
// 400г for standard fruit, 240г for high-sugar (banana/grapes/persimmon). ---
const FRUITS = cat([
  { product_name: 'Яблуко', max_grams: 400, protein: 1.2, carbs: 56, fat: 0.8 },
  { product_name: 'Апельсин', max_grams: 400, protein: 3.6, carbs: 48, fat: 0.4 },
  { product_name: 'Груша', max_grams: 400, protein: 1.6, carbs: 60, fat: 0.4 },
  { product_name: 'Ківі', max_grams: 400, protein: 4.4, carbs: 60, fat: 2 },
  { product_name: 'Банан (солодкий фрукт)', max_grams: 240, protein: 2.6, carbs: 55, fat: 0.7 },
  { product_name: 'Виноград (солодкий фрукт)', max_grams: 240, protein: 1.4, carbs: 43, fat: 0.5 },
  { product_name: 'Хурма (солодкий фрукт)', max_grams: 240, protein: 1.4, carbs: 46, fat: 0.5 },
], 'fruits');

// --- 8. Горіхи та насіння (~145 ккал) — unchanged from the previous
// version, consolidated to the plan's simpler 2-line structure. ---
const NUTS = cat([
  { product_name: 'Горіхи (рекомендуємо волоські)', max_grams: 20, protein: 3, carbs: 2.7, fat: 13 },
  { product_name: 'Насіння', max_grams: 20, protein: 4, carbs: 4, fat: 11 },
], 'nuts');

module.exports = [
  ...GARNISH,
  ...DAIRY,
  ...FREEBIE,
  ...PROTEIN,
  ...VEGGIES,
  ...FATS,
  ...FRUITS,
  ...NUTS,
];
