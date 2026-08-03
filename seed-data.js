const seedData = [
  // ==========================================
  // 🌅 1-й ПРИЙОМ ЇЖІ (СНІДАНОК)
  // ==========================================
  {
    category: 'а',
    meal: 1,
    mealName: 'Сніданок',
    title: '🌾 Складні вуглеводи / Крупи / Хліб',
    calories: 180,
    items: [
      { name: 'Бобові', portion: '50 г' },
      { name: 'Картопля', portion: '180 г' },
      { name: 'Кукурудза свіжа', portion: '180 г' },
      { name: 'Рис (нешліфований)', portion: '50 г' },
      { name: 'Будь-яка крупа', portion: '50 г' },
      { name: 'Цільнозернове борошно', portion: '50 г' },
      { name: 'Хлібці', portion: '80 г' },
      { name: 'Цільнозерновий хліб', portion: '85 г' },
      { name: 'Макарони т.с.', portion: '50 г' },
      { name: 'Лаваш', portion: '80 г' }
    ]
  },
  {
    category: 'б',
    meal: 1,
    mealName: 'Сніданок',
    title: '🥛 Кисломолочні продукти / Сир',
    calories: 110,
    items: [
      { name: 'Сир зернистий (творог 0.2%)', portion: '150 г' },
      { name: 'Сири м‘які, тверді, плавлені', portion: '30 г' },
      { name: 'Сметани 15%', portion: '60 г' },
      { name: 'Кефір 1%', portion: '270 г' },
      { name: 'Несолодкий йогурт 1%', portion: '250 г' },
      { name: 'Молоко 1%', portion: '280 г' }
    ]
  },
  {
    category: 'в',
    meal: 1,
    mealName: 'Сніданок',
    title: '🍕 Свобода вибору / Солодощі / Снеки',
    calories: 425,
    isFlexible: true, // Дозволяє заміну на фрукти
    items: [
      { name: 'Будь-чого (солодощі, снеки, ковбаса тощо)', portion: '85 г' }
    ]
  },

  // ==========================================
  // ☀️ 2-й ПРИЙОМ ЇЖІ (ОБІД)
  // ==========================================
  {
    category: 'г',
    meal: 2,
    mealName: 'Обід',
    title: '🥔 Складні вуглеводи / Крупи',
    calories: 180,
    items: [
      { name: 'Бобові', portion: '50 г' },
      { name: 'Картопля', portion: '180 г' },
      { name: 'Кукурудза свіжа', portion: '180 г' },
      { name: 'Рис (нешліфований)', portion: '50 г' },
      { name: 'Будь-яка крупа', portion: '50 г' },
      { name: 'Цільнозернове борошно', portion: '50 г' },
      { name: 'Хлібці', portion: '80 г' },
      { name: 'Цільнозерновий хліб', portion: '85 г' },
      { name: 'Макарони т.с.', portion: '50 г' },
      { name: 'Лаваш', portion: '80 г' }
    ]
  },
  {
    category: 'д',
    meal: 2,
    mealName: 'Обід',
    title: '🍗 М’ясо / Птиця / Риба / Яйця',
    calories: 200,
    items: [
      { name: 'Телятина', portion: '160 г' },
      { name: 'Печінка', portion: '160 г' },
      { name: 'Куряче або індиче філе', portion: '190 г' },
      { name: 'Риба (до 5% жиру)', portion: '185 г' },
      { name: 'Риба (від 5% жиру)', portion: '125 г' },
      { name: 'Яйця', portion: '3 шт' },
      { name: 'Морепродукти', portion: '220 г' }
    ]
  },
  {
    category: 'е',
    meal: 2,
    mealName: 'Обід',
    title: '🥦 Овочі / Гриби / Зелень',
    calories: 60,
    items: [
      { name: 'Овочі (свіжі, квашені), зелень', portion: '300 г' },
      { name: 'Гриби', portion: '300 г' }
    ]
  },
  {
    category: 'є',
    meal: 2,
    mealName: 'Обід',
    title: '🥑 Корисні жири / Олія / Соуси',
    calories: 110,
    items: [
      { name: 'Будь-яка олія (рекомендуємо лляну)', portion: '12 г' },
      { name: 'Авокадо', portion: '65 г' },
      { name: 'Оливки', portion: '80 г' },
      { name: 'Гірчиця', portion: '28 г' },
      { name: 'Майонез', portion: '15 г' },
      { name: 'Кетчуп', portion: '42 г' },
      { name: 'Вершкове масло', portion: '14 г' },
      { name: 'Сало', portion: '10 г' }
    ]
  },

  // ==========================================
  // ☕ 3-й ПРИЙОМ ЇЖІ (ПЕРЕКУС / ЛАНЧ)
  // ==========================================
  {
    category: 'ж',
    meal: 3,
    mealName: 'Перекус',
    title: '🥛 Кисломолочні продукти / Йогурт',
    calories: 150,
    items: [
      { name: 'Сир зернистий (творог 0.2%)', portion: '205 г' },
      { name: 'Сири м‘які, тверді, плавлені', portion: '42 г' },
      { name: 'Сметани 15%', portion: '85 г' },
      { name: 'Кефір 1%', portion: '360 г' },
      { name: 'Несолодкий йогурт 1%', portion: '345 г' },
      { name: 'Молоко 1%', portion: '370 г' }
    ]
  },
  {
    category: 'з',
    meal: 3,
    mealName: 'Перекус',
    title: '🍎 Фрукти та ягоди',
    calories: 290,
    items: [
      { name: 'Стандартні фрукти та ягоди', portion: '400 г' },
      { name: 'Солодкі фрукти (банани, виноград, хурма)', portion: '240 г' }
    ]
  },
  {
    category: 'и',
    meal: 3,
    mealName: 'Перекус',
    title: '🥜 Горіхи / Насіння',
    calories: 145,
    items: [
      { name: 'Будь-які горіхи (рекомендуємо грецькі)', portion: '20 г' },
      { name: 'Насіння', portion: '20 г' }
    ]
  },

  // ==========================================
  // 🌙 4-й ПРИЙОМ ЇЖІ (ВЕЧЕРЯ)
  // ==========================================
  {
    category: 'і',
    meal: 4,
    mealName: 'Вечеря',
    title: '🥩 М’ясо / Птиця / Риба / Яйця',
    calories: 200,
    items: [
      { name: 'Телятина', portion: '160 г' },
      { name: 'Печінка', portion: '160 г' },
      { name: 'Куряче або індиче філе', portion: '190 г' },
      { name: 'Риба (до 5% жиру)', portion: '185 г' },
      { name: 'Риба (від 5% жиру)', portion: '125 г' },
      { name: 'Яйця', portion: '3 шт' },
      { name: 'Морепродукти', portion: '220 г' }
    ]
  },
  {
    category: 'ї',
    meal: 4,
    mealName: 'Вечеря',
    title: '🥗 Овочі / Гриби / Зелень',
    calories: 60,
    items: [
      { name: 'Овочі (свіжі, квашені), зелень', portion: '300 г' },
      { name: 'Гриби', portion: '300 г' }
    ]
  },
  {
    category: 'й',
    meal: 4,
    mealName: 'Вечеря',
    title: '🥑 Корисні жири / Олія / Соуси',
    calories: 110,
    items: [
      { name: 'Будь-яка олія (рекомендуємо лляну)', portion: '12 г' },
      { name: 'Авокадо', portion: '65 г' },
      { name: 'Оливки', portion: '80 г' },
      { name: 'Гірчиця', portion: '28 г' },
      { name: 'Майонез', portion: '15 г' },
      { name: 'Кетчуп', portion: '42 г' },
      { name: 'Вершкове масло', portion: '14 г' },
      { name: 'Сало', portion: '10 г' }
    ]
  }
];

module.exports = seedData;
