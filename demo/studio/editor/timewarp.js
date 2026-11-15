// Retiming maps (time warps), as ClipTiming::warp in include/kimodo/anim/layers.hpp:
// [[out, in], ...] in seconds since the item's start, both strictly increasing; linear between
// the pairs, slope 1 before the first and after the last. `out` is where it plays on the
// timeline, `in` what it plays (the time before the warp).

export function warpTime(w, x) { return pw(w, x, 0, 1); }
export function unwarpTime(w, y) { return pw(w, y, 1, 0); }

function pw(w, x, a, b) {
  if (!w?.length) return x;
  if (x <= w[0][a]) return w[0][b] + (x - w[0][a]);
  const n = w.length;
  if (x >= w[n - 1][a]) return w[n - 1][b] + (x - w[n - 1][a]);
  let i = 1;
  while (i < n && w[i][a] < x) i++;
  const u = (x - w[i - 1][a]) / (w[i][a] - w[i - 1][a]);
  return w[i - 1][b] + (w[i][b] - w[i - 1][b]) * u;
}

// outer(inner(x)) as one warp (both piecewise linear with slope 1 outside).
export function composeWarp(outer, inner) {
  if (!outer?.length) return inner?.length ? inner.map((p) => [...p]) : [];
  if (!inner?.length) return outer.map((p) => [...p]);
  const xs = new Set(inner.map((p) => p[0]));
  for (const [o] of outer) xs.add(unwarpTime(inner, o));
  const sorted = [...xs].sort((p, q) => p - q);
  const out = [];
  for (const x of sorted) {
    const y = warpTime(outer, warpTime(inner, x));
    if (out.length && (x - out[out.length - 1][0] < 1e-6 || y - out[out.length - 1][1] < 1e-6)) continue;
    out.push([x, y]);
  }
  return out;
}

// The same warp seen from a start `d` seconds later: W'(m) = W(m + d) - W(d) shifted so that
// times stay "since start": x' = x - d, y' = y - d.
export const shiftWarp = (w, d) => (w ?? []).map(([o, i]) => [o - d, i - d]);
// Time scaled by k (stretching the item): W'(x) = k W(x / k).
export const scaleWarp = (w, k) => (w ?? []).map(([o, i]) => [o * k, i * k]);
// Round for storage (and stable requests).
export const tidyWarp = (w) => (w ?? []).map(([o, i]) => [Math.round(o * 1e5) / 1e5, Math.round(i * 1e5) / 1e5]);
// Identity warps (all points on the diagonal) are dropped.
export const isIdentity = (w) => !w?.length || w.every(([o, i]) => Math.abs(o - i) < 1e-6);
