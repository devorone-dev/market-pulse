// index.js — Market Pulse AI
require('dotenv').config();
const { fetchAllSources } = require('./newsFetcher');
const store = require('./store');
const fs = require('fs');
const path = require('path');

// ==== НАЛАШТУВАННЯ — з .env ====
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const IMPORTANCE_THRESHOLD = Number(process.env.IMPORTANCE_THRESHOLD || 7);
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 30000);
const CHUNK_SIZE = 10;
const PUBLISH_LIMIT_PER_CYCLE = 6;
const LOG_FILE = path.join(__dirname, 'market-pulse.log');
const LOG_MAX_BYTES = 5 * 1024 * 1024;

const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

function logLine(text) {
  const stamp = new Date().toISOString();
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > LOG_MAX_BYTES) {
      fs.renameSync(LOG_FILE, LOG_FILE + '.old');
    }
  } catch { /* ignore */ }
  fs.appendFile(LOG_FILE, `[${stamp}] ${text}\n`, () => {});
}

function checkConfig() {
  const problems = [];
  if (!BOT_TOKEN) problems.push('TELEGRAM_BOT_TOKEN не заданий у .env');
  if (!CHAT_ID) problems.push('TELEGRAM_CHAT_ID не заданий у .env');
  if (!GEMINI_API_KEY) problems.push('GEMINI_API_KEY не заданий у .env');
  if (problems.length) {
    console.error('❌ Перш ніж запускати, додай змінні оточення:');
    problems.forEach(p => console.error('   - ' + p));
    process.exit(1);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

// ==== Аналіз через Gemini ====
async function analyzeHeadlinesBatch(items) {
  const numbered = items.map((item, i) => `${i + 1}. "${item.text}"`).join('\n');

  const prompt = `Analyze these ${items.length} financial news headlines for a trading signal system, one by one.

Headlines:
${numbered}

Respond with a JSON array. The array MUST have exactly ${items.length} objects, in the SAME ORDER as the headlines above. Each object:
{"summary":"max 15 words, facts only, no adjectives","direction":"Bullish or Bearish or Neutral","importance":integer 1 to 10,"confidence":integer 1 to 100,"assets":["max 3 tickers or asset names"],"category":"Macro or Stocks or Commodities or Crypto or Rates or Geopolitics or Earnings"}`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

  const MAX_RETRIES = 4;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 25000);

    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': GEMINI_API_KEY
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: 'application/json' }
        }),
        signal: controller.signal
      });
    } catch (e) {
      clearTimeout(timeoutId);
      if (e.name === 'AbortError') {
        logLine(`Gemini timeout на спробі ${attempt}`);
        if (attempt < MAX_RETRIES) continue;
        throw new Error('Gemini не відповідає (timeout) після всіх спроб');
      }
      throw e;
    }
    clearTimeout(timeoutId);

    if (res.ok) {
      const data = await res.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
      const clean = text.replace(/```json|```/g, '').trim();
      const parsed = JSON.parse(clean);

      if (!Array.isArray(parsed) || parsed.length !== items.length) {
        throw new Error(`Gemini повернув не той формат: очікував ${items.length} елементів`);
      }
      return parsed;
    }

    if ((res.status === 429 || res.status === 503) && attempt < MAX_RETRIES) {
      const waitSec = Math.min(60, attempt * 15) + Math.random() * 3;
      logLine(`Gemini 429/503 на спробі ${attempt}, чекаю ${waitSec.toFixed(0)}с`);
      await sleep(waitSec * 1000);
      continue;
    }

    const errText = await res.text();
    logLine(`Gemini помилка HTTP ${res.status}: ${errText.slice(0, 200)}`);
    throw new Error(`Gemini API помилка: HTTP ${res.status}: ${errText.slice(0, 150)}`);
  }
}

async function analyzeAllNew(items) {
  const chunks = chunkArray(items, CHUNK_SIZE);
  console.log(`   📡 Аналізую ${items.length} заголовків паралельно, ${chunks.length} батч(ів)...`);

  const settled = await Promise.allSettled(
    chunks.map(chunk => analyzeHeadlinesBatch(chunk).then(analyses => ({ chunk, analyses })))
  );

  let successCount = 0;
  let failCount = 0;

  for (const result of settled) {
    if (result.status === 'fulfilled') {
      const { chunk, analyses } = result.value;
      for (let i = 0; i < chunk.length; i++) {
        const item = chunk[i];
        const a = analyses[i];
        console.log(`   → "${item.text.slice(0, 60)}..." — важливість ${a.importance}/10`);
        store.upsert(item._dedupeKey, {
          analyzed: true,
          pushed: false,
          text: item.text,
          url: item.url,
          source: item.source,
          category: a.category || item.category,
          summary: a.summary,
          direction: a.direction,
          importance: a.importance,
          confidence: a.confidence,
          assets: a.assets
        });
        successCount++;
      }
    } else {
      failCount++;
      const msg = result.reason?.message || String(result.reason);
      console.error(`   ❌ Один із батчів аналізу впав: ${msg}`);
      logLine(`Батч аналізу впав: ${msg}`);
    }
  }

  return { successCount, failCount, totalChunks: chunks.length };
}

function dirArrow(direction) {
  if (direction === 'Bullish') return '↑';
  if (direction === 'Bearish') return '↓';
  return '→';
}

function formatPost(item) {
  const now = new Date();
  const dateStr = now.toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Europe/Kyiv' });
  const timeStr = now.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Kyiv' });

  return `🚨 <b>BREAKING</b>
${item.text}

${item.summary}

${dirArrow(item.direction)} ${item.direction} — ${(item.assets || []).join(', ')}

Важливість: <b>${item.importance}/10</b>
Впевненість: <b>${item.confidence}%</b>
Категорія: ${item.category}

🕐 ${dateStr} ${timeStr} (Київ)
🔗 <a href="${item.url}">Першоджерело: ${item.source}</a>`;
}

async function publishToTelegram(text) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: false
      })
    });

    if (res.ok) return;

    const errText = await res.text();
    let errJson = null;
    try { errJson = JSON.parse(errText); } catch { /* ignore */ }

    if (res.status === 429 && errJson?.parameters?.retry_after && attempt < 2) {
      const waitSec = Math.min(errJson.parameters.retry_after, 60);
      console.log(`      (Telegram просить почекати ${waitSec} сек, повторюю...)`);
      await sleep(waitSec * 1000);
      continue;
    }

    const err = new Error(`Telegram помилка: HTTP ${res.status}: ${errText}`);
    if ([400, 401, 404].includes(res.status)) err.stopQueue = true;
    throw err;
  }
}

async function publishPending() {
  const pending = store.getPendingToPush(IMPORTANCE_THRESHOLD, PUBLISH_LIMIT_PER_CYCLE);
  if (pending.length === 0) return;

  console.log(`   Публікую ${pending.length} новин з черги...`);
  for (const item of pending) {
    try {
      const post = formatPost(item);
      await publishToTelegram(post);
      store.markPushed(item.key);
      console.log(`   ✅ Опубліковано: "${item.text.slice(0, 50)}..."`);
      await sleep(1200);
    } catch (e) {
      console.error(`   ❌ Помилка публікації: ${e.message}`);
      logLine(`Помилка публікації "${item.text.slice(0, 60)}": ${e.message}`);
      if (e.stopQueue) {
        console.log('   ⚠️  Проблема з токеном/chat_id — зупиняю чергу');
        break;
      }
    }
  }
}

let cycleCount = 0;
let isBusy = false;
let skipLogged = false;

async function pollCycle() {
  if (isBusy) {
    if (!skipLogged) {
      console.log('   (попередній цикл ще не завершився — чекаю)');
      skipLogged = true;
    }
    return;
  }
  skipLogged = false;
  isBusy = true;

  try {
    cycleCount++;
    const stamp = new Date().toLocaleTimeString('uk-UA', { timeZone: 'Europe/Kyiv' });
    console.log(`\n[${stamp}] Цикл #${cycleCount}: перевіряю джерела...`);

    let headlines = [];
    try {
      headlines = await fetchAllSources();
    } catch (e) {
      console.error('❌ Не вдалось отримати новини:', e.message);
      logLine(`Помилка fetchAllSources: ${e.message}`);
    }

    const newHeadlines = headlines.filter(h => !store.has(h._dedupeKey));

    if (newHeadlines.length > 0) {
      console.log(`   Знайдено ${newHeadlines.length} нових заголовків (з ${headlines.length} у стрічці).`);
      const { failCount, totalChunks } = await analyzeAllNew(newHeadlines);
      if (failCount > 0) {
        console.log(`   ⚠️  ${failCount}/${totalChunks} батч(ів) не вдалось проаналізувати.`);
      }
    } else {
      console.log('   Нових заголовків немає.');
    }

    await publishPending();

    if (cycleCount % 500 === 0) store.prune();

  } catch (e) {
    console.error('❌ Непередбачена помилка в циклі:', e.message);
    logLine(`Непередбачена помилка в pollCycle: ${e.stack || e.message}`);
  } finally {
    isBusy = false;
  }
}

process.on('unhandledRejection', (reason) => {
  const msg = reason?.stack || reason?.message || String(reason);
  console.error('❌ unhandledRejection:', msg);
  logLine(`unhandledRejection: ${msg}`);
});
process.on('uncaughtException', (err) => {
  console.error('❌ uncaughtException:', err.stack || err.message);
  logLine(`uncaughtException: ${err.stack || err.message}`);
});

process.on('SIGINT', () => {
  console.log('\n👋 Зупиняюсь (Ctrl+C).');
  process.exit(0);
});
process.on('SIGTERM', () => {
  console.log('\n👋 Зупиняюсь (SIGTERM).');
  process.exit(0);
});

checkConfig();
console.log('🚀 Market Pulse AI запущено.');
console.log(`   Поріг важливості: ${IMPORTANCE_THRESHOLD}/10`);
console.log(`   Перевірка кожні: ${POLL_INTERVAL_MS / 1000} сек`);
console.log(`   У сховищі вже ${store.size} оброблених новин.`);

pollCycle();
setInterval(pollCycle, POLL_INTERVAL_MS);
