// Food data: UK CoFID bundled offline, plus Open Food Facts for branded products and barcodes.
const OFF_PRODUCT = 'https://world.openfoodfacts.org/api/v2/product/';
const OFF_SEARCH = 'https://search.openfoodfacts.org/search';
const OFF_LEGACY = 'https://world.openfoodfacts.org/cgi/search.pl';
const OFF_FIELDS = 'code,product_name,brands,nutriments,serving_quantity,quantity';

// Products Harry eats often, built in so they work offline and rank first. Values per 100 g from the pack label.
export const STAPLES = [
  {
    id: 's-danone-skyr-natural', source: 'staple', name: 'Skyr High Protein 0% Fat Natural Yogurt', brand: 'Danone',
    per: '100g', kcal: 51, protein: 9.0, carbs: 3.4, fat: 0.1, servingG: null,
    keywords: 'skyr yoghurt yogurt natural plain greek style', label: 'Waitrose label, Nov 2026',
  },
];

let cofid = null;
export async function loadCofid() {
  if (cofid) return cofid;
  const rows = await (await fetch('data/cofid.json')).json();
  // Row: [name, kcal, protein, carbs, fat, fibre, group] per 100 g
  cofid = rows.map((r, i) => ({
    id: 'c' + i, source: 'cofid', name: r[0], per: '100g',
    kcal: r[1], protein: r[2] ?? 0, carbs: r[3] ?? 0, fat: r[4] ?? 0, fibre: r[5],
    _search: normalise(r[0]),
  }));
  for (const s of STAPLES) s._search = normalise(`${s.name} ${s.brand} ${s.keywords}`);
  cofid = [...STAPLES, ...cofid];
  return cofid;
}

export function normalise(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// Every word you type must start a word in the food name. Shorter, simpler names rank higher,
// and plain foods ("raw", "average") beat processed variants.
export function searchFoods(list, query, limit = 40) {
  const terms = normalise(query).split(' ').filter(Boolean);
  if (!terms.length) return [];
  const out = [];
  for (const f of list) {
    const hay = f._search || (f._search = normalise(f.name + ' ' + (f.brand || '')));
    const words = hay.split(' ');
    let score = 0, ok = true;
    for (const t of terms) {
      const idx = words.findIndex(w => w.startsWith(t));
      if (idx < 0) { ok = false; break; }
      score += idx * 3 + (words[idx] === t ? 0 : 1);
    }
    if (!ok) continue;
    score += hay.length / 12;
    if (/\b(raw|average|boiled|plain|semi skimmed)\b/.test(hay)) score -= 2;
    if (/\bweighed with\b/.test(hay)) score += 6;
    if (f.source !== 'cofid') score -= 4; // your own foods and staples first
    out.push([score, f]);
  }
  return out.sort((a, b) => a[0] - b[0]).slice(0, limit).map(x => x[1]);
}

// Turn an Open Food Facts product into our food shape (per 100 g).
export function fromOff(p) {
  const n = p.nutriments || {};
  let kcal = n['energy-kcal_100g'];
  if (kcal == null && n['energy_100g'] != null) kcal = n['energy_100g'] / 4.184; // kJ → kcal
  if (kcal == null) return null;
  const brand = Array.isArray(p.brands) ? p.brands[0] : (p.brands || '').split(',')[0];
  return {
    id: 'off' + p.code, source: 'off', barcode: p.code,
    name: p.product_name || 'Unnamed product', brand: (brand || '').trim(),
    per: '100g', kcal: Math.round(kcal),
    protein: round1(n.proteins_100g), carbs: round1(n.carbohydrates_100g), fat: round1(n.fat_100g),
    fibre: n.fiber_100g ?? null,
    servingG: Number(p.serving_quantity) || null,
  };
}
const round1 = v => (v == null || isNaN(v) ? 0 : Math.round(Number(v) * 10) / 10);

async function getJson(url, ms = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally { clearTimeout(t); }
}

export async function lookupBarcode(code) {
  const data = await getJson(`${OFF_PRODUCT}${encodeURIComponent(code)}.json?fields=${OFF_FIELDS}&app_name=Fuel`);
  if (data.status !== 1 || !data.product) return null;
  return fromOff({ ...data.product, code });
}

// Online search for branded UK products. Open Food Facts asks apps not to search on every keystroke,
// so this only runs when you press the button.
// Text search on Open Food Facts is less reliable than barcode lookups, so try two endpoints.
export async function searchOnline(query) {
  try {
    const q = `${query} countries_tags:"en:united-kingdom"`;
    const data = await getJson(`${OFF_SEARCH}?q=${encodeURIComponent(q)}&page_size=30&fields=${OFF_FIELDS}&langs=en`);
    return (data.hits || []).map(fromOff).filter(Boolean);
  } catch (e) {
    const url = `${OFF_LEGACY}?search_terms=${encodeURIComponent(query)}&search_simple=1&action=process&json=1&page_size=30`
      + `&fields=${OFF_FIELDS}&tagtype_0=countries&tag_contains_0=contains&tag_0=united-kingdom&app_name=Fuel`;
    const data = await getJson(url, 15000);
    return (data.products || []).map(fromOff).filter(Boolean);
  }
}
