export function formatMoney(n) {
  const sign = n < 0 ? '-' : '';
  const a = Math.abs(n);
  const trim = (x, d) => String(Number(x.toFixed(d)));
  if (a >= 1e6) return `${sign}$${trim(a / 1e6, 2)}M`;
  if (a >= 1e3) return `${sign}$${trim(a / 1e3, 1)}k`;
  return `${sign}$${Math.round(a)}`;
}

// SVG path data for the 10th-90th percentile band and the median line, inside a width x height box.
export function fanChart(result, { width, height }) {
  const H = result.years.length - 1;
  const lo = Math.min(0, ...result.p10);
  const hi = Math.max(...result.p90, lo + 1);
  const x = (i) => (H === 0 ? 0 : (i / H) * width);
  const y = (v) => height - ((v - lo) / (hi - lo)) * height;
  const pt = (i, v) => `${x(i).toFixed(1)} ${y(v).toFixed(1)}`;
  const up = result.p90.map((v, i) => (i ? 'L' : 'M') + pt(i, v)).join(' ');
  const down = result.p10.map((v, i) => [i, v]).reverse().map(([i, v]) => 'L' + pt(i, v)).join(' ');
  const yTicks = [0, 1, 2, 3].map(k => { const v = lo + ((hi - lo) * k) / 3; return { value: v, y: y(v), label: formatMoney(v) }; });
  const step = H <= 10 ? 2 : H <= 20 ? 5 : 10;
  const xTicks = [];
  for (let i = 0; i <= H; i += step) xTicks.push({ year: i, x: x(i) });
  return { band: `${up} ${down} Z`, median: result.median.map((v, i) => (i ? 'L' : 'M') + pt(i, v)).join(' '), yTicks, xTicks, y };
}

// Combined 10th/90th percentile range of two results, over the longer horizon (for a shared chart scale).
export function mergeBands(a, b) {
  if (!b) return { years: a.years, p10: a.p10, p90: a.p90, median: a.median };
  const longer = a.years.length >= b.years.length ? a : b;
  const pick = (key, fn) => longer.years.map((_, i) => fn(...[a, b].filter(r => i < r.years.length).map(r => r[key][i])));
  return { years: longer.years, p10: pick('p10', Math.min), p90: pick('p90', Math.max), median: longer.median };
}
