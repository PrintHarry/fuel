import { db, uid, requestPersistence } from './db.js';
import * as C from './calc.js';
import { loadCofid, searchFoods, lookupBarcode, searchOnline } from './food.js';
import { weightChart, intakeChart } from './charts.js';
import { startScan } from './scan.js';
import { esc, fmt, fmt1, icon, toast, dayLabel, nowTime, isStandalone, isIos } from './ui.js';

const $app = document.getElementById('app');
const today = () => C.iso();

/* ================= State ================= */
const S = {
  settings: null,
  view: 'today',
  date: today(),
  stack: [],          // back navigation
  addTab: 'search',
  query: '',
  online: null,       // { query, results | error | loading }
  food: null,         // food being viewed
  entry: null,        // entry being edited
  amount: null,
  time: null,
  draft: null,        // custom food / recipe being edited
  recipe: null,       // recipe being built (ingredient picker returns here)
  onboardStep: 0,
  chartRange: 30,
  intakeRange: 14,
  scan: null,
};
let cofid = [];
let myFoods = [];

const DEFAULTS = { unit: 'kg', proteinPerKg: 2.0, streakTarget: 5, ratePct: -0.5, activity: 1.55, sex: 'male' };

/* ================= Data helpers ================= */
async function entriesFor(date) {
  const list = await db.byIndex('entries', 'date', date);
  return list.sort((a, b) => (a.time || '').localeCompare(b.time || '') || a.created - b.created);
}
async function dayTotals() {
  const all = await db.all('entries');
  const out = {};
  for (const e of all) {
    const t = out[e.date] || (out[e.date] = { kcal: 0, protein: 0, carbs: 0, fat: 0, n: 0 });
    t.kcal += e.kcal || 0; t.protein += e.protein || 0; t.carbs += e.carbs || 0; t.fat += e.fat || 0; t.n++;
  }
  return out;
}
const weights = () => db.all('weights');

function currentWeightKg(series) {
  return series.length ? series[series.length - 1].trend : S.settings.weightKg;
}

// How targets are set: 'auto' (from expenditure), 'kcal' (calories by hand, macros worked out)
// or 'macros' (all three macros by hand, calories = 4P + 4C + 9F).
const targetMode = s => s.targetMode || (s.manualKcal ? 'kcal' : 'auto');

// Recalculate calorie and macro targets from the current expenditure estimate.
function applyTargets(s, weightKg) {
  const w = weightKg || s.weightKg;
  const mode = targetMode(s);
  s.manualKcal = mode !== 'auto'; // hand-set targets are never changed by the weekly check-in
  if (mode === 'macros') {
    s.kcalTarget = Math.round(s.protein * 4 + s.carbs * 4 + s.fat * 9);
    return s;
  }
  if (mode === 'auto') s.kcalTarget = C.calorieTarget(s.tdee, s.ratePct, w, s.sex);
  Object.assign(s, C.macroTargets(s.kcalTarget, w, s.proteinPerKg));
  return s;
}
async function saveSettings() { await db.setMeta('settings', S.settings); }

function snapshot(food) {
  const { _search, ...rest } = food;
  return rest;
}
async function pushRecent(food) {
  const list = (await db.meta('recents', [])).filter(f => f.id !== food.id);
  list.unshift(snapshot(food));
  await db.setMeta('recents', list.slice(0, 30));
}
async function isFav(food) { return (await db.meta('favs', [])).some(f => f.id === food.id); }
async function toggleFav(food) {
  let list = await db.meta('favs', []);
  const on = list.some(f => f.id === food.id);
  list = on ? list.filter(f => f.id !== food.id) : [snapshot(food), ...list];
  await db.setMeta('favs', list);
  return !on;
}
async function refreshMyFoods() { myFoods = (await db.all('foods')).filter(f => f.source !== 'off-cache'); }

/* ================= Navigation ================= */
function go(view, opts = {}) {
  if (S.scan) { S.scan.stop(); S.scan = null; }
  if (!opts.replace && S.view !== view) S.stack.push(S.view);
  if (opts.root) S.stack = [];
  S.view = view;
  render();
  window.scrollTo(0, 0);
}
function back() {
  if (S.scan) { S.scan.stop(); S.scan = null; }
  S.view = S.stack.pop() || 'today';
  render();
}

const TABS = [
  ['today', 'Today', icon.today],
  ['progress', 'Progress', icon.progress],
  ['add', '', icon.plus],
  ['weight', 'Weight', icon.weight],
  ['settings', 'Settings', icon.settings],
];
function tabbar(active) {
  return `<nav class="tabbar" aria-label="Main">${TABS.map(([id, label, ic]) => id === 'add'
    ? `<button class="tab tab-add" data-act="tab" data-v="add" aria-label="Add food"><span>${ic}</span></button>`
    : `<button class="tab" data-act="tab" data-v="${id}" ${active === id ? 'aria-current="page"' : ''}>${ic}${label}</button>`).join('')}</nav>`;
}
const topbar = (title, sub = '', right = '') =>
  `<header class="topbar"><button class="icon-btn" data-act="back" aria-label="Back">${icon.back}</button><h1>${esc(title)}${sub ? `<div class="sub">${esc(sub)}</div>` : ''}</h1>${right}</header>`;

/* ================= Render ================= */
async function render() {
  const views = { onboard, today: viewToday, add: viewAdd, food: viewFood, quick: viewQuick, weight: viewWeight, progress: viewProgress, settings: viewSettings, editor: viewEditor, recipe: viewRecipe };
  await views[S.view]();
}

/* ---------- Onboarding ---------- */
async function onboard() {
  const s = S.settings;
  const step = S.onboardStep;
  const dots = `<div class="steps">${[0, 1, 2, 3].map(i => `<i class="${i <= step ? 'on' : ''}"></i>`).join('')}</div>`;
  let body = '';
  if (step === 0) {
    const wInput = s.unit === 'stlb'
      ? `<div class="grid-2"><label class="field"><span>Weight</span><div class="input-unit"><input class="input num" id="o-st" inputmode="numeric" value="${s.weightKg ? C.kgToStLb(s.weightKg).st : ''}"><em>st</em></div></label>
         <label class="field"><span>&nbsp;</span><div class="input-unit"><input class="input num" id="o-lb" inputmode="decimal" value="${s.weightKg ? C.kgToStLb(s.weightKg).lb : ''}"><em>lb</em></div></label></div>`
      : `<label class="field"><span>Weight</span><div class="input-unit"><input class="input num" id="o-kg" inputmode="decimal" value="${s.weightKg ? fmt1(s.weightKg) : ''}"><em>kg</em></div></label>`;
    body = `<h1>Let's set your starting point.</h1>
      <p class="prose">Used to estimate what you burn. After two weeks of logging, Fuel replaces the estimate with your real number.</p>
      <div class="label">Sex for the formula</div>
      <div class="seg" style="margin-bottom:14px">${['male', 'female'].map(x => `<button data-act="o-sex" data-v="${x}" aria-pressed="${s.sex === x}">${x === 'male' ? 'Male' : 'Female'}</button>`).join('')}</div>
      <div class="grid-2">
        <label class="field"><span>Age</span><div class="input-unit"><input class="input num" id="o-age" inputmode="numeric" value="${s.age || ''}"><em>yrs</em></div></label>
        <label class="field"><span>Height</span><div class="input-unit"><input class="input num" id="o-h" inputmode="numeric" value="${s.heightCm || ''}"><em>cm</em></div></label>
      </div>
      <div class="label">Weigh in</div>
      <div class="seg" style="margin-bottom:14px">${[['kg', 'Kilograms'], ['stlb', 'Stones & pounds']].map(([v, l]) => `<button data-act="o-unit" data-v="${v}" aria-pressed="${s.unit === v}">${l}</button>`).join('')}</div>
      ${wInput}`;
  } else if (step === 1) {
    body = `<h1>How active are you?</h1><p class="prose">Count training and your job. If unsure, pick the lower one: Fuel corrects it from your data.</p>
      <div class="choices">${C.ACTIVITY.map(a => choice('o-act', a.id, a.label, a.hint, s.activity === a.id)).join('')}</div>`;
  } else if (step === 2) {
    body = `<h1>What's the goal?</h1><p class="prose">Slower cuts keep more muscle. You can change this any time.</p>
      <div class="choices">${C.GOALS.map(g => choice('o-goal', g.id, g.label, g.id === 0 ? g.hint : `${g.hint} · ${fmt1(Math.abs(C.rateKgPerWeek(g.id, s.weightKg)))} kg/week`, s.ratePct === g.id)).join('')}</div>`;
  } else {
    applyTargets(s);
    body = `<h1>Your starting target</h1>
      <div class="result-figure">${fmt(s.kcalTarget)}<span class="muted" style="font-size:20px;font-family:var(--font);font-weight:500;margin-left:8px">kcal a day</span></div>
      <p class="prose">Estimated burn <strong>${fmt(s.tdee)} kcal</strong> (Mifflin-St Jeor × activity). ${s.ratePct ? `Adjusted by <strong>${fmt(Math.abs(s.kcalTarget - s.tdee))} kcal</strong> for your weekly goal.` : ''}</p>
      <div class="figures" style="margin-top:20px">
        <div><b class="green">${s.protein}g</b><span>Protein</span></div>
        <div><b>${s.carbs}g</b><span>Carbs</span></div>
        <div><b>${s.fat}g</b><span>Fat</span></div>
      </div>
      <p class="prose small" style="margin-top:16px">Protein is set at ${s.proteinPerKg} g per kg to protect muscle while you cut.</p>
      ${!isStandalone() && isIos() ? `<div class="nudge">${icon.share}<div class="main"><b>Install Fuel</b><span>In Safari tap Share, then Add to Home Screen. Installed, it works offline and your data stays put.</span></div></div>` : ''}`;
  }
  $app.innerHTML = `<main class="view no-tabs onboard">
    ${dots}${body}
    <div class="sticky-foot">
      ${step > 0 ? `<button class="btn" data-act="o-back">Back</button>` : ''}
      <button class="btn btn-primary" data-act="o-next">${step === 3 ? 'Start tracking' : 'Continue'}</button>
    </div></main>`;
}
const choice = (act, v, title, hint, on) =>
  `<button class="choice" data-act="${act}" data-v="${v}" aria-pressed="${on}"><div><b>${esc(title)}</b><small>${esc(hint)}</small></div><span class="tick">${on ? icon.check : ''}</span></button>`;

function readOnboardStep0() {
  const s = S.settings;
  const age = +document.getElementById('o-age').value, h = +document.getElementById('o-h').value;
  let kg;
  if (s.unit === 'stlb') kg = C.stLbToKg(+document.getElementById('o-st').value || 0, +document.getElementById('o-lb').value || 0);
  else kg = parseFloat(document.getElementById('o-kg').value);
  if (!(age >= 14 && age <= 100)) return 'Enter your age.';
  if (!(h >= 120 && h <= 230)) return 'Enter your height in cm.';
  if (!(kg >= 35 && kg <= 300)) return 'Enter your weight.';
  Object.assign(s, { age, heightCm: h, weightKg: Math.round(kg * 10) / 10 });
  return null;
}

/* ---------- Today ---------- */
async function viewToday() {
  const s = S.settings, date = S.date, t = today();
  const [entries, ws] = await Promise.all([entriesFor(date), weights()]);
  const tot = C.sumEntries(entries);
  const left = s.kcalTarget - tot.kcal;
  const over = left < 0;
  const R = 78, CIRC = 2 * Math.PI * R;
  const pct = Math.min(1, tot.kcal / s.kcalTarget), overPct = over ? Math.min(1, -left / s.kcalTarget) : 0;
  const weighedToday = ws.some(w => w.date === t);

  const macro = (name, key, color) => {
    const v = tot[key], target = s[key], p = Math.min(100, (v / target) * 100);
    return `<div class="macro"><span class="name"><i style="background:${color}"></i>${name}</span>
      <span class="val"><b>${fmt(v)}</b> / ${target} g</span>
      <div class="bar-track"><div class="bar-fill" style="width:${p}%;background:${color}"></div></div></div>`;
  };

  const list = entries.length
    ? `<div class="list">${entries.map(e => `<button class="item" data-act="edit-entry" data-id="${e.id}">
        <span class="time">${esc(e.time || '')}</span>
        <span class="main"><span class="title">${esc(e.name)}</span><span class="meta">${entryMeta(e)}</span></span>
        <span class="kcal">${fmt(e.kcal)}<small>kcal</small></span></button>`).join('')}</div>`
    : `<div class="empty"><b>Nothing logged ${date === t ? 'yet' : 'on this day'}</b>Search UK foods, scan a barcode or quick-add calories.
        <div class="row-actions"><button class="btn btn-primary btn-sm" data-act="tab" data-v="add">${icon.plus} Add food</button>
        <button class="btn btn-sm" data-act="copy-prev">${icon.copy} Copy ${date === t ? 'yesterday' : 'previous day'}</button></div></div>`;

  $app.innerHTML = `<main class="view">
    <div class="day-nav">
      <button class="icon-btn" data-act="day" data-v="-1" aria-label="Previous day">${icon.back}</button>
      <h1>${dayLabel(date, t)}</h1>
      <button class="icon-btn" data-act="day" data-v="1" aria-label="Next day" ${date >= t ? 'disabled style="opacity:.25"' : ''}>${icon.next}</button>
    </div>
    <section class="hero">
      <div class="ring" role="img" aria-label="${fmt(Math.abs(left))} kcal ${over ? 'over' : 'left'}">
        <svg viewBox="0 0 172 172"><circle class="track" cx="86" cy="86" r="${R}" fill="none" stroke-width="12"/>
          <circle class="fill" cx="86" cy="86" r="${R}" fill="none" stroke-width="12" stroke-dasharray="${CIRC}" stroke-dashoffset="${CIRC * (1 - pct)}"/>
          ${over ? `<circle class="over" cx="86" cy="86" r="${R}" fill="none" stroke-width="12" stroke-dasharray="${CIRC}" stroke-dashoffset="${CIRC * (1 - overPct)}"/>` : ''}
        </svg>
        <div class="ring-center"><span class="num">${fmt(Math.abs(left))}</span><small>kcal ${over ? 'over' : 'left'}</small></div>
      </div>
      <div class="hero-side">
        <div class="stat"><span>Eaten</span><b>${fmt(tot.kcal)}</b></div>
        <div class="stat"><span>Target</span><b>${fmt(s.kcalTarget)}</b></div>
        <div class="stat"><span>Protein left</span><b class="green">${fmt(Math.max(0, s.protein - tot.protein))}g</b></div>
      </div>
    </section>
    <section class="macros">${macro('Protein', 'protein', 'var(--protein)')}${macro('Carbs', 'carbs', 'var(--carbs)')}${macro('Fat', 'fat', 'var(--fat)')}</section>
    ${date === t && !weighedToday ? `<button class="nudge" data-act="tab" data-v="weight"><div class="main"><b>Log today's weight</b><span>Best first thing, after the loo, before food.</span></div>${icon.next}</button>` : ''}
    <div class="label">Food<span class="aside">${entries.length ? `${entries.length} item${entries.length > 1 ? 's' : ''}` : ''}</span></div>
    ${list}
    ${entries.length ? `<div class="row-actions" style="margin-top:14px"><button class="btn btn-sm" data-act="copy-prev">${icon.copy} Copy ${date === t ? 'yesterday' : 'previous day'}</button></div>` : ''}
  </main>${tabbar('today')}`;
}
function entryMeta(e) {
  if (!e.food) return 'Quick add';
  const amt = e.food.per === 'serving' ? `${fmt1(e.amount)} serving${e.amount === 1 ? '' : 's'}` : `${fmt(e.amount)} g`;
  return esc([e.food.brand, amt, `${fmt(e.protein)}g protein`].filter(Boolean).join(' · '));
}

/* ---------- Add food ---------- */
async function viewAdd() {
  const tab = S.addTab;
  const picking = !!S.recipe;
  const tabs = [['search', 'Search'], ['scan', 'Scan'], ...(picking ? [] : [['quick', 'Quick add']]), ['mine', 'My foods']];
  $app.innerHTML = `<main class="view no-tabs">
    ${topbar(picking ? 'Add ingredient' : 'Add food', picking ? S.recipe.name || 'New recipe' : dayLabel(S.date, today()))}
    <div class="seg" role="tablist">${tabs.map(([id, l]) => `<button data-act="add-tab" data-v="${id}" aria-pressed="${tab === id}">${l}</button>`).join('')}</div>
    <div id="add-body" style="margin-top:16px"></div></main>`;
  const body = document.getElementById('add-body');
  if (tab === 'search') await addSearch(body);
  else if (tab === 'scan') addScan(body);
  else if (tab === 'quick') { S.entry = null; go('quick', { replace: true }); }
  else await addMine(body);
}

function foodRow(f) {
  const badge = f.source === 'off' ? '<span class="badge off">Product</span>' : f.source === 'mine' ? `<span class="badge mine">${f.per === 'serving' ? 'Recipe' : 'Mine'}</span>` : '';
  const per = f.per === 'serving' ? 'per serving' : 'per 100 g';
  return `<button class="item" data-act="open-food" data-id="${esc(f.id)}">
    <span class="main"><span class="title">${esc(f.name)}</span><span class="meta">${badge}${esc(f.brand ? f.brand + ' · ' : '')}${fmt1(f.protein)}g protein ${per}</span></span>
    <span class="kcal">${fmt(f.kcal)}<small>kcal</small></span></button>`;
}
let foodIndex = new Map(); // id → food for rows currently on screen
const indexFoods = list => { for (const f of list) foodIndex.set(f.id, f); return list; };

async function addSearch(body) {
  body.innerHTML = `<div class="search">${icon.search}<input class="input" id="q" type="search" placeholder="Search foods, e.g. chicken breast" value="${esc(S.query)}" autocomplete="off" enterkeyhint="search"></div>
    <div id="results" style="margin-top:8px"></div>`;
  const input = document.getElementById('q');
  const results = document.getElementById('results');
  const paint = async () => {
    const q = input.value.trim();
    S.query = q;
    if (!q) {
      const [favs, recents] = await Promise.all([db.meta('favs', []), db.meta('recents', [])]);
      indexFoods(favs); indexFoods(recents);
      const recentOnly = recents.filter(r => !favs.some(f => f.id === r.id));
      results.innerHTML = (favs.length ? `<div class="label">Favourites</div><div class="list">${favs.map(foodRow).join('')}</div>` : '')
        + (recentOnly.length ? `<div class="label">Recent</div><div class="list">${recentOnly.slice(0, 15).map(foodRow).join('')}</div>` : '')
        + (!favs.length && !recentOnly.length ? `<div class="empty" style="margin-top:16px"><b>Search 2,800+ UK foods</b>From the government's official food tables, plus branded products online. Foods you log show up here for one-tap re-logging.</div>` : '');
      return;
    }
    const local = indexFoods(searchFoods([...myFoods, ...cofid], q));
    const on = S.online && S.online.query === q ? S.online : null;
    results.innerHTML = (local.length ? `<div class="list">${local.map(foodRow).join('')}</div>` : `<p class="muted" style="padding:16px 2px">No generic foods match “${esc(q)}”.</p>`)
      + `<div class="label">Branded products</div>`
      + (on?.loading ? `<p class="muted">Searching Open Food Facts…</p>`
        : on?.error ? `<p class="muted">${esc(on.error)}</p>`
        : on?.results ? (on.results.length ? `<div class="list">${indexFoods(on.results).map(foodRow).join('')}</div>` : `<p class="muted">No UK products found. Try fewer words, or scan the barcode.</p>`)
        : `<button class="btn btn-block" data-act="online" style="margin-top:4px">${icon.search} Search UK products for “${esc(q)}”</button>`);
  };
  let t;
  input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(paint, 90); });
  input.addEventListener('keydown', e => { if (e.key === 'Enter' && input.value.trim()) { input.blur(); runOnline(); } });
  await paint();
  if (!S.query) input.focus();
  S._paintSearch = paint;
}
async function runOnline() {
  const q = S.query;
  if (!q) return;
  if (!navigator.onLine) { S.online = { query: q, error: "You're offline. Generic foods still work." }; return S._paintSearch?.(); }
  S.online = { query: q, loading: true }; await S._paintSearch?.();
  try { S.online = { query: q, results: await searchOnline(q) }; }
  catch (e) { S.online = { query: q, error: "Open Food Facts product search isn't responding. Scanning the barcode is more reliable, or try again later." }; }
  if (S.view === 'add' && S.addTab === 'search') await S._paintSearch?.();
}

function addScan(body) {
  body.innerHTML = `<div class="scanner"><video muted playsinline></video><div class="reticle"></div><div class="msg" id="scan-msg">Starting camera…</div></div>
    <div class="label">Or type the barcode</div>
    <div style="display:flex;gap:8px"><input class="input num" id="bc" inputmode="numeric" placeholder="e.g. 5000157024671"><button class="btn" data-act="bc-go">Look up</button></div>`;
  const video = body.querySelector('video'), msg = document.getElementById('scan-msg');
  S.scan = startScan(video);
  video.addEventListener('playing', () => { msg.textContent = 'Line the barcode up in the box'; }, { once: true });
  S.scan.result.then(code => { if (code) handleBarcode(code); })
    .catch(e => { msg.textContent = e?.name === 'NotAllowedError' ? 'Camera blocked. Allow it in Settings › Safari › Camera, or type the code.' : "Camera unavailable here. Type the code below."; });
}
async function handleBarcode(code) {
  code = String(code).trim();
  if (S.scan) { S.scan.stop(); S.scan = null; }
  const mine = (await db.byIndex('foods', 'barcode', code))[0];
  if (mine) return openFood(mine);
  toast('Looking up ' + code + '…');
  try {
    const food = await lookupBarcode(code);
    if (food) return openFood(food);
    toast('Not in Open Food Facts yet. Add it from the label.');
  } catch (e) {
    toast("Couldn't look that up. Add it from the label.");
  }
  S.draft = { id: uid(), source: 'mine', per: '100g', name: '', brand: '', barcode: code, kcal: '', protein: '', carbs: '', fat: '', servingG: '' };
  go('editor');
}

async function addMine(body) {
  await refreshMyFoods();
  indexFoods(myFoods);
  const foods = myFoods.filter(f => f.source === 'mine').sort((a, b) => a.name.localeCompare(b.name));
  body.innerHTML = `<div class="row-actions" style="margin-bottom:8px">
      <button class="btn btn-sm" data-act="new-food">${icon.plus} New food</button>
      ${S.recipe ? '' : `<button class="btn btn-sm" data-act="new-recipe">${icon.plus} New recipe or meal</button>`}
    </div>
    ${foods.length ? `<div class="list" style="margin-top:12px">${foods.map(foodRow).join('')}</div>`
      : `<div class="empty" style="margin-top:12px"><b>Your own foods live here</b>Add things from a label, or build a recipe or usual meal once and log it in one tap.</div>`}`;
}

async function openFood(food) {
  S.food = food; S.entry = null;
  S.amount = food.per === 'serving' ? 1 : (food.servingG || 100);
  S.time = S.date === today() ? nowTime() : '12:00';
  go('food');
}

/* ---------- Food detail (add or edit) ---------- */
async function viewFood() {
  const f = S.food, editing = !!S.entry, picking = !!S.recipe && !editing;
  const per = f.per === 'serving';
  const n = C.scaleFood(f, S.amount || 0);
  const fav = await isFav(f);
  const chips = per ? [0.5, 1, 1.5, 2] : [...(f.servingG ? [f.servingG] : []), 50, 100, 150, 200].filter((v, i, a) => a.indexOf(v) === i);
  $app.innerHTML = `<main class="view no-tabs">
    ${topbar(editing ? 'Edit entry' : picking ? 'Add ingredient' : 'Add food', '', `${f.source === 'mine' && !editing && !picking ? `<button class="btn btn-quiet btn-sm" data-act="edit-food">Edit</button>` : ''}<button class="icon-btn" data-act="fav" aria-label="${fav ? 'Remove favourite' : 'Favourite'}" style="color:${fav ? 'var(--green)' : ''}">${fav ? icon.starFill : icon.star}</button>`)}
    <div class="food-head">
      <h2>${esc(f.name)}</h2>
      <div class="muted">${[f.brand, f.source === 'cofid' ? 'UK food tables (CoFID)' : f.source === 'off' ? 'Open Food Facts' : 'Your food', per ? `${fmt(f.kcal)} kcal per serving` : `${fmt(f.kcal)} kcal per 100 g`].filter(Boolean).map(esc).join(' · ')}</div>
    </div>
    <div class="amount">
      <label class="field" style="margin:0"><span>${per ? 'Servings' : 'Amount'}</span>
        <div class="input-unit"><input class="input num" id="amt" inputmode="decimal" value="${S.amount}"><em>${per ? '×' : 'g'}</em></div></label>
      ${picking ? '' : `<label class="field" style="margin:0"><span>Time</span><input class="input num" id="time" type="time" value="${S.time}" style="width:118px"></label>`}
    </div>
    <div class="chips">${chips.map(c => `<button class="chip" data-act="chip" data-v="${c}" aria-pressed="${+S.amount === c}">${per ? `${c}×` : c === f.servingG ? `1 serving · ${c} g` : `${c} g`}</button>`).join('')}</div>
    <div class="preview" id="preview">${previewHtml(n)}</div>
    ${f.source === 'off' && !f.protein && !f.carbs && !f.fat ? `<p class="small muted">This product has calories but no macros on Open Food Facts.</p>` : ''}
    <div class="sticky-foot">
      ${editing ? `<button class="btn btn-danger" data-act="del-entry" aria-label="Delete">${icon.trash}</button>` : ''}
      <button class="btn btn-primary" data-act="save-food">${editing ? 'Save' : picking ? 'Add to recipe' : S.date === today() ? 'Add to today' : 'Add to ' + dayLabel(S.date, today())}</button>
    </div></main>`;
  const amt = document.getElementById('amt');
  amt.addEventListener('input', () => {
    S.amount = parseFloat(amt.value) || 0;
    document.getElementById('preview').innerHTML = previewHtml(C.scaleFood(f, S.amount));
    document.querySelectorAll('.chip').forEach(c => c.setAttribute('aria-pressed', +c.dataset.v === S.amount));
  });
  amt.addEventListener('focus', () => amt.select());
  document.getElementById('time')?.addEventListener('change', e => { S.time = e.target.value; });
}
const previewHtml = n => `<div><b>${fmt(n.kcal)}</b><span>kcal</span></div><div><b>${fmt1(n.protein)}</b><span>protein g</span></div><div><b>${fmt1(n.carbs)}</b><span>carbs g</span></div><div><b>${fmt1(n.fat)}</b><span>fat g</span></div>`;

async function saveFoodEntry() {
  const f = S.food, amount = S.amount;
  if (!(amount > 0)) return toast('Enter an amount.');
  if (S.recipe && !S.entry) {
    S.recipe.items.push({ food: snapshot(f), amount });
    while (S.stack.length && S.stack.pop() !== 'recipe');
    S.view = 'recipe'; S.addTab = 'search';
    return render();
  }
  const n = C.scaleFood(f, amount);
  const e = S.entry ? { ...S.entry } : { id: uid(), date: S.date, created: Date.now() };
  Object.assign(e, { name: f.name, brand: f.brand || '', food: snapshot(f), amount, time: S.time, ...n });
  await db.put('entries', e);
  if (f.source === 'off') await db.put('foods', { ...snapshot(f) }); // cache for offline barcode lookups
  await pushRecent(f);
  await refreshMyFoods();
  toast(S.entry ? 'Saved' : `Added ${fmt(n.kcal)} kcal`);
  S.query = ''; S.online = null; S.entry = null;
  go('today', { root: true });
}

/* ---------- Quick add ---------- */
async function viewQuick() {
  const e = S.entry || {};
  $app.innerHTML = `<main class="view no-tabs">
    ${topbar(S.entry ? 'Edit quick add' : 'Quick add', dayLabel(S.date, today()))}
    ${S.entry ? '' : `<div class="seg" role="tablist">${[['search', 'Search'], ['scan', 'Scan'], ['quick', 'Quick add'], ['mine', 'My foods']].map(([id, l]) => `<button data-act="add-tab" data-v="${id}" aria-pressed="${id === 'quick'}">${l}</button>`).join('')}</div>`}
    <p class="prose" style="margin-top:16px">For takeaways, meals out, or anything you just know the calories of.</p>
    <label class="field"><span>Name (optional)</span><input class="input" id="qa-name" value="${esc(e.food ? '' : e.name === 'Quick add' ? '' : e.name || '')}" placeholder="e.g. Nando's half chicken"></label>
    <label class="field"><span>Calories</span><div class="input-unit"><input class="input num" id="qa-kcal" inputmode="numeric" value="${e.kcal ?? ''}"><em>kcal</em></div></label>
    <div class="grid-3">
      <label class="field"><span>Protein</span><div class="input-unit"><input class="input num" id="qa-p" inputmode="decimal" value="${e.protein || ''}"><em>g</em></div></label>
      <label class="field"><span>Carbs</span><div class="input-unit"><input class="input num" id="qa-c" inputmode="decimal" value="${e.carbs || ''}"><em>g</em></div></label>
      <label class="field"><span>Fat</span><div class="input-unit"><input class="input num" id="qa-f" inputmode="decimal" value="${e.fat || ''}"><em>g</em></div></label>
    </div>
    <label class="field"><span>Time</span><input class="input num" id="qa-time" type="time" value="${e.time || (S.date === today() ? nowTime() : '12:00')}"></label>
    <div class="sticky-foot">
      ${S.entry ? `<button class="btn btn-danger" data-act="del-entry" aria-label="Delete">${icon.trash}</button>` : ''}
      <button class="btn btn-primary" data-act="save-quick">${S.entry ? 'Save' : 'Add'}</button>
    </div></main>`;
  if (!S.entry) document.getElementById('qa-kcal').focus();
}
async function saveQuick() {
  const v = id => parseFloat(document.getElementById(id).value) || 0;
  const kcal = Math.round(v('qa-kcal'));
  if (!(kcal > 0)) return toast('Enter the calories.');
  const e = S.entry ? { ...S.entry } : { id: uid(), date: S.date, created: Date.now() };
  Object.assign(e, {
    name: document.getElementById('qa-name').value.trim() || 'Quick add', brand: '', food: null, amount: null,
    time: document.getElementById('qa-time').value, kcal, protein: v('qa-p'), carbs: v('qa-c'), fat: v('qa-f'),
  });
  await db.put('entries', e);
  toast(S.entry ? 'Saved' : `Added ${fmt(kcal)} kcal`);
  S.entry = null;
  go('today', { root: true });
}

/* ---------- Custom food editor ---------- */
async function viewEditor() {
  const d = S.draft;
  const per = d.per;
  $app.innerHTML = `<main class="view no-tabs">
    ${topbar(myFoods.some(f => f.id === d.id) ? 'Edit food' : 'New food', d.barcode ? 'Barcode ' + d.barcode : '')}
    <p class="prose">Copy the numbers from the label.</p>
    <label class="field"><span>Name</span><input class="input" id="e-name" value="${esc(d.name)}" placeholder="e.g. Protein yoghurt, vanilla"></label>
    <label class="field"><span>Brand (optional)</span><input class="input" id="e-brand" value="${esc(d.brand)}"></label>
    <div class="label">Nutrition is</div>
    <div class="seg" style="margin-bottom:14px">${[['100g', 'Per 100 g'], ['serving', 'Per serving']].map(([v, l]) => `<button data-act="e-per" data-v="${v}" aria-pressed="${per === v}">${l}</button>`).join('')}</div>
    <div class="grid-2">
      <label class="field"><span>Calories</span><div class="input-unit"><input class="input num" id="e-kcal" inputmode="numeric" value="${d.kcal}"><em>kcal</em></div></label>
      ${per === '100g' ? `<label class="field"><span>Serving size (optional)</span><div class="input-unit"><input class="input num" id="e-serv" inputmode="decimal" value="${d.servingG || ''}"><em>g</em></div></label>` : '<div></div>'}
    </div>
    <div class="grid-3">
      <label class="field"><span>Protein</span><div class="input-unit"><input class="input num" id="e-p" inputmode="decimal" value="${d.protein}"><em>g</em></div></label>
      <label class="field"><span>Carbs</span><div class="input-unit"><input class="input num" id="e-c" inputmode="decimal" value="${d.carbs}"><em>g</em></div></label>
      <label class="field"><span>Fat</span><div class="input-unit"><input class="input num" id="e-f" inputmode="decimal" value="${d.fat}"><em>g</em></div></label>
    </div>
    <div class="sticky-foot">
      ${myFoods.some(f => f.id === d.id) ? `<button class="btn btn-danger" data-act="del-food" aria-label="Delete">${icon.trash}</button>` : ''}
      <button class="btn btn-primary" data-act="save-custom">Save food</button>
    </div></main>`;
}
function readEditor() {
  const d = S.draft, val = id => document.getElementById(id)?.value ?? '';
  Object.assign(d, {
    name: val('e-name').trim(), brand: val('e-brand').trim(), kcal: val('e-kcal'), protein: val('e-p'),
    carbs: val('e-c'), fat: val('e-f'), servingG: d.per === '100g' ? val('e-serv') : '',
  });
}

/* ---------- Recipe / usual meal builder ---------- */
async function viewRecipe() {
  const r = S.recipe;
  const tot = r.items.reduce((t, it) => { const n = C.scaleFood(it.food, it.amount); for (const k in t) t[k] += n[k]; return t; }, { kcal: 0, protein: 0, carbs: 0, fat: 0 });
  const per = k => tot[k] / (r.servings || 1);
  $app.innerHTML = `<main class="view no-tabs">
    ${topbar(r.existing ? 'Edit recipe' : 'New recipe or meal')}
    <p class="prose">Build it once: a recipe you batch-cook, or a usual breakfast. It logs as one item.</p>
    <label class="field"><span>Name</span><input class="input" id="r-name" value="${esc(r.name)}" placeholder="e.g. Chicken rice meal prep"></label>
    <label class="field"><span>Makes how many servings?</span><div class="input-unit"><input class="input num" id="r-serv" inputmode="numeric" value="${r.servings}"><em>×</em></div></label>
    <div class="label">Ingredients<span class="aside">${r.items.length}</span></div>
    ${r.items.length ? `<div class="list">${r.items.map((it, i) => {
      const n = C.scaleFood(it.food, it.amount);
      return `<div class="item"><span class="main"><span class="title">${esc(it.food.name)}</span><span class="meta">${it.food.per === 'serving' ? fmt1(it.amount) + '×' : fmt(it.amount) + ' g'}</span></span>
        <span class="kcal">${fmt(n.kcal)}<small>kcal</small></span><button class="icon-btn" data-act="r-del" data-i="${i}" aria-label="Remove">${icon.trash}</button></div>`;
    }).join('')}</div>` : ''}
    <button class="btn btn-block" data-act="r-add" style="margin-top:12px">${icon.plus} Add ingredient</button>
    <div class="label">Per serving</div>
    <div class="preview" style="margin-top:0">${previewHtml({ kcal: per('kcal'), protein: per('protein'), carbs: per('carbs'), fat: per('fat') })}</div>
    <div class="sticky-foot">
      ${r.existing ? `<button class="btn btn-danger" data-act="del-food" aria-label="Delete">${icon.trash}</button>` : ''}
      <button class="btn btn-primary" data-act="r-save" ${r.items.length ? '' : 'disabled'}>Save</button>
    </div></main>`;
  const keep = () => { r.name = document.getElementById('r-name').value; r.servings = Math.max(1, parseInt(document.getElementById('r-serv').value) || 1); };
  document.getElementById('r-name').addEventListener('input', keep);
  document.getElementById('r-serv').addEventListener('change', () => { keep(); render(); });
}

/* ---------- Weight ---------- */
async function viewWeight() {
  const s = S.settings, unit = s.unit, t = today();
  const ws = await weights();
  const series = C.trendSeries(ws);
  const todayW = ws.find(w => w.date === t);
  const last = series[series.length - 1];
  const trendAgo = n => C.trendOn(series, C.addDays(t, -n));
  const d7 = last && trendAgo(7) != null ? last.trend - trendAgo(7) : null;
  const d30 = last && trendAgo(30) != null ? last.trend - trendAgo(30) : null;
  const toUnit = kg => (unit === 'stlb' ? kg * C.LB_PER_KG : kg);
  const input = unit === 'stlb'
    ? `<div class="grid-2"><div class="input-unit"><input class="input num" id="w-st" inputmode="numeric" value="${todayW ? C.kgToStLb(todayW.kg).st : ''}" placeholder="st"><em>st</em></div>
       <div class="input-unit"><input class="input num" id="w-lb" inputmode="decimal" value="${todayW ? C.kgToStLb(todayW.kg).lb : ''}" placeholder="lb"><em>lb</em></div></div>`
    : `<div class="input-unit"><input class="input num" id="w-kg" inputmode="decimal" value="${todayW ? todayW.kg : ''}" placeholder="${last ? fmt1(last.kg) : '0.0'}"><em>kg</em></div>`;

  $app.innerHTML = `<main class="view">
    <header class="topbar"><h1>Weight</h1></header>
    <div style="display:flex;gap:10px;align-items:stretch"><div style="flex:1">${input}</div>
      <button class="btn btn-primary" data-act="save-weight">${todayW ? 'Update' : 'Log'}</button></div>
    <p class="small faint" style="margin-top:8px">${todayW ? `Logged today: ${C.fmtWeight(todayW.kg, unit)}` : 'Same time each day, ideally first thing in the morning.'}</p>
    ${series.length ? `
      <div class="figures" style="margin-top:20px">
        <div><b>${C.fmtWeight(last.trend, unit)}</b><span>Trend weight</span></div>
        <div><b>${d7 == null ? '–' : C.fmtWeightDelta(d7, unit)}</b><span>7 days</span></div>
        <div><b>${d30 == null ? '–' : C.fmtWeightDelta(d30, unit)}</b><span>30 days</span></div>
      </div>
      <div class="label">Trend<span class="aside"></span></div>
      <div class="seg" style="margin-bottom:8px">${[[30, '30 days'], [90, '90 days'], [365, 'Year'], [0, 'All']].map(([v, l]) => `<button data-act="w-range" data-v="${v}" aria-pressed="${S.chartRange === v}">${l}</button>`).join('')}</div>
      <div class="chart-wrap" id="w-chart"></div>
      <div class="legend"><span><i class="l-trend"></i>Trend</span><span><i class="l-dot"></i>Scale</span></div>
      <p class="small muted" style="margin-top:12px">Daily weight jumps around with water, salt and food in your gut. The trend line smooths that out so you can see what your body fat is really doing.</p>
      <div class="label">History</div>
      <div class="list">${[...series].reverse().slice(0, 60).map(p => `<div class="item">
        <span class="main"><span class="title">${dayLabel(p.date, t)}</span><span class="meta">Trend ${C.fmtWeight(p.trend, unit)}</span></span>
        <span class="kcal" style="font-size:18px">${C.fmtWeight(p.kg, unit)}</span>
        <button class="icon-btn" data-act="del-weight" data-v="${p.date}" aria-label="Delete">${icon.trash}</button></div>`).join('')}</div>`
    : `<div class="empty" style="margin-top:24px"><b>No weigh-ins yet</b>Weigh in most days. Fuel uses the trend, not single readings, so a bad morning won't throw it off.</div>`}
  </main>${tabbar('weight')}`;

  if (series.length) {
    const first = S.chartRange ? C.addDays(t, -S.chartRange + 1) : series[0].date;
    const start = first < series[0].date ? series[0].date : first;
    const days = [];
    const byDate = Object.fromEntries(series.map(p => [p.date, p]));
    for (let d = start; d <= t; d = C.addDays(d, 1)) days.push({ date: d, kg: byDate[d]?.kg ?? null, trend: C.trendOn(series, d) });
    weightChart(document.getElementById('w-chart'), days, { toUnit, fmt: kg => C.fmtWeight(kg, unit) });
  }
}

/* ---------- Progress ---------- */
async function viewProgress() {
  const s = S.settings, t = today();
  const [totals, ws, checkins] = await Promise.all([dayTotals(), weights(), db.all('checkins')]);
  const series = C.trendSeries(ws);
  const est = C.estimateTdee({ dayTotals: totals, weights: ws, initial: s.initialTdee, today: t });
  const loggedDates = Object.keys(totals).filter(d => totals[d].kcal > 0);
  const streak = C.weeklyStreak(loggedDates, s.streakTarget, t);
  const lastCheck = checkins.sort((a, b) => a.date.localeCompare(b.date)).pop();
  const daysSince = lastCheck ? C.daysBetween(lastCheck.date, t) : 99;
  const wKg = currentWeightKg(series);
  const suggested = C.calorieTarget(est.estimate, s.ratePct, wKg, s.sex);
  const changed = Math.abs(suggested - s.kcalTarget) >= 30 || Math.abs(est.estimate - s.tdee) >= 30;
  const canCheck = est.ready && daysSince >= 6 && changed && !s.manualKcal;

  const unit = s.unit;
  const rate = C.rateKgPerWeek(s.ratePct, wKg);
  let checkin;
  if (!est.ready) {
    const need = Math.max(0, C.MIN_LOGGED_DAYS - est.loggedDays);
    checkin = `<div class="panel checkin">
      <div class="label" style="margin-top:0">Calibrating</div>
      <p class="prose">Log food and weigh in for ${need ? `<strong>${need} more day${need > 1 ? 's' : ''}</strong>` : 'a few more days'} and Fuel will work out what you actually burn, from your own data.</p>
      <div class="meter"><i style="width:${Math.min(100, (est.loggedDays / C.MIN_LOGGED_DAYS) * 100)}%"></i></div>
      <p class="small faint">${est.loggedDays} of ${C.MIN_LOGGED_DAYS} logged days · ${est.weighIns} weigh-ins in the last 4 weeks (need 4)</p>
    </div>`;
  } else {
    checkin = `<div class="panel checkin">
      <div class="label" style="margin-top:0">Your expenditure</div>
      <div class="big">${fmt(est.estimate)}<small>kcal a day</small></div>
      <div class="calc">
        Ate <b>${fmt(est.avgIntake)}</b> kcal/day on ${est.loggedDays} logged days<br>
        Trend ${est.slopeKgPerWeek <= 0 ? 'fell' : 'rose'} <b>${C.fmtWeightDelta(est.slopeKgPerWeek, unit).replace(/^[+−±]/, '')}</b> a week<br>
        ${fmt(est.avgIntake)} ${est.slopeKgPerWeek <= 0 ? '+' : '−'} 7,700 × ${fmt1(Math.abs(est.slopeKgPerWeek))} ÷ 7 = <b>${fmt(est.observed)}</b><br>
        <span class="faint">${est.confidence >= 1 ? 'Based fully on your own data' : `${Math.round(est.confidence * 100)}% your data, the rest from the starting estimate`}</span>
      </div>
      ${s.manualKcal ? `<p class="small muted">You're setting your ${targetMode(s) === 'macros' ? 'macros' : 'calories'} by hand, so Fuel won't change them. At this burn, ${s.ratePct ? `${s.ratePct < 0 ? 'losing' : 'gaining'} ${fmt1(Math.abs(rate))} kg a week` : 'holding your weight'} needs about <strong>${fmt(suggested)} kcal</strong>. Switch to Automatic in Settings to have Fuel manage it.</p>`
      : canCheck ? `<p class="prose">To ${s.ratePct < 0 ? 'lose' : s.ratePct > 0 ? 'gain' : 'hold'}${s.ratePct ? ` ${fmt1(Math.abs(rate))} kg a week` : ''}, your new target is <strong>${fmt(suggested)} kcal</strong> (now ${fmt(s.kcalTarget)}).</p>
          <button class="btn btn-go btn-block" data-act="apply-checkin">Update my target to ${fmt(suggested)}</button>`
      : `<p class="small muted">${lastCheck ? `Last check-in ${dayLabel(lastCheck.date, t).toLowerCase()}.` : ''} ${changed ? `Next check-in in ${Math.max(1, 6 - daysSince)} day${6 - daysSince === 1 ? '' : 's'}.` : 'Your target already matches. Keep going.'}</p>`}
    </div>`;
  }

  const N = S.intakeRange;
  const days = [];
  for (let i = N - 1; i >= 0; i--) { const d = C.addDays(t, -i); days.push({ date: d, kcal: Math.round(totals[d]?.kcal || 0) }); }

  // Weekly averages, last 8 weeks
  const weeks = [];
  let mon = C.mondayOf(t);
  for (let w = 0; w < 8; w++) {
    let kc = 0, pr = 0, n = 0;
    for (let i = 0; i < 7; i++) { const d = C.addDays(mon, i); if (totals[d]?.kcal > 0) { kc += totals[d].kcal; pr += totals[d].protein; n++; } }
    const tStart = C.trendOn(series, C.addDays(mon, -1)), tEnd = C.trendOn(series, w === 0 ? t : C.addDays(mon, 6));
    weeks.push({ mon, n, kcal: n ? kc / n : null, protein: n ? pr / n : null, change: tStart != null && tEnd != null ? tEnd - tStart : null });
    mon = C.addDays(mon, -7);
  }

  $app.innerHTML = `<main class="view">
    <header class="topbar"><h1>Progress</h1></header>
    ${checkin}
    <div class="label">Streak<span class="aside">${streak.thisWeek} day${streak.thisWeek === 1 ? '' : 's'} this week · goal ${streak.target}</span></div>
    <div style="display:flex;align-items:baseline;gap:10px"><span class="num" style="font-size:40px;font-weight:650;line-height:1">${streak.streak}</span>
      <span class="muted">week${streak.streak === 1 ? '' : 's'} in a row logging ${streak.target}+ days</span></div>
    <div class="week">${streak.days.map((d, i) => `<div class="${d.logged ? 'on' : ''} ${d.future ? 'future' : ''} ${d.date === t ? 'today' : ''}"><i></i>${'MTWTFSS'[i]}</div>`).join('')}</div>
    <p class="small faint" style="margin-top:10px">Miss a day and the streak survives. It only counts whole weeks.</p>

    <div class="label">Calories</div>
    <div class="seg" style="margin-bottom:8px">${[[14, '2 weeks'], [30, '30 days'], [90, '90 days']].map(([v, l]) => `<button data-act="i-range" data-v="${v}" aria-pressed="${N === v}">${l}</button>`).join('')}</div>
    <div class="chart-wrap" id="i-chart"></div>
    <div class="legend"><span><i class="l-bar"></i>Eaten</span><span><i class="l-target"></i>Target</span>${est.ready ? '<span><i class="l-burn"></i>You burn</span>' : ''}</div>

    <div class="label">Weekly averages</div>
    <table class="weeks"><thead><tr><th>Week of</th><th>Kcal</th><th>Protein</th><th>Trend</th></tr></thead><tbody>
      ${weeks.map(w => `<tr><td>${w.mon === C.mondayOf(t) ? 'This week' : C.parseIso(w.mon).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</td>
        <td>${w.kcal == null ? '<span class="faint">–</span>' : fmt(w.kcal)}</td><td>${w.protein == null ? '<span class="faint">–</span>' : fmt(w.protein) + 'g'}</td>
        <td>${w.change == null ? '<span class="faint">–</span>' : C.fmtWeightDelta(w.change, unit)}</td></tr>`).join('')}
    </tbody></table>
    <p class="small faint" style="margin-top:10px">Averages count only days you logged.</p>
  </main>${tabbar('progress')}`;
  intakeChart(document.getElementById('i-chart'), days, { target: s.kcalTarget, expenditure: est.ready ? est.estimate : null });
  S._est = { est, suggested };
}

/* ---------- Settings ---------- */
async function viewSettings() {
  const s = S.settings;
  const standalone = isStandalone();
  const persisted = navigator.storage?.persisted ? await navigator.storage.persisted().catch(() => false) : false;
  const mode = S.settingsMode || targetMode(s); // unsaved choice survives re-renders until Save
  $app.innerHTML = `<main class="view">
    <header class="topbar"><h1>Settings</h1></header>
    ${!standalone ? `<div class="nudge" style="margin-top:0">${icon.share}<div class="main"><b>Install Fuel on your phone</b><span>${isIos() ? 'In Safari tap Share, then Add to Home Screen.' : 'Open the browser menu and choose Install app.'} Installed, it works offline and your data is protected from clean-ups.</span></div></div>` : ''}

    <div class="label">Targets</div>
    <div class="preview" style="margin-top:0">${previewHtml({ kcal: s.kcalTarget, protein: s.protein, carbs: s.carbs, fat: s.fat })}</div>
    <label class="field" style="margin-top:14px"><span>Goal</span><select class="input" id="s-goal">${C.GOALS.map(g => `<option value="${g.id}" ${s.ratePct === g.id ? 'selected' : ''}>${g.label}${g.id ? ` (${Math.abs(g.id)}% a week)` : ''}</option>`).join('')}</select></label>
    <label class="field"><span>Set targets</span>
      <div class="seg">${[['auto', 'Automatic'], ['kcal', 'Calories'], ['macros', 'Macros']].map(([v, l]) => `<button data-act="s-mode" data-v="${v}" aria-pressed="${mode === v}">${l}</button>`).join('')}</div></label>
    <p class="small faint" style="margin:-6px 0 14px">${{
      auto: 'Fuel sets calories from your goal and adjusts them at each weekly check-in.',
      kcal: 'You set the calories. Protein comes from your weight; fat is 25% and carbs fill the rest.',
      macros: 'You set protein, carbs and fat. Calories are worked out from them (4 / 4 / 9 kcal per gram).',
    }[mode]}</p>
    ${mode === 'kcal' ? `<label class="field"><span>Calories</span><div class="input-unit"><input class="input num" id="s-kcal" inputmode="numeric" value="${s.kcalTarget}"><em>kcal</em></div></label>` : ''}
    ${mode === 'macros' ? `<div class="grid-3">
      <label class="field"><span>Protein</span><div class="input-unit"><input class="input num" id="s-mp" inputmode="numeric" value="${s.protein}"><em>g</em></div></label>
      <label class="field"><span>Carbs</span><div class="input-unit"><input class="input num" id="s-mc" inputmode="numeric" value="${s.carbs}"><em>g</em></div></label>
      <label class="field"><span>Fat</span><div class="input-unit"><input class="input num" id="s-mf" inputmode="numeric" value="${s.fat}"><em>g</em></div></label>
    </div>
    <p class="small muted" id="s-mtotal" style="margin:-4px 0 14px"></p>` : ''}
    <div class="grid-2">
      ${mode === 'macros' ? '' : `<label class="field"><span>Protein per kg</span><div class="input-unit"><input class="input num" id="s-ppk" inputmode="decimal" value="${s.proteinPerKg}"><em>g</em></div></label>`}
      <label class="field"><span>Streak: days a week</span><select class="input" id="s-streak">${[3, 4, 5, 6, 7].map(n => `<option ${s.streakTarget === n ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
    </div>

    <div class="label">You</div>
    <div class="grid-2">
      <label class="field"><span>Age</span><div class="input-unit"><input class="input num" id="s-age" inputmode="numeric" value="${s.age}"><em>yrs</em></div></label>
      <label class="field"><span>Height</span><div class="input-unit"><input class="input num" id="s-h" inputmode="numeric" value="${s.heightCm}"><em>cm</em></div></label>
    </div>
    <label class="field"><span>Activity</span><select class="input" id="s-act">${C.ACTIVITY.map(a => `<option value="${a.id}" ${s.activity === a.id ? 'selected' : ''}>${a.label}</option>`).join('')}</select></label>
    <label class="field"><span>Weight units</span><div class="seg">${[['kg', 'kg'], ['stlb', 'st & lb']].map(([v, l]) => `<button data-act="s-unit" data-v="${v}" aria-pressed="${s.unit === v}">${l}</button>`).join('')}</div></label>
    <button class="btn btn-primary btn-block" data-act="save-settings" style="margin-top:6px">Save changes</button>
    <p class="small faint" style="margin-top:10px">Starting estimate: ${fmt(s.initialTdee)} kcal (Mifflin-St Jeor). Currently using ${fmt(s.tdee)} kcal.</p>

    <div class="label">Your data</div>
    <p class="prose small">Everything is stored on this phone only${persisted ? ', protected from automatic clean-up' : ''}. Export a backup now and then, and save it to Files or iCloud Drive.</p>
    <div class="row-actions"><button class="btn" data-act="export">${icon.share} Export backup</button>
      <label class="btn">Restore backup<input type="file" id="import" accept="application/json,.json" hidden></label></div>

    <div class="label">About</div>
    <p class="prose small">Generic foods: McCance and Widdowson's Composition of Foods Integrated Dataset (CoFID) 2021, Public Health England, Open Government Licence v3.0. Branded products: Open Food Facts, Open Database Licence. Trend weight from The Hacker's Diet (John Walker).</p>
    <button class="btn btn-danger btn-sm" data-act="reset" style="margin-top:8px">Delete all data</button>
  </main>${tabbar('settings')}`;
  const total = document.getElementById('s-mtotal');
  if (total) {
    const upd = () => {
      const g = id => Math.max(0, parseFloat(document.getElementById(id).value) || 0);
      const kcal = g('s-mp') * 4 + g('s-mc') * 4 + g('s-mf') * 9;
      total.innerHTML = `= <b class="num" style="color:var(--text);font-size:17px">${fmt(kcal)}</b> kcal a day`;
    };
    ['s-mp', 's-mc', 's-mf'].forEach(id => document.getElementById(id).addEventListener('input', upd));
    upd();
  }
  document.getElementById('import').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      await db.importAll(JSON.parse(await file.text()));
      S.settings = await db.meta('settings');
      await refreshMyFoods();
      toast('Backup restored');
      go('today', { root: true });
    } catch (err) { toast(err.message || "That file couldn't be read."); }
  });
}

async function exportBackup() {
  const data = await db.exportAll();
  const name = `fuel-backup-${today()}.json`;
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const file = new File([blob], name, { type: 'application/json' });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'Fuel backup' }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

/* ================= Actions ================= */
const actions = {
  back,
  tab: v => {
    if (v === 'add') { S.addTab = 'search'; S.query = ''; S.online = null; S.recipe = null; }
    if (v === 'today' && S.view === 'today') S.date = today();
    S.settingsMode = null;
    go(v, { root: v !== 'add' });
  },
  day: v => { const d = C.addDays(S.date, +v); if (d <= today()) { S.date = d; render(); } },
  'add-tab': v => {
    if (S.scan) { S.scan.stop(); S.scan = null; }
    S.addTab = v;
    if (v === 'quick') { S.entry = null; S.view = 'quick'; return render(); }
    S.view = 'add'; render();
  },
  online: () => runOnline(),
  'open-food': (v, el) => { const f = foodIndex.get(el.dataset.id); if (f) openFood(f); },
  chip: v => {
    S.amount = +v;
    const amt = document.getElementById('amt');
    amt.value = v; amt.dispatchEvent(new Event('input'));
  },
  fav: async () => { const on = await toggleFav(S.food); toast(on ? 'Added to favourites' : 'Removed from favourites'); render(); },
  'save-food': () => saveFoodEntry(),
  'save-quick': () => saveQuick(),
  'edit-entry': async (v, el) => {
    const e = await db.get('entries', el.dataset.id);
    S.entry = e;
    if (!e.food) return go('quick');
    S.food = e.food; S.amount = e.amount; S.time = e.time;
    go('food');
  },
  'del-entry': async () => {
    const e = S.entry;
    await db.del('entries', e.id);
    S.entry = null;
    go('today', { root: true });
    toast('Deleted ' + e.name, { label: 'Undo', run: async () => { await db.put('entries', e); render(); } });
  },
  'copy-prev': async () => {
    const prev = await entriesFor(C.addDays(S.date, -1));
    if (!prev.length) return toast('Nothing logged the day before.');
    for (const e of prev) await db.put('entries', { ...e, id: uid(), date: S.date, created: Date.now() });
    toast(`Copied ${prev.length} item${prev.length > 1 ? 's' : ''}`);
    render();
  },
  'bc-go': () => { const v = document.getElementById('bc').value.trim(); if (v) handleBarcode(v); },

  'new-food': () => {
    S.draft = { id: uid(), source: 'mine', per: '100g', name: S.query || '', brand: '', barcode: '', kcal: '', protein: '', carbs: '', fat: '', servingG: '' };
    go('editor');
  },
  'e-per': v => { readEditor(); S.draft.per = v; render(); },
  'save-custom': async () => {
    readEditor();
    const d = S.draft;
    if (!d.name) return toast('Give it a name.');
    if (!(parseFloat(d.kcal) >= 0) || d.kcal === '') return toast('Enter the calories.');
    const food = {
      id: d.id, source: 'mine', per: d.per, name: d.name, brand: d.brand, barcode: d.barcode || undefined,
      kcal: Math.round(+d.kcal), protein: +d.protein || 0, carbs: +d.carbs || 0, fat: +d.fat || 0,
      servingG: d.per === '100g' && +d.servingG ? +d.servingG : null,
    };
    await db.put('foods', food);
    await refreshMyFoods();
    toast('Saved');
    while (S.stack.length && !['add', 'today'].includes(S.stack[S.stack.length - 1])) S.stack.pop();
    S.view = S.stack.pop() || 'today';
    openFood(food);
  },
  'edit-food': () => {
    const f = S.food;
    if (f.recipe) S.recipe = { existing: f.id, name: f.name, servings: f.recipe.servings, items: [...f.recipe.items] };
    else S.draft = { ...f, servingG: f.servingG || '' };
    go(f.recipe ? 'recipe' : 'editor');
  },
  'del-food': async () => {
    const id = S.recipe?.existing || S.draft?.id;
    if (!id || !confirm('Delete this food? Past entries stay in your log.')) return;
    await db.del('foods', id);
    const favs = (await db.meta('favs', [])).filter(f => f.id !== id);
    const recents = (await db.meta('recents', [])).filter(f => f.id !== id);
    await db.setMeta('favs', favs); await db.setMeta('recents', recents);
    await refreshMyFoods();
    S.recipe = null; S.addTab = 'mine';
    go('add', { root: true });
  },

  'new-recipe': () => { S.recipe = { name: '', servings: 1, items: [] }; go('recipe'); },
  'r-add': () => { S.addTab = 'search'; S.query = ''; S.online = null; go('add'); },
  'r-del': (v, el) => { S.recipe.items.splice(+el.dataset.i, 1); render(); },
  'r-save': async () => {
    const r = S.recipe;
    r.name = document.getElementById('r-name').value.trim();
    r.servings = Math.max(1, parseInt(document.getElementById('r-serv').value) || 1);
    if (!r.name) return toast('Give it a name.');
    const tot = r.items.reduce((t, it) => { const n = C.scaleFood(it.food, it.amount); for (const k in t) t[k] += n[k]; return t; }, { kcal: 0, protein: 0, carbs: 0, fat: 0 });
    const food = {
      id: r.existing || uid(), source: 'mine', per: 'serving', name: r.name, brand: '',
      kcal: Math.round(tot.kcal / r.servings), protein: Math.round((tot.protein / r.servings) * 10) / 10,
      carbs: Math.round((tot.carbs / r.servings) * 10) / 10, fat: Math.round((tot.fat / r.servings) * 10) / 10,
      recipe: { servings: r.servings, items: r.items },
    };
    await db.put('foods', food);
    await refreshMyFoods();
    S.recipe = null;
    toast('Saved ' + food.name);
    S.stack = ['today']; S.view = 'add'; S.addTab = 'mine';
    openFood(food);
  },

  'save-weight': async () => {
    const s = S.settings;
    let kg;
    if (s.unit === 'stlb') kg = C.stLbToKg(+document.getElementById('w-st').value || 0, +document.getElementById('w-lb').value || 0);
    else kg = parseFloat(document.getElementById('w-kg').value);
    if (!(kg >= 30 && kg <= 300)) return toast('Enter a valid weight.');
    await db.put('weights', { date: today(), kg: Math.round(kg * 100) / 100 });
    toast('Weight logged');
    render();
  },
  'del-weight': async v => {
    const w = await db.get('weights', v);
    await db.del('weights', v);
    render();
    toast('Weigh-in deleted', { label: 'Undo', run: async () => { await db.put('weights', w); render(); } });
  },
  'w-range': v => { S.chartRange = +v; render(); },
  'i-range': v => { S.intakeRange = +v; render(); },

  'apply-checkin': async () => {
    const { est, suggested } = S._est;
    const s = S.settings;
    s.tdee = est.estimate;
    const series = C.trendSeries(await weights());
    applyTargets(s, currentWeightKg(series));
    s.kcalTarget = suggested;
    Object.assign(s, C.macroTargets(s.kcalTarget, currentWeightKg(series), s.proteinPerKg));
    await saveSettings();
    await db.put('checkins', { date: today(), tdee: est.estimate, target: suggested, avgIntake: Math.round(est.avgIntake), slopeKgPerWeek: est.slopeKgPerWeek });
    toast('Target updated to ' + fmt(suggested));
    render();
  },

  's-mode': v => { S.settingsMode = v; render(); },
  's-unit': v => { S.settings.unit = v; render(); },
  'save-settings': async () => {
    const s = S.settings, val = id => document.getElementById(id)?.value;
    const age = +val('s-age'), h = +val('s-h');
    if (age >= 14 && age <= 100) s.age = age;
    if (h >= 120 && h <= 230) s.heightCm = h;
    s.activity = +val('s-act'); s.ratePct = +val('s-goal'); s.streakTarget = +val('s-streak');
    const ppk = parseFloat(val('s-ppk')); if (ppk >= 0.8 && ppk <= 3.5) s.proteinPerKg = ppk;
    const series = C.trendSeries(await weights());
    const w = currentWeightKg(series);
    const oldInitial = s.initialTdee;
    s.initialTdee = Math.round(C.initialTdee({ ...s, weightKg: w }));
    if (!(await db.all('checkins')).length || s.tdee === oldInitial) s.tdee = s.initialTdee; // no data-driven estimate yet
    const mode = S.settingsMode || targetMode(s);
    if (mode === 'kcal') {
      const k = +val('s-kcal');
      if (!(k >= 1000 && k <= 6000)) return toast('Calories must be between 1,000 and 6,000.');
      s.kcalTarget = k;
    }
    if (mode === 'macros') {
      const p = Math.round(+val('s-mp')), c = Math.round(+val('s-mc')), f = Math.round(+val('s-mf'));
      if (!(p >= 30 && p <= 400)) return toast('Protein must be between 30 and 400 g.');
      if (!(c >= 0 && c <= 900)) return toast('Carbs must be between 0 and 900 g.');
      if (!(f >= 20 && f <= 300)) return toast('Fat must be at least 20 g (and at most 300 g).');
      Object.assign(s, { protein: p, carbs: c, fat: f });
    }
    s.targetMode = mode;
    S.settingsMode = null;
    applyTargets(s, w);
    await saveSettings();
    toast('Saved');
    render();
  },
  export: () => exportBackup(),
  reset: async () => {
    if (!confirm('Delete every food, weigh-in and setting on this phone? This cannot be undone.')) return;
    if (!confirm('Really delete everything? Export a backup first if you might want it.')) return;
    for (const n of ['entries', 'weights', 'foods', 'checkins', 'meta']) await db.clear(n);
    location.reload();
  },

  // onboarding
  'o-sex': v => { S.settings.sex = v; keepOnboardInputs(); render(); },
  'o-unit': v => { keepOnboardInputs(); S.settings.unit = v; render(); },
  'o-act': v => { S.settings.activity = +v; render(); },
  'o-goal': v => { S.settings.ratePct = +v; render(); },
  'o-back': () => { S.onboardStep--; render(); },
  'o-next': async () => {
    const s = S.settings;
    if (S.onboardStep === 0) { const err = readOnboardStep0(); if (err) return toast(err); }
    if (S.onboardStep === 2) { s.initialTdee = Math.round(C.initialTdee(s)); s.tdee = s.initialTdee; }
    if (S.onboardStep < 3) { S.onboardStep++; return render(); }
    s.onboarded = true; s.created = today();
    applyTargets(s);
    await saveSettings();
    await db.put('weights', { date: today(), kg: s.weightKg });
    requestPersistence();
    go('today', { root: true });
  },
};
function keepOnboardInputs() { try { readOnboardStep0(); } catch (e) { /* partial input is fine */ } }

$app.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const fn = actions[el.dataset.act];
  if (fn) { e.preventDefault(); fn(el.dataset.v, el); }
});

/* ================= Boot ================= */
(async function boot() {
  S.settings = (await db.meta('settings')) || { ...DEFAULTS };
  [cofid] = await Promise.all([loadCofid(), refreshMyFoods()]);
  if (!S.settings.onboarded) { S.view = 'onboard'; }
  else requestPersistence();
  render();
  // New day while the app sat open in the background
  let lastSeen = today();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || lastSeen === today()) return;
    lastSeen = today();
    if (S.view === 'today') { S.date = today(); render(); }
  });
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
