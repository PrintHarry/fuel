// Tiny IndexedDB wrapper. Everything lives on the phone; nothing is sent anywhere.
const DB_NAME = 'fuel';
const DB_VERSION = 1;
const STORES = {
  entries: { keyPath: 'id', indexes: [['date', 'date']] },
  weights: { keyPath: 'date' },
  foods: { keyPath: 'id', indexes: [['barcode', 'barcode']] },
  checkins: { keyPath: 'date' },
  meta: { keyPath: 'key' },
};

let dbp;
function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const [name, def] of Object.entries(STORES)) {
        if (db.objectStoreNames.contains(name)) continue;
        const s = db.createObjectStore(name, { keyPath: def.keyPath });
        for (const [idx, path] of def.indexes || []) s.createIndex(idx, path);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function wrap(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function store(name, mode = 'readonly') {
  const db = await open();
  return db.transaction(name, mode).objectStore(name);
}

export const db = {
  async get(name, key) { return wrap((await store(name)).get(key)); },
  async all(name) { return wrap((await store(name)).getAll()); },
  async put(name, value) { return wrap((await store(name, 'readwrite')).put(value)); },
  async del(name, key) { return wrap((await store(name, 'readwrite')).delete(key)); },
  async byIndex(name, index, value) {
    return wrap((await store(name)).index(index).getAll(value));
  },
  async clear(name) { return wrap((await store(name, 'readwrite')).clear()); },
  async meta(key, fallback = null) {
    const row = await this.get('meta', key);
    return row ? row.value : fallback;
  },
  async setMeta(key, value) { return this.put('meta', { key, value }); },

  // Full backup as plain JSON, so it can be saved to Files and restored later.
  async exportAll() {
    const out = { app: 'fuel', version: DB_VERSION, exported: new Date().toISOString() };
    for (const name of Object.keys(STORES)) out[name] = await this.all(name);
    return out;
  },
  async importAll(data) {
    if (!data || data.app !== 'fuel') throw new Error('This file is not a Fuel backup.');
    for (const name of Object.keys(STORES)) {
      if (!Array.isArray(data[name])) continue;
      await this.clear(name);
      for (const row of data[name]) await this.put(name, row);
    }
  },
};

// Ask the browser not to evict our data. Installed home-screen apps usually get this.
export async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist) {
      if (await navigator.storage.persisted()) return true;
      return await navigator.storage.persist();
    }
  } catch (e) { /* not supported */ }
  return false;
}

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
