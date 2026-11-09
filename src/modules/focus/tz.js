// Minutes EAST of UTC at a given instant (the opposite sign of Date.getTimezoneOffset()).

/** @param {string} [timeZone] IANA zone; default is the system zone. */
export function makeTzOffsetAt(timeZone) {
  const zone = timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hourCycle: 'h23',
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric',
  });
  return (utcMs) => {
    const t = Math.floor(utcMs / 1000) * 1000; // whole seconds; the formatter drops milliseconds
    const p = {};
    for (const part of fmt.formatToParts(new Date(t))) p[part.type] = part.value;
    // Some engines print midnight as hour 24 even with h23.
    const hour = Number(p.hour) % 24;
    const wall = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), hour, Number(p.minute), Number(p.second));
    return Math.round((wall - t) / 60000);
  };
}
