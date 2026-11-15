// Keyframe curves, mirroring src/anim/keyframes.cpp (same evaluation rules, so the graph
// editor shows exactly what kmd-anim bakes). Tracks JSON:
//   {version:1, fps:30, tracks:{Joint:{rx:[{f,v,i,a,l,r}], ry, rz, tx, ty, tz}}}
// rx/ry/rz: rotation offsets in degrees (Euler XYZ, q = qx*qy*qz); tx/ty/tz: translation
// offsets in parent units. Keys: f frame, v value, i 'constant'|'linear'|'bezier',
// a auto tangents, l/r handle offsets [frames, value] when a is false.
import * as THREE from 'three';

export const CHANNELS = ['rx', 'ry', 'rz', 'tx', 'ty', 'tz'];

export const emptyTracks = () => ({ version: 1, fps: 30, tracks: {} });

export function handles(keys, i) {
  const k = keys[i];
  if (k.a === false && k.l && k.r) return [k.l, k.r];
  const hasPrev = i > 0, hasNext = i + 1 < keys.length;
  const dl = hasPrev ? k.f - keys[i - 1].f : 1;
  const dr = hasNext ? keys[i + 1].f - k.f : 1;
  let slope = 0;
  if (hasPrev && hasNext) {
    const vp = keys[i - 1].v, vn = keys[i + 1].v;
    const extremum = (k.v >= vp && k.v >= vn) || (k.v <= vp && k.v <= vn);
    const span = keys[i + 1].f - keys[i - 1].f;
    slope = extremum || span <= 0 ? 0 : (vn - vp) / span;
  }
  return [[-dl / 3, (-slope * dl) / 3], [dr / 3, (slope * dr) / 3]];
}

const bez = (a, b, c, d, u) => { const m = 1 - u; return m * m * m * a + 3 * m * m * u * b + 3 * m * u * u * c + u * u * u * d; };

export function evaluate(keys, frame) {
  if (!keys?.length) return 0;
  if (frame <= keys[0].f) return keys[0].v;
  if (frame >= keys[keys.length - 1].f) return keys[keys.length - 1].v;
  let i1 = keys.findIndex((k) => k.f > frame);
  const i0 = i1 - 1, a = keys[i0], b = keys[i1];
  const span = b.f - a.f;
  if (span <= 0) return b.v;
  const interp = a.i ?? 'bezier';
  if (interp === 'constant') return a.v;
  if (interp === 'linear') return a.v + ((b.v - a.v) * (frame - a.f)) / span;
  const ha = handles(keys, i0), hb = handles(keys, i1);
  const x1 = a.f + Math.min(span, Math.max(0, ha[1][0])), y1 = a.v + ha[1][1];
  const x2 = b.f + Math.min(0, Math.max(-span, hb[0][0])), y2 = b.v + hb[0][1];
  let lo = 0, hi = 1;
  for (let it = 0; it < 40; it++) {
    const mid = 0.5 * (lo + hi);
    if (bez(a.f, x1, x2, b.f, mid) < frame) lo = mid; else hi = mid;
  }
  return bez(a.v, y1, y2, b.v, 0.5 * (lo + hi));
}

export const sortKeys = (keys) => keys.sort((x, y) => x.f - y.f);

// Insert or update the key at an integer frame.
export function setKey(keys, frame, value) {
  const f = Math.round(frame);
  const k = keys.find((x) => Math.abs(x.f - f) < 1e-6);
  if (k) k.v = value;
  else { keys.push({ f, v: value, i: 'bezier', a: true }); sortKeys(keys); }
}

export function channelsOf(tracks, joint) {
  tracks.tracks[joint] ??= {};
  const ch = tracks.tracks[joint];
  for (const c of CHANNELS) ch[c] ??= [];
  return ch;
}

export function offsetAt(tracks, joint, frame) {
  const ch = tracks?.tracks?.[joint];
  return Object.fromEntries(CHANNELS.map((c) => [c, evaluate(ch?.[c], frame)]));
}

export const keyedJoints = (tracks) =>
  Object.entries(tracks?.tracks ?? {}).filter(([, ch]) => CHANNELS.some((c) => ch[c]?.length)).map(([n]) => n);

export function keyFrames(tracks, joint) {
  const set = new Set();
  const ch = tracks?.tracks?.[joint];
  for (const c of CHANNELS) for (const k of ch?.[c] ?? []) set.add(k.f);
  return [...set].sort((a, b) => a - b);
}

// Euler XYZ degrees <-> quaternion (three.js 'XYZ' == qx * qy * qz, as in kmd-anim).
const DEG = Math.PI / 180;
export const eulerQuat = (x, y, z) => new THREE.Quaternion().setFromEuler(new THREE.Euler(x * DEG, y * DEG, z * DEG, 'XYZ'));
// Quaternion -> Euler degrees, each angle unwrapped to be closest to `near` (continuity for keys).
export function quatEuler(q, near = [0, 0, 0]) {
  const e = new THREE.Euler().setFromQuaternion(q, 'XYZ');
  return [e.x, e.y, e.z].map((a, i) => {
    let d = a / DEG;
    while (d - near[i] > 180) d -= 360;
    while (d - near[i] < -180) d += 360;
    return d;
  });
}
