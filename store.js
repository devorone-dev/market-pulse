import fs from 'fs';
import path from 'path';

const STORE_PATH = path.resolve('store.json');

export function loadStore() {
  try {
    if (!fs.existsSync(STORE_PATH)) {
      const initialData = { processedIds: [], publishedIds: [] };
      fs.writeFileSync(STORE_PATH, JSON.stringify(initialData, null, 2));
      return initialData;
    }
    const data = fs.readFileSync(STORE_PATH, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Error reading store.json, resetting memory:', error);
    return { processedIds: [], publishedIds: [] };
  }
}

export function saveStore(store) {
  try {
    // Обмежуємо розмір масивів до 500 записів, щоб не переповнювати пам'ять
    if (store.processedIds.length > 500) {
      store.processedIds = store.processedIds.slice(-500);
    }
    if (store.publishedIds.length > 500) {
      store.publishedIds = store.publishedIds.slice(-500);
    }
    fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
  } catch (error) {
    console.error('Error writing to store.json:', error);
  }
}