// Seeded Monte Carlo net-worth simulator. All amounts are yearly, rates are percentages.
export function mulberry32(seed) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function defaultScenario() {
  return {
    name: 'Baseline', liquid: 50000, assets: [], debts: [], annualIncome: 70000, annualSpending: 50000,
    incomeGrowth: 3, inflation: 2.5, expectedReturn: 6, volatility: 14, debtRate: 6,
    horizonYears: 30, goal: 1000000, events: [], changes: [],
  };
}

const clone = (s) => JSON.parse(JSON.stringify(s));

// Annual total of 12 equal monthly payments that repay `balance` over `years`.
export function mortgagePayment(balance, ratePct, years) {
  const n = years * 12;
  const r = ratePct / 100 / 12;
  if (r === 0) return balance / years;
  return 12 * (balance * r) / (1 - (1 + r) ** -n);
}

export function buyHouse(s, { price, downPayment, rate, years, appreciation = 3, closingPct = 3, upkeepPct = 1.2, rentAvoided = 0 }) {
  years = Math.max(1, Math.round(years));
  const out = clone(s);
  out.liquid = s.liquid - downPayment - (price * closingPct) / 100;
  out.assets.push({ name: 'Home', value: price, growth: appreciation });
  out.debts.push({ name: 'Mortgage', balance: price - downPayment, rate, years });
  out.annualSpending = s.annualSpending + (price * upkeepPct) / 100 - rentAvoided;
  return out;
}

export function changeJob(s, { fromYear, toYear, incomeDelta, spendingDelta = 0, label = 'Job change' }) {
  const out = clone(s);
  out.changes.push({ fromYear, toYear, incomeDelta, spendingDelta, label });
  return out;
}

export function partTime(s, { fromYear, toYear, incomeCutPct, spendingCutPct = 0 }) {
  return changeJob(s, {
    fromYear, toYear, label: 'Go part-time',
    incomeDelta: -(s.annualIncome * incomeCutPct) / 100,
    spendingDelta: -(s.annualSpending * spendingCutPct) / 100,
  });
}

export function addEvent(s, { year, amount, label = 'One-off' }) {
  const out = clone(s);
  out.events.push({ year, amount, label });
  return out;
}

function normal(rng) {
  const u1 = Math.max(rng(), 1e-12);
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * rng());
}

const quantile = (sorted, q) => sorted[Math.floor(q * (sorted.length - 1))];

export function simulate(s, { trials = 1000, seed = 1 } = {}) {
  const H = s.horizonYears;
  const rng = mulberry32(seed);
  const m = s.expectedReturn / 100;
  const sigma = s.volatility / 100;
  const byYear = Array.from({ length: H + 1 }, () => new Float64Array(trials));
  let successes = 0;
  let ruined = 0;
  for (let t = 0; t < trials; t++) {
    let liquid = s.liquid;
    const assets = s.assets.map(a => ({ v: a.value, g: a.growth / 100 }));
    const debts = s.debts.map(d => ({
      bal: d.balance, r: d.rate / 100 / 12, left: d.years, monthly: mortgagePayment(d.balance, d.rate, d.years) / 12,
    }));
    const netWorth = () => liquid + assets.reduce((a, x) => a + x.v, 0) - debts.reduce((a, x) => a + x.bal, 0);
    byYear[0][t] = netWorth();
    let broke = false;
    for (let y = 1; y <= H; y++) {
      const growth = sigma > 0 ? (1 + m) * Math.exp(sigma * normal(rng) - (sigma * sigma) / 2) : 1 + m;
      liquid = liquid > 0 ? liquid * growth : liquid * (1 + s.debtRate / 100);
      for (const a of assets) a.v *= 1 + a.g;
      let income = s.annualIncome;
      let spending = s.annualSpending;
      for (const c of s.changes) {
        if (y >= c.fromYear && (c.toYear == null || y <= c.toYear)) { income += c.incomeDelta; spending += c.spendingDelta || 0; }
      }
      income *= (1 + s.incomeGrowth / 100) ** (y - 1);
      spending *= (1 + s.inflation / 100) ** (y - 1);
      let paid = 0;
      for (const d of debts) {
        if (d.left <= 0) continue;
        for (let k = 0; k < 12 && d.bal > 0; k++) {
          const interest = d.bal * d.r;
          const principal = Math.min(d.bal, d.monthly - interest);
          d.bal -= principal;
          paid += interest + principal;
        }
        d.left--;
        if (d.left === 0 || d.bal < 1e-6) d.bal = 0;
      }
      let events = 0;
      for (const e of s.events) if (e.year === y) events += e.amount;
      liquid += income - spending - paid + events;
      if (liquid < 0) broke = true;
      byYear[y][t] = netWorth();
    }
    if (byYear[H][t] >= s.goal) successes++;
    if (broke) ruined++;
  }
  const sorted = byYear.map(col => Array.from(col).sort((a, b) => a - b));
  return {
    years: Array.from({ length: H + 1 }, (_, i) => i),
    p10: sorted.map(c => quantile(c, 0.1)),
    median: sorted.map(c => quantile(c, 0.5)),
    p90: sorted.map(c => quantile(c, 0.9)),
    success: successes / trials,
    ruin: ruined / trials,
    trials,
  };
}

// Differences other - base. Scenarios with different horizons are compared at the last year both cover.
export function compare(base, other) {
  const year = Math.min(base.years.length, other.years.length) - 1;
  return {
    year,
    successDelta: other.success - base.success,
    ruinDelta: other.ruin - base.ruin,
    medianFinalDelta: other.median[year] - base.median[year],
  };
}
