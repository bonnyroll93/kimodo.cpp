// Kimodo Studio entry point: wires viewport, loader, skeleton overlay, hierarchy and inspector.
import * as THREE from 'three';
import { Viewport } from './viewer/viewport.js';
import { loadCharacter, disposeCharacter } from './viewer/model-loader.js';
import { SkeletonView } from './viewer/skeleton-view.js';
import { installJointPicking } from './viewer/joint-selection.js';
import { SceneHierarchy } from './editor/scene-hierarchy.js';
import { Inspector } from './editor/inspector.js';
import { AnimationPlayer } from './viewer/animation-player.js';
import { MotionPathView } from './viewer/motion-path-view.js';
import { MotionPanel } from './editor/motion-panel.js';
import { RetargetPanel } from './editor/retarget-panel.js';
import { ExportPanel } from './editor/export-panel.js';
import { PathEditor } from './viewer/path-editor.js';
import { SceneFile } from './editor/scene-file.js';
import { KeyPanel } from './editor/key-panel.js';
import { MotionLibrary } from './editor/motion-library.js';
import { History } from './editor/history.js';
import { rigSnapshot, jointNameMap, transferScene } from './editor/rig-transfer.js';
import { restoreBindPose } from './editor/bind-pose.js';
import { TPoseEditor } from './editor/tpose-editor.js';
import { ControlRig } from './editor/control-rig.js';
import { Picker } from './editor/picker.js';
import { PoseTools } from './editor/pose-tools.js';
import { cleanFeet } from './editor/feet-cleanup.js';
import { fbxToGlb } from './viewer/fbx-import.js';
import { ChannelBox, channels } from './editor/channel-box.js';
import { quatEuler } from './viewer/keyframes.js';

const $ = (id) => document.getElementById(id);
const status = (text, error = false) => {
  $('status').textContent = text;
  $('status').classList.toggle('error', error);
};

const viewport = new Viewport($('viewport'));
const skeletonView = new SkeletonView(viewport.scene);
let character = null;
let selected = -1;

// Shift state, for "toggle the whole subtree" while picking mask joints.
let shiftDown = false;
window.addEventListener('keydown', (e) => { if (e.key === 'Shift') shiftDown = true; });
window.addEventListener('keyup', (e) => { if (e.key === 'Shift') shiftDown = false; });
window.addEventListener('blur', () => { shiftDown = false; });

function select(index, fromRig = false) {
  // Mask picking: a click on a joint includes/excludes it in the active layer's mask.
  const mask = motionPanel?.maskEditor;
  if (mask?.picking && mask.visible && character && index >= 0 && retargetPanel.enabled)
    mask.toggleJoint(character.joints[index].name, shiftDown);
  selected = character && index >= 0 && index < character.joints.length ? index : -1;
  keyPanel?.setJoint(selected);
  tposeEditor?.setJoint(selected);
  if (!fromRig && controlRig?.picked) controlRig.pick(null);
  picker?.setJoint(selected);
  skeletonView.select(selected);
  hierarchy.select(selected);
  inspector.showJoint(character, selected);
}

const hierarchy = new SceneHierarchy($('hierarchy'), $('filter'), select);
const inspector = new Inspector($('inspector'), $('stats'), select);
installJointPicking(viewport, skeletonView, select);
viewport.onFrame.push(() => skeletonView.update());

// Kimodo motion playback (native skeleton) and root-motion controls.
const player = new AnimationPlayer(viewport.scene);
const pathView = new MotionPathView(viewport.scene);
let lastTick = performance.now();
viewport.onFrame.push(() => {
  const now = performance.now();
  player.update(Math.min((now - lastTick) / 1000, 0.1));
  lastTick = now;
});
player.onChange((p) => {
  $('playbar').hidden = !p.frames;
  $('play').textContent = p.playing ? 'Pause' : 'Play';
  $('scrub').max = Math.max(p.frames - 1, 0);
  $('scrub').value = p.frame;
  $('frame-label').textContent = `${p.frame + 1} / ${p.frames} · ${p.time.toFixed(2)} / ${p.duration.toFixed(2)} s · ${p.fps} fps`;
  const [a, b] = p.rangeFrames, last = Math.max(p.frames - 1, 0);
  for (const [id, v] of [['frame-input', p.frame], ['range-in', a], ['range-out', b]]) {
    $(id).max = last;
    if (document.activeElement !== $(id)) $(id).value = v;
  }
  $('range-reset').disabled = !p.range;
  if (motionPanel && document.activeElement !== $('scene-length')) $('scene-length').value = motionPanel.sceneLength;
  motionPanel?.timeline.update(p.time);
});
$('play').addEventListener('click', () => player.play());
$('scrub').addEventListener('input', (e) => { player.play(false); player.setFrame(Number(e.target.value)); });
$('loop').addEventListener('change', (e) => { player.loop = e.target.checked; });

// Main timeline frame controls: current frame, step, playback range (In / Out), scene length.
const goFrame = (f) => { player.play(false); player.setFrame(f); };
const setRange = (a, b) => {
  const last = Math.max(player.frames - 1, 0);
  a = Math.max(0, Math.min(last, Math.round(a)));
  b = Math.max(0, Math.min(last, Math.round(b)));
  if (b < a) [a, b] = [b, a];
  player.setRange(a === 0 && b === last ? null : [a, b]);
  if (player.frame < a || player.frame > b) player.setFrame(a);
  motionPanel.renderTimeline();
};
$('frame-input').addEventListener('change', (e) => goFrame(Number(e.target.value) || 0));
$('frame-prev').addEventListener('click', () => goFrame(player.frame - 1));
$('frame-next').addEventListener('click', () => goFrame(player.frame + 1));
$('frame-first').addEventListener('click', () => goFrame(player.rangeFrames[0]));
$('frame-last').addEventListener('click', () => goFrame(player.rangeFrames[1]));
$('range-in').addEventListener('change', (e) => setRange(Number(e.target.value) || 0, player.rangeFrames[1]));
$('range-out').addEventListener('change', (e) => setRange(player.rangeFrames[0], Number(e.target.value) || 0));
$('range-set-in').addEventListener('click', () => setRange(player.frame, Math.max(player.frame, player.rangeFrames[1])));
$('range-set-out').addEventListener('click', () => setRange(Math.min(player.frame, player.rangeFrames[0]), player.frame));
$('range-reset').addEventListener('click', () => setRange(0, player.frames - 1));
$('scene-length').addEventListener('change', (e) => {
  const v = Number(e.target.value);
  motionPanel.sceneLength = Number.isFinite(v) && v > 0 ? Math.min(3600, Math.round(v * 30) / 30) : 0;
  e.target.value = motionPanel.sceneLength;
  motionPanel.schedule();
});
const retargetPanel = new RetargetPanel({ $, status, onChange: () => { exportPanel.sync(); motionPanel.schedule(); } });
// T-pose preview: pause; leaving it restores the animated pose (or the bind pose without one).
retargetPanel.onBeforePose = () => player.play(false);
retargetPanel.onRestorePose = () => { if (player.target) player.setFrame(player.frame); else if (character) restoreBindPose(character); };
let tposeFrame = -1;
player.onChange((p) => {
  if (!retargetPanel.tposeShown) { tposeFrame = p.frame; return; }
  if (tposeFrame < 0) tposeFrame = p.frame;
  if (p.playing || p.frame !== tposeFrame) { tposeFrame = p.frame; retargetPanel.showTPose(false); }
});
const motionPanel = new MotionPanel({
  $, player, pathView, status, retarget: retargetPanel,
  onSeek: (t) => { player.play(false); player.setFrame(t * player.fps); },
  onLoaded: (first) => {
    $('empty').hidden = true;
    applyVisibility();
    if (first) {
      frameMotion(true);
      player.play(true);
    }
  },
});

// Mask preview: joints coloured by their weight in the active layer's custom mask.
const MASK_OFF = new THREE.Color(0x4a5560), MASK_ON = new THREE.Color(0xffb547);
motionPanel.onMaskVisual = (weightOf) => {
  const target = retargetPanel.enabled ? skeletonView : player.view;
  for (const v of [skeletonView, player.view]) if (v !== target || !weightOf) v.setJointColors(null);
  if (weightOf) target.setJointColors((j) => MASK_OFF.clone().lerp(MASK_ON, weightOf(j.name)));
};

// Motion sources: new generations (made in the Text to motion tab) appear on refresh or
// when this tab gets the focus back.
async function refreshSources() {
  const before = motionPanel.sources?.size ?? 0;
  const list = await motionPanel.loadSources();
  if (list.length > before && before > 0) status(`${list.length - before} new motion(s) available in Source`);
}
$('refresh-sources').addEventListener('click', () => refreshSources().catch(() => {}));
window.addEventListener('focus', () => refreshSources().catch(() => {}));

function applyVisibility() {
  if (character) character.root.traverse((o) => { if (o.isMesh) o.visible = $('show-mesh').checked; });
  skeletonView.setVisible({ joints: $('show-joints').checked, skeleton: $('show-skeleton').checked });
  player.setVisible({ joints: $('show-joints').checked, skeleton: $('show-skeleton').checked, source: $('show-source').checked });
  pathView.visible = $('show-path').checked;
  viewport.grid.visible = $('show-grid').checked;
  viewport.axes.visible = $('show-axes').checked;
}
for (const id of ['show-mesh', 'show-skeleton', 'show-joints', 'show-grid', 'show-axes', 'show-path', 'show-source'])
  $(id).addEventListener('change', applyVisibility);

// source: ArrayBuffer (local file) or URL; serverId: id the backend knows (sample rigs).
// Opening another character keeps the scene (clips, anim layers, timing, paths, masks, options):
// keys and custom masks move onto the new rig (editor/rig-transfer.js). transfer: false when a
// scene file replaces the layers right after.
async function open(source, name, serverId = null, { transfer = true } = {}) {
  status(`Loading ${name}…`);
  try {
    const next = await loadCharacter(source, name);
    next.rig = rigSnapshot(next);
    const prev = character;
    const needsTransfer = transfer && prev?.rig && motionPanel.layers.some((l) =>
      (l.kind === 'keys' && Object.keys(l.keys?.tracks ?? {}).length) || l.customMask?.weights);
    let prevMapping = null;
    if (needsTransfer) {
      try { prevMapping = retargetPanel.skeletonKey ? await retargetPanel.ensureMapping() : null; } catch { /* names only */ }
    }
    player.setTarget(null);
    if (character) {
      viewport.scene.remove(character.root);
      disposeCharacter(character);
    }
    character = next;
    viewport.scene.add(character.root);
    character.root.updateMatrixWorld(true);
    const radius = viewport.frame(character.root) ?? 1;
    skeletonView.setCharacter(character, radius);
    hierarchy.setCharacter(character);
    inspector.showStats(character);
    retargetPanel.setCharacter(character, { id: serverId, upload: source instanceof ArrayBuffer ? source : null });
    let transferNote = '';
    if (needsTransfer) {
      let newMapping = null;
      try { newMapping = retargetPanel.skeletonKey ? await retargetPanel.ensureMapping() : null; } catch { /* names only */ }
      const names = jointNameMap(prev.rig, character.rig, prevMapping, newMapping);
      const r = transferScene(motionPanel.layers, prev.rig, character.rig, names);
      transferNote = ` · scene kept: ${r.joints} keyed joint(s) moved to the new rig` +
        (r.rekeyed ? ` (${r.rekeyed} re-keyed for its joint axes, tangents auto)` : '') +
        (r.masks ? `, ${r.masks} custom mask(s)` : '') +
        (r.unmapped.size ? `; no match for ${[...r.unmapped].slice(0, 6).join(', ')}${r.unmapped.size > 6 ? '…' : ''} (kept under the old names)` : '');
      motionPanel.select(motionPanel.active);
    }
    exportPanel.sync();
    const anims = character.gltf.animations.map((a) => a.name || 'unnamed');
    $('embedded-anim').replaceChildren(new Option(anims.length ? 'None (use Motion / Layers)' : 'none', ''), ...anims.map((n) => new Option(n, n)));
    $('embedded-row').hidden = !anims.length;
    if (player.motion) motionPanel.schedule();
    undoHistory?.reset();
    select(-1);
    applyVisibility();
    $('empty').hidden = true;
    $('joint-count').textContent = character.joints.length ? `${character.joints.length} joints` : '';
    const s = character.stats;
    const msg = `${name}: ${s.joints} joints, ${s.skinnedMeshes} skinned mesh${s.skinnedMeshes === 1 ? '' : 'es'}, ${s.triangles.toLocaleString()} triangles`;
    const extra = [...character.warnings, ...character.notes];
    status((extra.length ? `${msg} — ${extra.join(' ')}` : msg) + transferNote, character.warnings.length > 0);
  } catch (err) {
    console.error(err);
    status(`Could not load ${name}: ${err.message || err}`, true);
  }
}

// A local file: GLB / glTF as is, FBX converted to GLB first (viewer/fbx-import.js).
async function openFile(buffer, name) {
  if (!/\.fbx$/i.test(name)) return open(buffer, name);
  status(`Converting ${name} (FBX → GLB)…`);
  try {
    const { glb, via } = await fbxToGlb(buffer);
    const glbName = name.replace(/\.fbx$/i, '.glb');
    await open(glb, glbName);
    status(`Opened ${name} (FBX converted to GLB ${via === 'browser' ? 'in the browser' : 'by Blender'})`);
    return true;
  } catch (err) {
    status(`Could not import ${name}: ${err.message || err}`, true);
    return false;
  }
}

$('file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (file) await openFile(await file.arrayBuffer(), file.name);
  e.target.value = '';
});

// In-viewport MotionPath editing for the active layer.
const pathEditor = new PathEditor(viewport, {
  getPath: () => motionPanel.editablePath(),
  setPoints: (points) => motionPanel.setPathPoints(points),
  view: () => motionPanel.displayView(),
  onToggle: (on) => {
    $('edit-path').classList.toggle('on', on);
    $('edit-path').textContent = on ? 'Done editing' : 'Edit in viewport';
    $('edit-path-hint').hidden = !on;
    if (on) status('Path editing: drag waypoints, click the ground to add, double-click to remove, Esc to finish');
  },
});
$('edit-path').addEventListener('click', () => {
  if (!pathEditor.active && motionPanel.mode !== 'path') {
    document.querySelector('input[name="root-mode"][value="path"]').checked = true;
    motionPanel.formChanged();
  }
  pathEditor.toggle();
});
motionPanel.onShown = () => pathEditor.refresh();
for (const r of document.querySelectorAll('input[name="root-mode"]'))
  r.addEventListener('change', () => { if (r.checked && r.value !== 'path' && pathEditor.active) pathEditor.toggle(false); });

// Remove the loaded character (opening a scene saved without one).
function clearCharacter() {
  if (!character) return;
  player.setTarget(null);
  viewport.scene.remove(character.root);
  disposeCharacter(character);
  character = null;
  skeletonView.setCharacter(null, 1);
  hierarchy.setCharacter(null);
  inspector.showStats(null);
  select(-1);
  retargetPanel.setCharacter(null);
  $('embedded-row').hidden = true;
  $('joint-count').textContent = '';
}

const exportPanel = new ExportPanel({
  $, status, motionPanel, retarget: retargetPanel,
  // Reopen an exported GLB: it replaces the character and plays its embedded animation.
  onOpen: async (url, file, animation) => {
    $('retarget-on').checked = false;
    player.clear();
    pathView.clear();
    if (/\.fbx$/i.test(file)) { // an FBX export: read back through the FBX import
      const r = await fetch(url, { cache: 'no-store' });
      if (!r.ok || !(await openFile(await r.arrayBuffer(), file))) return;
      selectEmbedded(animation);
      if (!$('embedded-anim').value) selectEmbedded(character?.gltf.animations[0]?.name || 'unnamed');
      return;
    }
    await open(url, file);
    selectEmbedded(animation);
  },
});

// Keyframe layers: bone gizmo, Key / Auto key and the graph editor.
const keyPanel = new KeyPanel({
  $, viewport, player, status, motionPanel, retarget: retargetPanel,
  getCharacter: () => character, onSelectJoint: (i) => select(i),
});
motionPanel.keyJoint = () => keyPanel.jointName();
motionPanel.graphOpen = () => keyPanel.graph.open;
// Edit T-pose mode (hand-tuned reference pose for the retargeting).
const tposeEditor = new TPoseEditor({ $, viewport, player, retarget: retargetPanel, status, getCharacter: () => character, applyVisibility });
tposeEditor.onExit = () => { if (player.motion) { player.setFrame(player.frame); motionPanel.schedule(); } };
keyPanel.blocked = () => tposeEditor.active;
motionPanel.tposeActive = () => tposeEditor.active;

// Control rig (IK / FK limbs) and the body picker.
const controlRig = new ControlRig({ $, viewport, player, motionPanel, retarget: retargetPanel, status, getCharacter: () => character });
const picker = new Picker({ host: $('picker'), retarget: retargetPanel, rig: controlRig, getCharacter: () => character, selectJoint: (i) => select(i) });
motionPanel.controlRigRequest = () => controlRig.request();
motionPanel.rigRow = () => controlRig.pickedKeyFrames();
motionPanel.moveRigKey = (f, delta) => controlRig.moveKey(f, delta);
// Anim layer members (Maya-style): the selection, labels, picking a member.
motionPanel.selection = () => controlRig.memberId() ?? (character && selected >= 0 ? `joint:${character.joints[selected].name}` : null);
motionPanel.memberLabel = (id) => controlRig.memberLabel(id);
motionPanel.pickMember = (id) => {
  if (id.startsWith('joint:')) { const i = character?.joints.findIndex((j) => j.name === id.slice(6)) ?? -1; if (i >= 0) select(i); return; }
  const [, limb, kind] = id.split(':');
  if (limb !== 'body' && !controlRig.limb(limb).ik) { controlRig.setIK(limb, true); return; }
  controlRig.pick({ limb, kind });
};
motionPanel.onControls = () => controlRig.onResult();
$('feet-clean').addEventListener('click', async () => {
  const num = (id, d) => { const v = Number($(id).value); return Number.isFinite(v) && v > 0 ? v : d; };
  try {
    await cleanFeet({ rig: controlRig, motionPanel, player, status, getCharacter: () => character },
      { height: num('feet-height', 6) / 100, speed: num('feet-speed', 50) / 100, blend: Math.round(num('feet-blend', 4)) });
  } catch (err) { status(`Feet cleanup failed: ${err.message || err}`, true); }
});
const poseTools = new PoseTools({ $, player, motionPanel, status, getCharacter: () => character, selectedJoint: () => selected });
poseTools.onKeyed = () => keyPanel.updateInfo();

// Channel box: T-pose editing, the picked rig control, anim layer keys, else the joint (read only).
const channelBox = new ChannelBox({ host: $('channel-box'), viewport });
channelBox.add(() => tposeEditor.channelSpec());
channelBox.add(() => (tposeEditor.active ? null : controlRig.channelSpec()));
channelBox.add(() => keyPanel.channelSpec());
channelBox.add(() => { // the selected anim layer's weight (keyable), when nothing else is edited
  const i = motionPanel.active, l = motionPanel.layers[i];
  if (tposeEditor.active || l?.kind !== 'keys' || (character && selected >= 0)) return null;
  const keyed = !!l.weightKeys?.length;
  return { id: `layer:${l.id}`, title: l.name, subtitle: `anim layer weight${keyed ? ' (animated: typing keys it here)' : ' · ◆ in the layer row animates it'}`,
    channels: [{ k: 'w', label: 'Weight', value: motionPanel.weightAt(i) }],
    set: (k, v, final) => motionPanel.setWeight(i, Math.min(1, Math.max(0, v)), final) };
});
channelBox.add(() => {
  const j = character?.joints[selected];
  if (!j || tposeEditor.active) return null;
  const b = j.bone, e = quatEuler(b.quaternion, [0, 0, 0]);
  const v = { tx: b.position.x, ty: b.position.y, tz: b.position.z, rx: e[0], ry: e[1], rz: e[2], sx: b.scale.x, sy: b.scale.y, sz: b.scale.z };
  return { id: `joint:${j.name}`, title: j.name, subtitle: 'local transform (read only) · select an anim layer to key it',
    channels: channels(v, ['tx', 'ty', 'tz', 'rx', 'ry', 'rz', 'sx', 'sy', 'sz'], true) };
});
controlRig.onPick = (p) => { if (p) select(-1, true); picker.render(); motionPanel.renderTimeline(); };
const shownBeforeRig = motionPanel.onShown;
motionPanel.onShown = () => { shownBeforeRig?.(); controlRig.renderPanel(); picker.render(); };

// Column tabs (Outliner | Picker, Animate | Setup); the choice is remembered in this browser.
for (const nav of document.querySelectorAll('nav.tabs')) {
  const aside = nav.parentElement, key = `kimodo-studio-tab-${nav.dataset.tabs}`;
  const show = (tab) => {
    for (const b of nav.querySelectorAll('button')) b.classList.toggle('on', b.dataset.tab === tab);
    for (const page of aside.querySelectorAll(':scope > .tab-page')) page.hidden = page.dataset.page !== tab;
    try { localStorage.setItem(key, tab); } catch { /* storage unavailable */ }
    if (tab === 'picker') picker.render();
  };
  for (const b of nav.querySelectorAll('button')) b.addEventListener('click', () => show(b.dataset.tab));
  let saved = null;
  try { saved = localStorage.getItem(key); } catch { /* storage unavailable */ }
  if (saved && nav.querySelector(`[data-tab="${saved}"]`)) show(saved);
}
motionPanel.isDragging = () => !!viewport.gizmoDragging || tposeEditor.active; // results wait until the mode ends
motionPanel.onKeysEdited = () => { keyPanel.updateInfo(); if (keyPanel.graph.open) keyPanel.graph.draw(); };
const syncKeys = () => keyPanel.sync();
const previousShown = motionPanel.onShown;
motionPanel.onShown = () => { previousShown?.(); syncKeys(); };

// Motion library (grid previews / list, delete): picking sets the active layer's source.
const motionLibrary = new MotionLibrary({
  $, status, motionPanel,
  onPick: (id) => {
    $('motion-source').value = id;
    motionPanel.formChanged();
  },
});

// Undo / redo of scene edits (Ctrl+Z, Ctrl+Y / Ctrl+Shift+Z).
const undoHistory = new History({ $, status, motionPanel, retarget: retargetPanel, keyPanel });
undoHistory.reset(); // the initial state is the first undo step

const sceneFile = new SceneFile({
  $, status, viewport, player, motionPanel, retargetPanel, exportPanel, applyVisibility, clearCharacter,
  getCharacter: () => character,
  openCharacter: (url, name, id) => open(url, name, id, { transfer: false }),
  onOpened: () => undoHistory.reset(),
});

// Animations stored in the loaded GLB (exported files, or any animated character).
function selectEmbedded(name) {
  const clip = character?.gltf.animations.find((a) => (a.name || 'unnamed') === name);
  $('embedded-anim').value = clip ? name : '';
  if (!clip) { player.setEmbedded(null); return; }
  player.clear();
  pathView.clear();
  $('retarget-on').checked = false;
  retargetPanel.sync();
  exportPanel.sync();
  player.setEmbedded({ character, clip });
  // Frame the whole animation: sample the character's bounds at start, middle and end.
  const box = new THREE.Box3();
  for (const f of [0, Math.floor(player.frames / 2), player.frames - 1]) {
    player.setFrame(f);
    box.union(new THREE.Box3().setFromObject(character.root, true));
  }
  player.setFrame(0);
  viewport.frameBox(box, new THREE.Vector3(0.75, 0.45, 0.9));
  $('empty').hidden = true;
  status(`Playing embedded animation "${name}" (${clip.duration.toFixed(2)} s) from ${character.name}`);
}
$('embedded-anim').addEventListener('change', (e) => selectEmbedded(e.target.value));

// Frame the whole motion from its data (root trails + path), at least a person tall.
// side: view perpendicular to the overall travel, slightly from above.
function frameMotion(side = false) {
  const m = player.motion;
  if (!m) return;
  if (player.target && character) {
    const box = new THREE.Box3().setFromObject(character.root, true).union(new THREE.Box3().setFromObject(pathView.group));
    viewport.frameBox(box, side ? new THREE.Vector3(0.75, 0.45, 0.9) : null);
    return;
  }
  const box = new THREE.Box3();
  const p = new THREE.Vector3();
  for (const arr of [m.root, motionPanel.sourceRootShown, motionPanel.samples])
    if (arr) for (let i = 0; i < arr.length; i += 3) box.expandByPoint(p.set(arr[i], arr[i + 1], arr[i + 2]));
  box.min.y = Math.min(box.min.y, 0);
  box.max.y = Math.max(box.max.y + 0.9, 1.9); // root is at the hips
  let dir = null;
  if (side) {
    const r = m.root;
    const travel = new THREE.Vector3(r[r.length - 3] - r[0], 0, r[r.length - 1] - r[2]);
    const fwd = travel.lengthSq() > 0.01 ? travel.normalize() : new THREE.Vector3(0, 0, 1);
    dir = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), fwd).multiplyScalar(-1)
      .addScaledVector(new THREE.Vector3(0, 1, 0), 0.35).addScaledVector(fwd, -0.3);
  }
  viewport.frameBox(box, dir);
}
function frameAll() {
  if (player.motion) frameMotion();
  else if (character) viewport.frame(character.root);
}
$('frame').addEventListener('click', frameAll);
window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
  if (e.key === 'f' || e.key === 'F') frameAll();
  if (e.key === 'Escape') select(-1);
  if (e.key === ' ' && player.motion) { e.preventDefault(); player.play(); }
  if (!player.frames || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === 'ArrowLeft') { e.preventDefault(); goFrame(player.frame - (e.shiftKey ? 10 : 1)); }
  if (e.key === 'ArrowRight') { e.preventDefault(); goFrame(player.frame + (e.shiftKey ? 10 : 1)); }
  if (e.key === 'Home') { e.preventDefault(); goFrame(player.rangeFrames[0]); }
  if (e.key === 'End') { e.preventDefault(); goFrame(player.rangeFrames[1]); }
  if (e.key === 'i' || e.key === 'I') $('range-set-in').click();
  if (e.key === 'o' || e.key === 'O') $('range-set-out').click();
});

// Drag and drop onto the stage.
const stage = document.querySelector('.stage');
let dragDepth = 0;
stage.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; $('drop').hidden = false; });
stage.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('drop').hidden = true; } });
stage.addEventListener('dragover', (e) => e.preventDefault());
stage.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('drop').hidden = true;
  const file = [...e.dataTransfer.files].find((f) => /\.(glb|gltf|fbx)$/i.test(f.name));
  if (file) await openFile(await file.arrayBuffer(), file.name);
  else status('Drop a .glb, .gltf or .fbx file.', true);
});

// Sample rigs served by the demo (tests/data/rigs by default).
fetch('samples/')
  .then((r) => (r.ok ? r.json() : []))
  .then((names) => {
    for (const n of names) $('samples').append(new Option(n, n));
    if (!names.length) $('samples').disabled = true;
  })
  .catch(() => { $('samples').disabled = true; });
$('samples').addEventListener('change', async (e) => {
  const n = e.target.value;
  e.target.value = '';
  if (n) await open(`samples/${encodeURIComponent(n)}`, n, `sample:${n}`);
});

applyVisibility();

// Deep link: /studio/?scene=<url of a saved scene JSON> opens that scene.
if (new URLSearchParams(location.search).get('scene')) {
  fetch(new URLSearchParams(location.search).get('scene'))
    .then((r) => r.json())
    .then((scene) => sceneFile.restore(scene, 'linked scene'))
    .then(() => {
      const q = new URLSearchParams(location.search);
      const i = character?.joints.findIndex((j) => j.name === q.get('joint')) ?? -1;
      if (i >= 0) select(i);
      if (q.get('graph') === '1') keyPanel.toggleGraph(true);
    })
    .catch((err) => status(`Cannot open the linked scene: ${err.message || err}`, true));
}

// Deep links: /studio/?load=samples/test_rig.glb&joint=LeftArm
//             /studio/?motion=sample:soma30-walk-s42&mode=path&preset=scurve&frame=45
//             (with load=...: the motion is retargeted onto the character; align=1 aligns rest poses;
//              mapping=open shows the mapping editor)
const params = new URLSearchParams(location.search);
if (['grid', 'list'].includes(params.get('library'))) { motionLibrary.view = params.get('library'); motionLibrary.open(); }
motionPanel.loadSources().then(() => {
  const motion = params.get('motion');
  if (!motion) return;
  const mode = params.get('mode');
  const radio = mode && document.querySelector(`input[name="root-mode"][value="${CSS.escape(mode)}"]`);
  if (radio) radio.checked = true; // no change event: the explicit apply() below is the only request
  if (params.get('preset')) { $('path-preset').value = params.get('preset'); motionPanel.applyPreset(false); }
  if (params.get('lock')) $('lock').value = params.get('lock');
  if (params.get('timing')) $('timing').value = params.get('timing');
  if (params.get('align') === '1') $('align-rest').checked = true;
  if (params.get('footlock') === '1') { $('foot-lock').checked = true; $('foot-opts').hidden = false; }
  if (params.get('editpath') === '1') setTimeout(() => $('edit-path').click(), 0);
  $('motion-source').value = motion;
  motionPanel.storeForm();
  // stack=demo: a second, additive upper-body layer (in place) at half weight; mask=... overrides its mask.
  if (params.get('stack') === 'demo') {
    motionPanel.addTrack();
    clearTimeout(motionPanel.timer);
    const top = motionPanel.activeLayer;
    top.name = 'Upper additive';
    top.blend = 'additive';
    top.mask = 'upper';
    top.weight = 0.5;
    top.timing = { ...top.timing, start: 0, extend: 'hold', fade_in: 0, fade_out: 0, align_root: false };
    top.config = { ...top.config, mode: 'inplace' };
    if (['full', 'upper', 'lower', 'custom'].includes(params.get('mask'))) top.mask = params.get('mask');
    motionPanel.select(motionPanel.layers.length - 1);
  }
  motionPanel.syncVisibility();
  motionPanel.apply().then(() => {
    if (params.get('frame')) { player.play(false); player.setFrame(Number(params.get('frame'))); }
    if (params.get('mapping') === 'open' && $('mapping-editor').hidden) $('edit-mapping').click();
    if (params.get('export') === '1') $('export-glb').click();
    undoHistory.reset(); // the linked state is where undo starts
  });
}).catch((err) => status(`Cannot list motions: ${err.message || err}`, true));
if (params.get('load')) {
  const url = params.get('load');
  const file = decodeURIComponent(url.split('/').pop());
  open(url, file, url.startsWith('samples/') ? `sample:${file}` : null).then(() => {
    if (params.get('embedded')) {
      selectEmbedded(params.get('embedded'));
      if (params.get('frame')) player.setFrame(Number(params.get('frame')));
    }
    const joint = params.get('joint');
    if (joint && character) select(character.joints.findIndex((j) => j.name === joint));
  });
}

// Debug hook for automated checks: /studio/?debug=1 exposes the main objects.
if (new URLSearchParams(location.search).get('debug') === '1') window.__studio = { THREE, viewport, player, motionPanel, keyPanel, retargetPanel, tposeEditor, controlRig, poseTools, picker, channelBox, getCharacter: () => character, select };
