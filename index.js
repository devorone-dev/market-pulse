
import Parser from 'rss-parser';

// ==========================================
// НАЛАШТУВАННЯ ТА ЗМІННІ ОТОЧЕННЯ
// ==========================================
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Модель за замовчуванням gemini-1.5-flash
const MODEL = process.env.GEMINI_MODEL || 'gemini-1.5-flash';
const IMPORTANCE_THRESHOLD = parseInt(process.env.IMPORTANCE_THRESHOLD || '7', 10);
const CHECK_INTERVAL_MS = parseInt(process.env.CHECK_INTERVAL_MS || '30000', 10);

// Джерела RSS новин
const RSS_FEEDS = [
  '[https://search.cnbc.com/rs/search/combinedrender?source=yahoo&partnerId=2001&collection=all&keywords=finance](https://search.cnbc.com/rs/search/combinedrender?source=yahoo&partnerId=2001&collection=all&keywords=finance)',
  '[https://feeds.a.dj.com/rss/RSSMarketsMain.xml](https://feeds.a.dj.com/rss/RSSMarketsMain.xml)',
  '[https://www.investing.com/rss/news.rss](https://www.investing.com/rss/news.rss)'
];

const parser = new Parser();
const processedNews = new Set();

// Перевірка наявності ключових змінних
if (!GEMINI_API_KEY || !TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error('❌ ПОМИЛКА: Не всі обов\'язкові змінні оточення встановлені!');
  console.error('Перевірте наявність GEMINI_API_KEY, TELEGRAM_BOT_TOKEN та TELEGRAM_CHAT_ID.');
}

// ==========================================
// ФУНКЦІЯ АНАЛІЗУ ЧЕРЕЗ GEMINI API
// ==========================================
async function analyzeHeadlinesBatch(items, retries = 2) {
  const numbered = items.map((item, i) => `${i + 1}. "${item.text}"`).join('\n');

  const prompt = `Analyze these ${items.length} financial news headlines for a trading signal system, one by one.

Headlines:
${numbered}

Respond with a JSON array. The array MUST have exactly ${items.length} objects, in the SAME ORDER as the headlines above. Each object:
{"summary":"max 15 words, facts only, no adjectives","direction":"Bullish or Bearish or Neutral","importance":integer 1 to 10,"confidence":integer 1 to 100,"assets":["max 3 tickers or asset names"],"category":"Macro or Stocks or Commodities or Crypto or Rates or Geopolitics or Earnings"}`;

  const url = `[https://generativelanguage.googleapis.com/v1beta/models/$](https://generativelanguage.googleapis.com/v1beta/models/$){MODEL}:generateContent?key=${GEMINI_API_KEY}`;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { 
            responseMimeType: 'application/json',
            temperature: 0.2
          }
        })
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`HTTP ${res.status}: ${errText}`);
      }

      const data = await res.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
      
      // Очищення відповіді від можливих розеток markdown ```json ... ```
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
// ВІДПРАВКА ПОВІДОМЛЕННЯ В TELEGRAM
// ==========================================
async function sendTelegramMessage(text) {
  const url = `[https://api.telegram.org/bot$](https://api.telegram.org/bot$){TELEGRAM_BOT_TOKEN}/sendMessage`;
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
// ОСНОВНИЙ ЦИКЛ ОБРОБКИ НОВИН
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

  if (newItems.length === 0) {
    return;
  }

  console.log(`\n Знайдено ${newItems.length} нових заголовків. Аналізую через ${MODEL}...`);

  // Розбиваємо новини на батчі по 10 штук
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
// ЗАПУСК БОТА
// ==========================================
let cycleCount = 0;

async function start() {
  console.log('🚀 Market Pulse AI запущено.');
  console.log(`   Модель: ${MODEL}`);
  console.log(`   Поріг важливості: ${IMPORTANCE_THRESHOLD}/10`);
  console.log(`   Інтервал перевірки: ${CHECK_INTERVAL_MS / 1000} сек`);

  // Запускаємо відразу при старті
  cycleCount++;
  console.log(`\n[${new Date().toLocaleTimeString()}] Цикл #${cycleCount}`);
  await fetchAndProcessNews();

  // Запускаємо повторення за інтервалом
  setInterval(async () => {
    cycleCount++;
    console.log(`\n[${new Date().toLocaleTimeString()}] Цикл #${cycleCount}`);
    await fetchAndProcessNews();
  }, CHECK_INTERVAL_MS);
}

start();
