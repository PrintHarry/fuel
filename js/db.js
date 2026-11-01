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
    // Clean every row first, so a tampered file can't smuggle code into the page.
    const clean = {};
    for (const name of Object.keys(STORES)) {
      if (!Array.isArray(data[name])) continue;
      clean[name] = data[name].map(row => sanitise(row)).filter(row => row && row[STORES[name].keyPath] != null && (name !== 'weights' || row.kg > 0));
    }
    for (const [name, rows] of Object.entries(clean)) {
      await this.clear(name);
      for (const row of rows) await this.put(name, row);
    }
  },
};

// Add foods from a file without touching anything else. File: { app: 'fuel', foods: [...] }.
// Foods marked favourite: true are pinned to favourites. Returns the number added.
export async function mergeFoods(data) {
  if (!data || data.app !== 'fuel' || !Array.isArray(data.foods)) throw new Error('This file has no Fuel foods in it.');
  const foods = data.foods.map(f => sanitise(f)).filter(f => f && f.id && f.name && f.kcal >= 0);
  const favs = await db.meta('favs', []);
  for (const f of foods) {
    const fav = f.favourite === true;
    delete f.favourite;
    const food = { ...f, source: 'mine', per: f.per === '100g' ? '100g' : 'serving' };
    await db.put('foods', food);
    if (fav && !favs.some(x => x.id === food.id)) favs.push(food);
  }
  await db.setMeta('favs', favs);
  return foods.length;
}

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

// Backup files are untrusted: numbers must be numbers, ids/dates/times must match their format,
// and anything else is kept only as plain text (which the UI always escapes).
const NUM_KEYS = new Set(['kcal', 'protein', 'carbs', 'fat', 'fibre', 'amount', 'servingG', 'servings', 'kg', 'age', 'heightCm',
  'weightKg', 'activity', 'ratePct', 'proteinPerKg', 'streakTarget', 'kcalTarget', 'tdee', 'initialTdee', 'created', 'target',
  'avgIntake', 'slopeKgPerWeek']);
const FORMATS = { id: /^[\w-]{1,64}$/, date: /^\d{4}-\d{2}-\d{2}$/, time: /^(\d{2}:\d{2})?$/ };
function sanitise(value, key = '') {
  if (value === null || value === undefined) return value ?? null;
  if (Array.isArray(value)) return value.map(v => sanitise(v)).filter(v => v !== undefined);
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      const s = sanitise(v, k);
      if (s === undefined) { if (k === 'id' || k === 'date') return undefined; continue; }
      out[k] = s;
    }
    return out;
  }
  if (NUM_KEYS.has(key)) { const n = Number(value); return Number.isFinite(n) ? n : null; }
  if (FORMATS[key]) return FORMATS[key].test(String(value)) ? String(value) : undefined;
  if (typeof value === 'boolean' || typeof value === 'number') return value;
  return String(value).slice(0, 500);
}

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
