import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openNodeDb } from '../src/core/db-node.js';
import { migrate } from '../src/core/schema.js';
import {
  defaultScenario, simulate, compare, mortgagePayment, buyHouse, changeJob, partTime, addEvent, mulberry32,
} from '../src/modules/money/montecarlo.js';
import { fanChart, formatMoney } from '../src/modules/money/chart.js';
import { saveScenario, listScenarios, getScenario, deleteScenario, moneySearch } from '../src/modules/money/repo.js';

async function fresh() {
  const db = await openNodeDb(join(mkdtempSync(join(tmpdir(), 'mybrain-')), 't.db'));
  await migrate(db);
  return db;
}

const calm = (o = {}) => ({ ...defaultScenario(), liquid: 100000, annualIncome: 0, annualSpending: 0, expectedReturn: 5, volatility: 0, inflation: 0, incomeGrowth: 0, debtRate: 0, horizonYears: 10, goal: 150000, ...o });

test('the random generator is deterministic per seed and stays in [0, 1)', () => {
  const a = mulberry32(7), b = mulberry32(7);
  for (let i = 0; i < 100; i++) { const x = a(); assert.equal(x, b()); assert.ok(x >= 0 && x < 1); }
});

test('with no volatility, money just compounds at the expected return', () => {
  const r = simulate(calm(), { trials: 50, seed: 1 });
  assert.ok(Math.abs(r.median[10] - 100000 * 1.05 ** 10) < 1, String(r.median[10]));
  assert.equal(r.median.length, 11);
  assert.equal(r.years.length, 11);
  assert.equal(r.median[0], 100000);
});

test('simulate is deterministic for the same seed and differs for another', () => {
  const s = calm({ volatility: 15 });
  assert.deepEqual(simulate(s, { trials: 200, seed: 3 }).median, simulate(s, { trials: 200, seed: 3 }).median);
  assert.notDeepEqual(simulate(s, { trials: 200, seed: 3 }).median, simulate(s, { trials: 200, seed: 4 }).median);
});

test('percentile bands are ordered and widen with volatility', () => {
  const r = simulate(calm({ volatility: 18 }), { trials: 600, seed: 5 });
  for (let y = 0; y <= 10; y++) assert.ok(r.p10[y] <= r.median[y] && r.median[y] <= r.p90[y], `year ${y}`);
  const calmer = simulate(calm({ volatility: 5 }), { trials: 600, seed: 5 });
  assert.ok(r.p90[10] - r.p10[10] > calmer.p90[10] - calmer.p10[10]);
});

test('success probability is 1 for an easy goal and 0 for an impossible one', () => {
  assert.equal(simulate(calm({ goal: 10000 }), { trials: 100, seed: 1 }).success, 1);
  assert.equal(simulate(calm({ goal: 10_000_000 }), { trials: 100, seed: 1 }).success, 0);
});

test('spending more than you earn with little money gets a ruin probability of 1', () => {
  const r = simulate(calm({ liquid: 5000, annualIncome: 30000, annualSpending: 40000, goal: 0 }), { trials: 100, seed: 1 });
  assert.equal(r.ruin, 1);
  assert.equal(simulate(calm(), { trials: 100, seed: 1 }).ruin, 0);
});

test('a one-off event in year 3 changes the final amount by exactly that amount when nothing grows', () => {
  const base = calm({ expectedReturn: 0 });
  const withEvent = addEvent(base, { year: 3, amount: -1000, label: 'Car repair' });
  const d = simulate(base, { trials: 20, seed: 1 }).median[10] - simulate(withEvent, { trials: 20, seed: 1 }).median[10];
  assert.ok(Math.abs(d - 1000) < 1e-6, String(d));
});

test('income and spending flow into savings each year, growing with their rates', () => {
  const s = calm({ expectedReturn: 0, annualIncome: 60000, annualSpending: 50000, incomeGrowth: 0, inflation: 0, horizonYears: 5 });
  assert.ok(Math.abs(simulate(s, { trials: 10, seed: 1 }).median[5] - (100000 + 5 * 10000)) < 1e-6);
});

test('mortgagePayment matches the standard formula and is simple division at 0%', () => {
  // 12 monthly payments of the standard amortisation formula (1798.65 a month)
  assert.ok(Math.abs(mortgagePayment(300000, 6, 30) - 21583.85) < 1, String(mortgagePayment(300000, 6, 30)));
  assert.equal(mortgagePayment(120000, 0, 10), 12000);
});

test('buyHouse moves the down payment into an asset, adds a loan and does not change the input', () => {
  const base = calm({ liquid: 100000, annualSpending: 20000 });
  const before = JSON.stringify(base);
  const s = buyHouse(base, { price: 300000, downPayment: 60000, rate: 6, years: 30 });
  assert.equal(JSON.stringify(base), before);
  assert.ok(s.liquid < 100000 - 60000 + 1);
  assert.equal(s.assets.length, 1);
  assert.equal(s.debts[0].balance, 240000);
  const r = simulate({ ...s, volatility: 0, expectedReturn: 0, annualIncome: 0, annualSpending: 0, horizonYears: 30 }, { trials: 5, seed: 1 });
  // net worth at start is liquid + house - loan
  assert.ok(Math.abs(r.median[0] - (s.liquid + 300000 - 240000)) < 1e-6);
});

test('a loan is fully paid off by the end of its term', () => {
  const s = buyHouse(calm({ liquid: 500000, annualIncome: 100000, annualSpending: 0, expectedReturn: 0, horizonYears: 30 }), { price: 200000, downPayment: 0, rate: 5, years: 10, closingPct: 0, upkeepPct: 0, appreciation: 0 });
  const r = simulate(s, { trials: 5, seed: 1 });
  assert.ok(Math.abs(r.median[0] - (500000 + 200000 - 200000)) < 1e-6);
  // 10 yearly payments cost interest, so wealth ends below start + income, and the debt is gone (net worth stops dropping)
  assert.ok(Math.abs(r.median[30] - r.median[11] - 19 * 100000) < 1e-6);
});

test('changeJob and partTime shift income from the chosen year', () => {
  const base = calm({ expectedReturn: 0, annualIncome: 80000, annualSpending: 80000, horizonYears: 6 });
  const job = changeJob(base, { fromYear: 3, incomeDelta: 10000 });
  assert.ok(Math.abs(simulate(job, { trials: 5, seed: 1 }).median[6] - (100000 + 4 * 10000)) < 1e-6);
  const pt = partTime(base, { fromYear: 1, incomeCutPct: 50 });
  assert.ok(Math.abs(simulate(pt, { trials: 5, seed: 1 }).median[6] - (100000 - 6 * 40000)) < 1e-6);
});

test('compare reports the change in success chance and median outcome against a baseline', () => {
  const base = simulate(calm({ goal: 150000 }), { trials: 100, seed: 1 });
  const better = simulate(calm({ goal: 150000, liquid: 120000 }), { trials: 100, seed: 1 });
  const c = compare(base, better);
  assert.ok(c.medianFinalDelta > 0);
  assert.ok(c.successDelta >= 0);
});

test('fanChart builds svg paths inside the box and formatMoney is compact', () => {
  const r = simulate(calm({ volatility: 10 }), { trials: 100, seed: 1 });
  const c = fanChart(r, { width: 400, height: 200 });
  assert.ok(c.band.startsWith('M') && c.median.startsWith('M'));
  assert.ok(c.yTicks.length >= 2 && c.xTicks.length >= 2);
  for (const n of c.band.match(/-?\d+(\.\d+)?/g).map(Number)) assert.ok(n >= -0.01 && n <= 400.01, String(n));
  assert.equal(formatMoney(1250000), '$1.25M');
  assert.equal(formatMoney(48500), '$48.5k');
  assert.equal(formatMoney(-2000), '-$2k');
  assert.equal(formatMoney(950), '$950');
});

test('scenarios save, list, load, update and delete; search finds them by name', async () => {
  const db = await fresh();
  const s = await saveScenario(db, calm({ name: 'Baseline' }));
  const t = await saveScenario(db, calm({ name: 'Buy a house', liquid: 5 }));
  assert.deepEqual((await listScenarios(db)).map(x => x.name), ['Baseline', 'Buy a house']);
  await saveScenario(db, calm({ id: s.id, name: 'Baseline v2', liquid: 7 }));
  const again = await getScenario(db, s.id);
  assert.equal(again.name, 'Baseline v2');
  assert.equal(again.liquid, 7);
  assert.equal((await moneySearch(db, 'HOUSE'))[0].title, 'Buy a house');
  await deleteScenario(db, t.id);
  assert.equal(await getScenario(db, t.id), null);
});
