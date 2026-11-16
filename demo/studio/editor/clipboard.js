// Copy / paste (Ctrl+C, Ctrl+X, Ctrl+V; Ctrl+Shift+V pastes in place) that follows the
// context — the first of these that applies is what is copied:
//   1. keys selected in the graph editor: those keys (their channels, of the joint shown);
//   2. keys selected on an anim layer's timeline row: every channel's keys at those frames
//      (the selected joint's, or every joint's when none is selected);
//   3. a picked rig control: its values on this frame (a "control pose");
//   4. a joint selected while an anim layer is active: the joint's key values on this frame;
//   5. otherwise the selected item itself: an anim clip or a whole anim layer.
// Paste puts keys at the playhead (the first copied frame lands there; in place: the same
// frames) on the selected anim layer, onto the selected joint when one joint was copied and
// another is selected; a control pose keys the picked control (or the copied one); a joint
// pose keys the selected joint; a clip is duplicated at the playhead on its track (in place:
// on a new track above); an anim layer is duplicated with its keys shifted to the playhead
// (in place: unchanged). Cut copies, then deletes the keys / removes the clip or layer.
// The clipboard lives in this page (not the system clipboard).
import { channelsOf, CHANNELS } from '../viewer/keyframes.js';

const isKeys = (l) => l?.kind === 'keys';
const newId = () => Math.random().toString(36).slice(2, 10);
const clone = (x) => structuredClone(x);
const editing = (t) => t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || t?.isContentEditable;

export class Clipboard {
  constructor({ motionPanel, player, status, keyPanel, controlRig }) {
    Object.assign(this, { motionPanel, player, status, keyPanel, controlRig });
    this.data = null;
    window.addEventListener('keydown', (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || editing(e.target)) return;
      if (window.getSelection?.().toString()) return; // text selected on the page: the browser copies it
      const k = e.key.toLowerCase();
      if (k === 'c') { e.preventDefault(); this.copy(false); }
      else if (k === 'x') { e.preventDefault(); this.copy(true); }
      else if (k === 'v') { e.preventDefault(); this.paste(e.shiftKey); }
    });
  }

  get mp() { return this.motionPanel; }
  layerFrame(i) { return Math.round(this.mp.keyFrame(this.player.frame, i)); }

  // ---- copy ----------------------------------------------------------------------------
  copy(cut) {
    const mp = this.mp, i = mp.active, layer = mp.layers[i];
    const graph = this.keyPanel?.graph;
    // 1. Graph editor selection.
    if (graph?.open && graph.selected.length && isKeys(layer)) {
      const joint = this.keyPanel.jointName();
      const tracks = { [joint]: {} };
      for (const { c, k } of graph.selected) (tracks[joint][c] ??= []).push(clone(k));
      this.keys(tracks, layer, 'graph editor');
      if (cut) graph.deleteSelected();
      return;
    }
    // 2. Timeline key selection on an anim layer row.
    const sel = mp.timeline.keySel;
    if (sel?.frames.size && isKeys(mp.layers[sel.i])) {
      const l = mp.layers[sel.i], frames = new Set([...sel.frames].map((f) => Math.round(f)));
      const joint = mp.keyJoint?.(), tracks = {};
      for (const [name, ch] of Object.entries(l.keys?.tracks ?? {})) {
        if (joint && name !== joint) continue;
        for (const [c, keys] of Object.entries(ch)) {
          const picked = keys.filter((k) => frames.has(Math.round(k.f))).map(clone);
          if (picked.length) (tracks[name] ??= {})[c] = picked;
        }
      }
      this.keys(tracks, l, 'timeline');
      if (cut) { mp.timeline.keySel = { i: -1, frames: new Set() }; mp.moveKeys(sel.i, [...frames], null); }
      return;
    }
    // 3. A picked rig control: its values on this frame.
    const rig = this.controlRig;
    if (rig?.picked) {
      const values = rig.currentValues();
      if (values) {
        this.data = { kind: 'control', control: { ...rig.picked }, values, frame: this.player.frame };
        this.status(`Copied the ${rig.label(rig.picked.limb, rig.picked.kind)} pose at frame ${this.player.frame} (Ctrl+V keys it on another frame or control)`);
        if (cut) rig.deleteKeyAtFrame();
        return;
      }
    }
    // 4. A joint on an anim layer: its key values on this frame.
    const j = this.keyPanel?.joint();
    if (j && isKeys(layer)) {
      const spec = this.keyPanel.channelSpec();
      if (spec) {
        this.data = { kind: 'jointPose', joint: j.name, values: Object.fromEntries(spec.channels.map((c) => [c.k, c.value])),
          mode: layer.blend === 'override' ? 'override' : 'additive' };
        this.status(`Copied ${j.name}'s ${this.data.mode === 'override' ? 'pose' : 'offset'} at frame ${this.layerFrame(i) + 1}`);
        if (cut) this.keyPanel.deleteKeyAtFrame();
        return;
      }
    }
    // 5. The item: an anim layer or an anim clip.
    if (!layer) return;
    const { customMaskFrom, ...plain } = layer;
    this.data = { kind: isKeys(layer) ? 'layer' : 'clip', layer: clone(plain), duration: mp.durationOf(i), first: isKeys(layer) ? this.firstKey(layer) : null };
    this.status(`Copied the ${isKeys(layer) ? 'anim layer' : 'clip'} "${layer.name}"${cut ? ' (cut)' : ''} — Ctrl+V pastes it at the playhead, Ctrl+Shift+V in place`);
    if (cut) mp.remove(i);
  }

  keys(tracks, layer, from) {
    const frames = Object.values(tracks).flatMap((ch) => Object.values(ch).flat().map((k) => k.f));
    if (!frames.length) { this.status('No keys selected', true); return; }
    this.data = { kind: 'keys', tracks, first: Math.min(...frames), mode: layer.blend === 'override' ? 'override' : 'additive' };
    const n = new Set(frames.map((f) => Math.round(f))).size, joints = Object.keys(tracks);
    this.status(`Copied ${n} key frame(s) of ${joints.length === 1 ? joints[0] : `${joints.length} joints`} (${from})`);
  }

  firstKey(l) {
    const fs = Object.values(l.keys?.tracks ?? {}).flatMap((ch) => Object.values(ch).flat().map((k) => k.f));
    return fs.length ? Math.min(...fs) : null;
  }

  // ---- paste ---------------------------------------------------------------------------
  paste(inPlace) {
    const d = this.data, mp = this.mp;
    if (!d) { this.status('Nothing copied yet (Ctrl+C: selected keys, a rig control, a joint, a clip or an anim layer)', true); return; }
    if (d.kind === 'keys') return this.pasteKeys(d, inPlace);
    if (d.kind === 'control') return this.pasteControl(d, inPlace);
    if (d.kind === 'jointPose') return this.pasteJointPose(d);
    if (d.kind === 'clip') return this.pasteClip(d, inPlace);
    if (d.kind === 'layer') return this.pasteLayer(d, inPlace);
    void mp;
  }

  targetLayer() {
    const mp = this.mp, l = mp.activeLayer;
    if (isKeys(l)) return { l, i: mp.active };
    this.status('Select an anim layer (Anim layers, or its row on the timeline) to paste keys into', true);
    return null;
  }

  // Write keys into a layer's tracks (a key already on that frame is replaced).
  writeKeys(l, tracks, shift) {
    for (const [joint, chans] of Object.entries(tracks)) {
      const ch = channelsOf(l.keys, joint);
      for (const [c, keys] of Object.entries(chans)) {
        const list = ch[c] ?? (ch[c] = []);
        for (const k of keys) {
          const f = Math.max(0, Math.round(k.f + shift));
          const at = list.findIndex((x) => Math.round(x.f) === f);
          const key = { ...clone(k), f };
          if (at >= 0) list[at] = key; else list.push(key);
        }
        list.sort((a, b) => a.f - b.f);
      }
      for (const c of CHANNELS) if (ch[c] && !ch[c].length) delete ch[c];
    }
  }

  pasteKeys(d, inPlace) {
    const t = this.targetLayer();
    if (!t) return;
    let tracks = d.tracks;
    const sel = this.keyPanel?.jointName(), names = Object.keys(tracks);
    if (names.length === 1 && sel && sel !== names[0]) tracks = { [sel]: tracks[names[0]] }; // onto the selected joint
    const shift = inPlace ? 0 : this.layerFrame(t.i) - d.first;
    this.writeKeys(t.l, tracks, shift);
    const mode = t.l.blend === 'override' ? 'override' : 'additive';
    this.status(`Pasted ${Object.keys(tracks).join(', ')} keys on "${t.l.name}"${inPlace ? ' in place' : ` at frame ${this.layerFrame(t.i) + 1}`}` +
      (mode !== d.mode ? ` — copied from an ${d.mode} layer into an ${mode} one: the values mean ${mode === 'override' ? 'poses' : 'offsets'} here` : ''), mode !== d.mode);
    this.edited();
  }

  pasteControl(d, inPlace) {
    const rig = this.controlRig;
    // The picked control, unless it is of another family (a hand pose does not fit the hips).
    const same = rig.picked && (rig.picked.limb === 'body') === (d.control.limb === 'body');
    const p = same ? rig.picked : d.control;
    if (!same) rig.pick(p);
    if (inPlace && this.player.frame !== d.frame) this.player.setFrame(d.frame);
    const now = rig.currentValues();
    if (!now) { this.status('That control is not available on this character', true); return; }
    for (const k of Object.keys(now)) if (k in d.values) now[k] = d.values[k];
    rig.commitValues(p, now);
    this.status(`Pasted the control pose on ${rig.label(p.limb, p.kind)} at frame ${this.player.frame} (${rig.store().name})`);
  }

  pasteJointPose(d) {
    const t = this.targetLayer();
    if (!t) return;
    const joint = this.keyPanel?.jointName() ?? d.joint;
    const tracks = { [joint]: Object.fromEntries(Object.entries(d.values).map(([c, v]) => [c, [{ f: 0, v, i: 'bezier', a: true }]])) };
    // Translation only where it is used (non-zero, or already animated on the target).
    const ch = t.l.keys?.tracks?.[joint] ?? {};
    for (const c of ['tx', 'ty', 'tz']) if (Math.abs(d.values[c] ?? 0) < 1e-9 && !ch[c]?.length) delete tracks[joint][c];
    this.writeKeys(t.l, tracks, this.layerFrame(t.i));
    this.status(`Pasted ${d.joint}'s ${d.mode === 'override' ? 'pose' : 'offset'} on ${joint} at frame ${this.layerFrame(t.i) + 1}`);
    this.edited();
  }

  pasteClip(d, inPlace) {
    const mp = this.mp, l = clone(d.layer);
    l.id = newId();
    l.name = `${d.layer.name} copy`;
    const t = { ...(l.timing ?? {}) };
    if (inPlace) l.track = mp.trackCount; // the same time, on a new track above
    else t.start = this.player.time;
    l.timing = t;
    const i = mp.insertClip(l, d.duration);
    mp.select(i);
    mp.schedule();
    this.status(`Pasted the clip "${l.name}"${inPlace ? ` in place on track ${l.track + 1}` : ` at ${this.player.time.toFixed(2)} s`}`);
  }

  pasteLayer(d, inPlace) {
    const mp = this.mp, l = clone(d.layer);
    l.id = newId();
    l.name = `${d.layer.name} copy`;
    l.members = [...(l.members ?? [])];
    mp.layers.push(l);
    const i = mp.layers.length - 1;
    if (!inPlace && d.first !== null) { // its first key at the playhead
      const shift = Math.round(mp.keyFrame(this.player.frame, i)) - d.first;
      const tracks = l.keys?.tracks ?? {};
      for (const ch of Object.values(tracks)) for (const keys of Object.values(ch)) for (const k of keys) k.f = Math.max(0, Math.round(k.f + shift));
      for (const lc of Object.values(l.rig?.limbs ?? {})) for (const curves of [lc.target, lc.pole]) for (const keys of Object.values(curves ?? {})) for (const k of keys) k.f = Math.max(0, Math.round(k.f + shift));
      for (const k of l.weightKeys ?? []) k.f = Math.max(0, Math.round(k.f + shift));
    }
    mp.select(i);
    mp.schedule();
    this.status(`Pasted the anim layer "${l.name}"${inPlace ? ' in place' : ' with its keys at the playhead'}`);
  }

  edited() {
    this.mp.refreshKeyTicks();
    this.keyPanel?.edited();
  }
}
