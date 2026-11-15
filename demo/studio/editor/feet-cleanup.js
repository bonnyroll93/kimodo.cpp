// Foot sliding clean-up with the control rig, baked into animation curves.
// The feet's contacts with the ground are found on the FK animation (the stack without the
// rig): a foot is planted while its ankle is near its lowest height (Height, % of the leg
// length) and moves slowly (Speed, % of the leg length per second); gaps of 1-2 frames are
// filled and contacts shorter than 3 frames dropped. During a contact the IK control holds
// the contact's position on the ground plane (the median frame's x / z; the height follows the
// animation, so heel and toe roll stay), easing in and out over Blend frames around it;
// elsewhere it follows the animation. The result is keyed on every frame (linear) on an
// override anim layer, "Feet cleanup" (reused when it exists), for both legs, whose IK is turned
// on and follows World, so moving the hips or the root afterwards keeps the feet planted. Lower
// the layer weight, mute it or edit its keys like any other layer.
import * as THREE from 'three';

const LAYER = 'Feet cleanup';
const LEGS = ['left_leg', 'right_leg'];

// Contact runs of a boolean-per-frame list: gaps <= 2 filled, runs < 3 dropped.
export function contactRuns(flags) {
  const f = [...flags];
  for (let i = 1; i < f.length - 1; i++) {
    if (f[i]) continue;
    const prev = f.slice(0, i).lastIndexOf(true), next = f.indexOf(true, i);
    if (prev >= 0 && next >= 0 && next - prev <= 3) f[i] = true;
  }
  const runs = [];
  for (let i = 0; i < f.length; i++) {
    if (!f[i]) continue;
    let e = i;
    while (e + 1 < f.length && f[e + 1]) e++;
    if (e - i + 1 >= 3) runs.push([i, e]);
    i = e;
  }
  return runs;
}

const smooth = (x) => x * x * (3 - 2 * x);

export async function cleanFeet({ rig, motionPanel, player, status, getCharacter }, { height = 0.06, speed = 0.5, blend = 4 } = {}) {
  const ch = rig.chains(), character = getCharacter();
  const legs = LEGS.filter((id) => ch?.[id]);
  if (!legs.length) throw new Error('no leg chains: load a character and retarget a motion onto it');
  player.play(false);
  const arrays = await rig.fkArrays();
  const frames = [...Array(player.frames).keys()], fps = player.fps || 30;
  const toSkel = () => character.root.matrixWorld.clone().invert();
  // Ankle positions (skeleton space) on every frame of the FK animation.
  const samples = rig.withFK(arrays, () => {
    character.root.updateMatrixWorld(true);
    const M = toSkel();
    return legs.map((id) => ch[id][2].bone.getWorldPosition(new THREE.Vector3()).applyMatrix4(M));
  }, frames);
  const M = toSkel();
  let i = motionPanel.layers.findIndex((l) => l.kind === 'keys' && l.name === LAYER);
  if (i < 0) i = motionPanel.addKeyLayer(LAYER, 'override');
  else motionPanel.select(i);
  const layer = motionPanel.layers[i];
  const lrig = (layer.rig ??= { limbs: {}, body: {} });
  lrig.limbs ??= {};
  const report = [];
  legs.forEach((id, n) => {
    const P = frames.map((f) => samples[f][n]);
    const [a, b, c] = ch[id];
    const rest = [a, b, c].map((j) => j.restPos.clone().applyMatrix4(M));
    const leg = rest[0].distanceTo(rest[1]) + rest[1].distanceTo(rest[2]);
    const ground = Math.min(...P.map((p) => p.y));
    const vel = P.map((p, f) => {
      const p0 = P[Math.max(0, f - 1)], p1 = P[Math.min(P.length - 1, f + 1)];
      const dt = (Math.min(P.length - 1, f + 1) - Math.max(0, f - 1)) / fps;
      return dt > 0 ? Math.hypot(p1.x - p0.x, p1.z - p0.z) / dt : 0;
    });
    const runs = contactRuns(P.map((p, f) => p.y - ground < height * leg && vel[f] < speed * leg));
    const w = frames.map(() => 0), plant = frames.map(() => null);
    let slide = 0;
    for (const [s, e] of runs) {
      const mid = P[Math.round((s + e) / 2)];
      for (let f = s; f <= e; f++) {
        w[f] = 1; plant[f] = mid;
        slide = Math.max(slide, Math.hypot(P[f].x - mid.x, P[f].z - mid.z));
      }
      for (let k = 1; k <= blend; k++) { // ease in / out around the contact
        const x = smooth(1 - k / (blend + 1));
        for (const f of [s - k, e + k]) if (f >= 0 && f < frames.length && x > w[f]) { w[f] = x; plant[f] = mid; }
      }
    }
    const keys = { tx: [], ty: [], tz: [] };
    for (const f of frames) {
      const p = P[f], q = plant[f], u = w[f];
      const x = q ? p.x + (q.x - p.x) * u : p.x, z = q ? p.z + (q.z - p.z) * u : p.z;
      const lf = Math.round(motionPanel.keyFrame(f, i));
      keys.tx.push({ f: lf, v: x, i: 'linear', a: true });
      keys.ty.push({ f: lf, v: p.y, i: 'linear', a: true });
      keys.tz.push({ f: lf, v: z, i: 'linear', a: true });
    }
    const l = rig.limb(id);
    l.ik = true;
    if ((l.follow ?? 'world') !== 'world') rig.setFollow(id, 'world');
    lrig.limbs[id] = { ...(lrig.limbs[id] ?? {}), target: keys };
    report.push({ id, contacts: runs.length, frames: runs.reduce((s, [a0, e]) => s + e - a0 + 1, 0), slide, unit: leg });
  });
  layer.members = [...new Set([...(layer.members ?? []), ...legs.map((id) => `ctl:${id}:ik`)])];
  rig.changed();
  status(`Feet cleanup: ${report.map((r) => `${r.id.replace('_', ' ')} ${r.contacts} contact(s), slide up to ${(r.slide * 100).toFixed(1)} cm → 0`).join(' · ')} (layer "${LAYER}")`);
  return report;
}
