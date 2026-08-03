const express = require('express');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');
const { getTodaySummary, logGrams, resetToday } = require('./database');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBAPP_URL = process.env.WEBAPP_URL;
const PORT = process.env.PORT || 3000;

if (!BOT_TOKEN) {
  console.error('ERROR: BOT_TOKEN environment variable missing.');
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  if (!WEBAPP_URL) {
    return bot.sendMessage(chatId, 'Не налаштовано WEBAPP_URL у змінних середовища.');
  }
  bot.sendMessage(chatId, 'Вітаю! Відкрийте свій добовий трекер харчування за кнопкою нижче: 🥗', {
    reply_markup: {
      inline_keyboard: [[{ text: '🥗 Мій Раціон', web_app: { url: WEBAPP_URL } }]]
    }
  });
});

const getTodayDateStr = () => new Date().toISOString().split('T')[0];

app.get('/api/today', (req, res) => {
  const userId = req.query.user_id || 'default_user';
  const summary = getTodaySummary(userId, getTodayDateStr());
  res.json(summary);
});

app.post('/api/log-grams', (req, res) => {
  const { userId = 'default_user', productId, grams } = req.body;
  const summary = logGrams(userId, productId, grams, getTodayDateStr());
  res.json(summary);
});

app.post('/api/reset', (req, res) => {
  const { userId = 'default_user' } = req.body;
  const summary = resetToday(userId, getTodayDateStr());
  res.json(summary);
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
