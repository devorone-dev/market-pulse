// store.js
const fs = require('fs');
const path = require('path');

const STORE_FILE = path.join(__dirname, 'store.json');
let data = {};

function loadStore() {
  try {
    if (fs.existsSync(STORE_FILE)) {
      const raw = fs.readFileSync(STORE_FILE, 'utf-8');
      data = JSON.parse(raw);
    }
  } catch (e) {
    console.error('Помилка читання store.json:', e.message);
    data = {};
  }
}

function saveStore() {
  try {
    fs.writeFileSync(STORE_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (e) {
    console.error('Помилка збереження store.json:', e.message);
  }
}

loadStore();

module.exports = {
  get size() {
    return Object.keys(data).length;
  },

  has(key) {
    return Boolean(data[key]);
  },

  upsert(key, value) {
    data[key] = {
      ...data[key],
      ...value,
      updatedAt: Date.now()
    };
    saveStore();
  },

  getPendingToPush(minImportance, limit) {
    const items = [];
    for (const [key, item] of Object.entries(data)) {
      if (item.analyzed && !item.pushed && (item.importance || 0) >= minImportance) {
        items.push({ key, ...item });
      }
    }
    items.sort((a, b) => (b.importance || 0) - (a.importance || 0));
    return items.slice(0, limit);
  },

  markPushed(key) {
    if (data[key]) {
      data[key].pushed = true;
      saveStore();
    }
  },

  prune() {
    const threeDaysAgo = Date.now() - 3 * 24 * 60 * 60 * 1000;
    let changed = false;
    for (const [key, item] of Object.entries(data)) {
      if ((item.updatedAt || 0) < threeDaysAgo) {
        delete data[key];
        changed = true;
      }
    }
    if (changed) saveStore();
  }
};
