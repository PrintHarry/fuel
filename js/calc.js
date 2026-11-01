// All the maths. Units: kg, cm, kcal, days.
export const KCAL_PER_KG = 7700; // energy in ~1 kg of body fat
const DAY = 86400000;

/* ---------- Dates (local time, as 'YYYY-MM-DD') ---------- */
export function iso(d = new Date()) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
export function parseIso(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
export function addDays(s, n) { const d = parseIso(s); d.setDate(d.getDate() + n); return iso(d); }
export function daysBetween(a, b) { return Math.round((parseIso(b) - parseIso(a)) / DAY); }
export function mondayOf(s) { const d = parseIso(s); const wd = (d.getDay() + 6) % 7; d.setDate(d.getDate() - wd); return iso(d); }

/* ---------- Units ---------- */
export const LB_PER_KG = 2.20462;
export function kgToStLb(kg) {
  const totalLb = kg * LB_PER_KG;
  let st = Math.floor(totalLb / 14), lb = Math.round((totalLb - st * 14) * 10) / 10;
  if (lb >= 14) { st += 1; lb -= 14; }
  return { st, lb };
}
export function stLbToKg(st, lb) { return (st * 14 + lb) / LB_PER_KG; }
export function fmtWeight(kg, unit, dp = 1) {
  if (kg == null || isNaN(kg)) return '–';
  if (unit === 'stlb') { const { st, lb } = kgToStLb(kg); return `${st} st ${lb.toFixed(dp)} lb`; }
  return `${kg.toFixed(dp)} kg`;
}
export function fmtWeightDelta(kg, unit) {
  const sign = kg > 0 ? '+' : kg < 0 ? '−' : '±';
  const a = Math.abs(kg);
  return unit === 'stlb' ? `${sign}${(a * LB_PER_KG).toFixed(1)} lb` : `${sign}${a.toFixed(1)} kg`;
}

/* ---------- Starting estimate ---------- */
export const ACTIVITY = [
  { id: 1.2, label: 'Mostly sitting', hint: 'Desk job, little exercise' },
  { id: 1.375, label: 'Lightly active', hint: 'Exercise 1–3 days a week' },
  { id: 1.55, label: 'Active', hint: 'Exercise 3–5 days a week' },
  { id: 1.725, label: 'Very active', hint: 'Hard training 5–6 days a week' },
  { id: 1.9, label: 'Athlete', hint: 'Twice a day or a physical job' },
];

// Mifflin-St Jeor: BMR = 10m + 6.25h − 5a + s, s = +5 (male) or −161 (female)
export function bmr({ sex, age, heightCm, weightKg }) {
  return 10 * weightKg + 6.25 * heightCm - 5 * age + (sex === 'female' ? -161 : 5);
}
export function initialTdee(p) { return bmr(p) * p.activity; }

// Goal rate is stored as % of body weight per week (negative = loss).
export const GOALS = [
  { id: -1.0, label: 'Lose fast', hint: '1% of body weight a week' },
  { id: -0.75, label: 'Lose', hint: '0.75% a week' },
  { id: -0.5, label: 'Lose steady', hint: '0.5% a week, easiest to keep muscle' },
  { id: 0, label: 'Maintain', hint: 'Hold your weight' },
  { id: 0.25, label: 'Lean gain', hint: '0.25% a week' },
  { id: 0.5, label: 'Gain', hint: '0.5% a week' },
];
export function rateKgPerWeek(ratePct, weightKg) { return (ratePct / 100) * weightKg; }

// Target = TDEE + daily energy for the weekly rate. Never below a safe floor.
export function calorieTarget(tdee, ratePct, weightKg, sex) {
  const daily = (rateKgPerWeek(ratePct, weightKg) * KCAL_PER_KG) / 7;
  const floor = sex === 'female' ? 1200 : 1500;
  return Math.max(floor, Math.round((tdee + daily) / 10) * 10);
}

// Protein 2 g per kg (good for keeping muscle in a cut), fat 25% of kcal, carbs the rest.
export function macroTargets(kcal, weightKg, proteinPerKg = 2.0) {
  const protein = Math.round(weightKg * proteinPerKg);
  const fat = Math.round((kcal * 0.25) / 9);
  const carbs = Math.max(0, Math.round((kcal - protein * 4 - fat * 9) / 4));
  return { protein, fat, carbs };
}

/* ---------- Trend weight ----------
   T_n = T_{n−1} + α (W_n − T_{n−1}),  α = 1 − 0.9^Δt  (Δt = days since last weigh-in)
   With daily weigh-ins α = 0.1, exactly The Hacker's Diet. */
export function trendSeries(weights) {
  const sorted = [...weights].sort((a, b) => a.date.localeCompare(b.date));
  const out = [];
  let prev = null;
  for (const w of sorted) {
    let t;
    if (!prev) t = w.kg;
    else {
      const gap = Math.max(1, daysBetween(prev.date, w.date));
      const a = 1 - Math.pow(0.9, gap);
      t = prev.trend + a * (w.kg - prev.trend);
    }
    prev = { date: w.date, kg: w.kg, trend: t };
    out.push(prev);
  }
  return out;
}

// Trend value on a given day (carried forward from the last weigh-in).
export function trendOn(series, date) {
  let v = null;
  for (const p of series) { if (p.date <= date) v = p.trend; else break; }
  return v;
}

// Least-squares slope (kg per day) of the trend inside [from, to].
function trendSlope(series, from, to) {
  const pts = series.filter(p => p.date >= from && p.date <= to).map(p => [daysBetween(from, p.date), p.trend]);
  if (pts.length < 2) return null;
  const n = pts.length, mx = pts.reduce((s, p) => s + p[0], 0) / n, my = pts.reduce((s, p) => s + p[1], 0) / n;
  let num = 0, den = 0;
  for (const [x, y] of pts) { num += (x - mx) * (y - my); den += (x - mx) ** 2; }
  return den === 0 ? null : num / den;
}

/* ---------- Adaptive expenditure ----------
   TDEE = average intake − 7700 × (trend slope in kg/day)
   Uses the last 28 days (ending yesterday). Only fully logged days count towards intake.
   Confidence grows with logged days, so early estimates lean on Mifflin-St Jeor. */
export const MIN_LOGGED_DAYS = 10;
export function estimateTdee({ dayTotals, weights, initial, today }) {
  const to = addDays(today, -1), from = addDays(today, -28);
  const logged = Object.entries(dayTotals).filter(([d, t]) => d >= from && d <= to && t.kcal > 0);
  const series = trendSeries(weights);
  const inWindow = weights.filter(w => w.date >= from && w.date <= to).length;
  const result = { initial, estimate: initial, loggedDays: logged.length, weighIns: inWindow, ready: false };
  if (logged.length < MIN_LOGGED_DAYS || inWindow < 4) return result;

  const avgIntake = logged.reduce((s, [, t]) => s + t.kcal, 0) / logged.length;
  const slope = trendSlope(series, from, to);
  if (slope == null) return result;
  let observed = avgIntake - KCAL_PER_KG * slope;
  observed = Math.min(initial * 1.6, Math.max(initial * 0.6, observed)); // guard against bad data
  const confidence = Math.min(1, logged.length / 21);
  const estimate = initial + confidence * (observed - initial);
  return {
    ...result, ready: true, avgIntake, slopeKgPerWeek: slope * 7, observed,
    confidence, estimate: Math.round(estimate / 10) * 10,
  };
}

/* ---------- Streaks ----------
   A week (Mon–Sun) counts if you logged on at least `target` days. */
export function weeklyStreak(loggedDates, target, today) {
  const set = new Set(loggedDates);
  const thisMon = mondayOf(today);
  const countWeek = mon => { let c = 0; for (let i = 0; i < 7; i++) if (set.has(addDays(mon, i))) c++; return c; };
  const thisWeek = countWeek(thisMon);
  let streak = thisWeek >= target ? 1 : 0;
  let mon = addDays(thisMon, -7);
  while (countWeek(mon) >= target) { streak++; mon = addDays(mon, -7); }
  const days = [];
  for (let i = 0; i < 7; i++) { const d = addDays(thisMon, i); days.push({ date: d, logged: set.has(d), future: d > today }); }
  return { streak, thisWeek, target, days };
}

/* ---------- Food maths ---------- */
// Nutrients for a food are stored per 100 g (or per 1 serving for recipes/quick-add).
export function scaleFood(food, grams) {
  const f = food.per === 'serving' ? grams : grams / 100; // for 'serving', grams holds the number of servings
  const r = v => (v == null ? 0 : Math.round(v * f * 10) / 10);
  return { kcal: Math.round((food.kcal || 0) * f), protein: r(food.protein), carbs: r(food.carbs), fat: r(food.fat) };
}
export function sumEntries(entries) {
  return entries.reduce((t, e) => ({
    kcal: t.kcal + (e.kcal || 0), protein: t.protein + (e.protein || 0),
    carbs: t.carbs + (e.carbs || 0), fat: t.fat + (e.fat || 0),
  }), { kcal: 0, protein: 0, carbs: 0, fat: 0 });
}
