import http from 'http';
import { GoogleGenerativeAI } from '@google/generative-ai';
import Parser from 'rss-parser';

// ==========================================
// ФІКС ДЛЯ RENDER (Веб-сервер для проходження Health Check)
// ==========================================
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Market Pulse AI Bot is active');
}).listen(PORT, () => {
  console.log(`🌐 Web-server listening on port ${PORT} (for Render)`);
});

// ==========================================
// НАЛАШТУВАННЯ ТА ЗМІННІ ОТОЧЕННЯ
// ==========================================
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Стабільна модель за замовчуванням
const MODEL = process.env.GEMINI_MODEL || 'gemini-1.5-flash';
const IMPORTANCE_THRESHOLD = parseInt(process.env.IMPORTANCE_THRESHOLD || '7', 10);
const CHECK_INTERVAL_MS = parseInt(process.env.CHECK_INTERVAL_MS || '30000', 10);

// Ініціалізація правильного SDK Gemini
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY || '');

// Оновлені RSS-стрічки
const RSS_FEEDS = [
  'https://feeds.content.dowjones.io/public/rss/mw_topstories',
  'https://search.cnbc.com/rs/search/combinedrender?source=yahoo&partnerId=2001&collection=all&keywords=finance',
  'https://www.coindesk.com/arc/outboundfeeds/rss/'
];

const parser = new Parser({
  headers: {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  },
  timeout: 10000
});

const processedNews = new Set();

if (!GEMINI_API_KEY || !TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error('❌ ПОМИЛКА: Перевірте наявність GEMINI_API_KEY, TELEGRAM_BOT_TOKEN та TELEGRAM_CHAT_ID!');
}

// ==========================================
// ФУНКЦІЯ АНАЛІЗУ ЧЕРЕЗ GEMINI SDK
// ==========================================
async function analyzeHeadlinesBatch(items, retries = 2) {
  const numbered = items.map((item, i) => `${i + 1}. "${item.text}"`).join('\n');

  const prompt = `Analyze these ${items.length} financial news headlines for a trading signal system, one by one.

Headlines:
${numbered}

Respond with a JSON array. The array MUST have exactly ${items.length} objects, in the SAME ORDER as the headlines above. Each object:
{"summary":"max 15 words, facts only, no adjectives","direction":"Bullish or Bearish or Neutral","importance":integer 1 to 10,"confidence":integer 1 to 100,"assets":["max 3 tickers or asset names"],"category":"Macro or Stocks or Commodities or Crypto or Rates or Geopolitics or Earnings"}`;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      // Отримання моделі через правильний метод SDK
      const model = genAI.getGenerativeModel({ 
        model: MODEL,
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: 0.2
        }
      });

      const result = await model.generateContent(prompt);
      const response = await result.response;
      const text = response.text() || '';

      const cleanJson = text.replace(/```json\n?|```/g, '').trim();
      return JSON.parse(cleanJson);

    } catch (err) {
      if (attempt < retries) {
        console.warn(`⚠️ Спроба ${attempt + 1} не вдалася (${err.message}). Повтор через 3 сек...`);
        await new Promise((r) => setTimeout(r, 3000));
      } else {
        throw err;
      }
    }
  }
}

// ==========================================
// ВІДПРАВКА В TELEGRAM
// ==========================================
async function sendTelegramMessage(text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: text,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      })
    });

    if (!res.ok) {
      const errData = await res.json();
      console.error('❌ Помилка Telegram API:', errData);
    }
  } catch (err) {
    console.error('❌ Помилка мережі при відправці в Telegram:', err.message);
  }
}

// ==========================================
// ЦИКЛ ОБРОБКИ
// ==========================================
async function fetchAndProcessNews() {
  const newItems = [];

  for (const feedUrl of RSS_FEEDS) {
    try {
      const feed = await parser.parseURL(feedUrl);
      for (const item of feed.items || []) {
        const id = item.guid || item.link || item.title;
        if (id && !processedNews.has(id)) {
          processedNews.add(id);
          newItems.push({
            id,
            text: item.title,
            link: item.link
          });
        }
      }
    } catch (err) {
      console.warn(`⚠️ Не вдалося завантажити стрічку ${feedUrl}: ${err.message}`);
    }
  }

  if (newItems.length === 0) return;

  console.log(`\n Знайдено ${newItems.length} нових заголовків. Аналізую через ${MODEL}...`);

  const BATCH_SIZE = 10;
  for (let i = 0; i < newItems.length; i += BATCH_SIZE) {
    const batch = newItems.slice(i, i + BATCH_SIZE);
    
    try {
      const results = await analyzeHeadlinesBatch(batch);

      results.forEach((analysis, idx) => {
        const item = batch[idx];
        if (!item || !analysis) return;

        const importance = analysis.importance || 0;
        console.log(` → [${importance}/10] ${item.text}`);

        if (importance >= IMPORTANCE_THRESHOLD) {
          const emoji = analysis.direction === 'Bullish' ? '📈' : analysis.direction === 'Bearish' ? '📉' : '⚖️';
          const message = `${emoji} <b>Market Pulse AI Signal</b>\n\n` +
            `<b>Заголовок:</b> ${item.text}\n` +
            `<b>Коротко:</b> ${analysis.summary}\n` +
            `<b>Напрямок:</b> ${analysis.direction}\n` +
            `<b>Важливість:</b> ${importance}/10 (Впевненість: ${analysis.confidence}%)\n` +
            `<b>Активи:</b> ${(analysis.assets || []).join(', ')}\n` +
            `<b>Категорія:</b> ${analysis.category}\n\n` +
            `🔗 <a href="${item.link}">Читати джерело</a>`;

          sendTelegramMessage(message);
          console.log(` ✅ Опубліковано важливу новину: "${item.text}"`);
        }
      });
    } catch (err) {
      console.error(`❌ Помилка аналізу батчу: ${err.message}`);
    }
  }
}

// ==========================================
// ЗАПУСК
// ==========================================
let cycleCount = 0;

async function start() {
  console.log('🚀 Market Pulse AI запущено.');
  console.log(`   Модель: ${MODEL}`);
  console.log(`   Поріг важливості: ${IMPORTANCE_THRESHOLD}/10`);

  cycleCount++;
  console.log(`\n[${new Date().toLocaleTimeString()}] Цикл #${cycleCount}`);
  await fetchAndProcessNews();

  setInterval(async () => {
    cycleCount++;
    console.log(`\n[${new Date().toLocaleTimeString()}] Цикл #${cycleCount}`);
    await fetchAndProcessNews();
  }, CHECK_INTERVAL_MS);
}

start();
