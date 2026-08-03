const seedData = [
  {
    id: 1,
    category: 'Гарнір',
    emoji: '🌾',
    targetCalories: 360,
    items: [
      { name: 'Бобові', maxGrams: 100, unit: 'г' },
      { name: 'Картопля', maxGrams: 360, unit: 'г' },
      { name: 'Кукурудза свіжа', maxGrams: 360, unit: 'г' },
      { name: 'Рис (нешліфований)', maxGrams: 100, unit: 'г' },
      { name: 'Будь-яка крупа', maxGrams: 100, unit: 'г' },
      { name: 'Цільнозернове борошно', maxGrams: 100, unit: 'г' },
      { name: 'Хлібці', maxGrams: 160, unit: 'г' },
      { name: 'Цільнозерновий хліб', maxGrams: 170, unit: 'г' },
      { name: 'Макарони т.с.', maxGrams: 100, unit: 'г' },
      { name: 'Лаваш', maxGrams: 160, unit: 'г' }
    ]
  },
  {
    id: 2,
    category: 'Молочні продукти',
    emoji: '🥛',
    targetCalories: 260,
    items: [
      { name: 'Сир зернистий 0.2%', maxGrams: 355, unit: 'г' },
      { name: 'Сири м‘які, тверді, плавлені', maxGrams: 72, unit: 'г' },
      { name: 'Сметана 15%', maxGrams: 145, unit: 'г' },
      { name: 'Кефір 1%', maxGrams: 630, unit: 'г' },
      { name: 'Несолодкий йогурт 1%', maxGrams: 600, unit: 'г' },
      { name: 'Молоко 1%', maxGrams: 650, unit: 'г' }
    ]
  },
  {
    id: 3,
    category: 'Свобода вибору / Будь-чого',
    emoji: '🍕',
    targetCalories: 425,
    items: [
      { name: 'Солодощі, снеки, ковбаса тощо', maxGrams: 85, unit: 'г' }
    ]
  },
  {
    id: 4,
    category: "М'ясо / Риба / Яйця",
    emoji: '🍗',
    targetCalories: 400,
    items: [
      { name: 'Телятина', maxGrams: 320, unit: 'г' },
      { name: 'Печінка', maxGrams: 320, unit: 'г' },
      { name: 'Куряче або індиче філе', maxGrams: 380, unit: 'г' },
      { name: 'Риба (до 5% жиру)', maxGrams: 370, unit: 'г' },
      { name: 'Риба (від 5% жиру)', maxGrams: 250, unit: 'г' },
      { name: 'Яйця', maxGrams: 6, unit: 'шт' },
      { name: 'Морепродукти', maxGrams: 440, unit: 'г' }
    ]
  },
  {
    id: 5,
    category: 'Овочі та гриби',
    emoji: '🥦',
    targetCalories: 120,
    items: [
      { name: 'Овочі квашені або зелень', maxGrams: 600, unit: 'г' },
      { name: 'Гриби', maxGrams: 600, unit: 'г' }
    ]
  },
  {
    id: 6,
    category: 'Жири та соуси',
    emoji: '🥑',
    targetCalories: 220,
    items: [
      { name: 'Будь-яка олія (рекомендуємо лляну)', maxGrams: 24, unit: 'г' },
      { name: 'Авокадо', maxGrams: 130, unit: 'г' },
      { name: 'Оливки', maxGrams: 160, unit: 'г' },
      { name: 'Гірчиця', maxGrams: 56, unit: 'г' },
      { name: 'Майонез', maxGrams: 30, unit: 'г' },
      { name: 'Кетчуп', maxGrams: 84, unit: 'г' },
      { name: 'Вершкове масло', maxGrams: 28, unit: 'г' },
      { name: 'Сало', maxGrams: 20, unit: 'г' }
    ]
  },
  {
    id: 7,
    category: 'Фрукти та ягоди',
    emoji: '🍎',
    targetCalories: 290,
    items: [
      { name: 'Фрукти та ягоди', maxGrams: 400, unit: 'г' },
      { name: 'Банани, виноград, хурма', maxGrams: 240, unit: 'г' }
    ]
  },
  {
    id: 8,
    category: 'Горіхи та насіння',
    emoji: '🥜',
    targetCalories: 145,
    items: [
      { name: 'Горіхи', maxGrams: 20, unit: 'г' },
      { name: 'Насіння', maxGrams: 20, unit: 'г' }
    ]
  }
];

module.exports = seedData;
