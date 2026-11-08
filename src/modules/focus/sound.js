// Ambient noise as sample arrays (made in the browser, no audio files). rng() returns [0, 1).
export function noiseSamples(kind, n, rng = Math.random) {
  const out = new Float32Array(n);
  let last = 0;
  let drop = 0;
  for (let i = 0; i < n; i++) {
    const white = rng() * 2 - 1;
    if (kind === 'white') {
      out[i] = white;
    } else if (kind === 'brown') {
      last = (last + 0.02 * white) / 1.02;
      out[i] = Math.max(-1, Math.min(1, last * 3.5));
    } else { // rain: soft hiss with random small drops
      if (rng() < 0.002) drop = 0.6 + rng() * 0.4;
      drop *= 0.985;
      out[i] = Math.max(-1, Math.min(1, white * 0.25 + (rng() * 2 - 1) * drop * 0.6));
    }
  }
  return out;
}
