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

const $ = (id) => document.getElementById(id);
const status = (text, error = false) => {
  $('status').textContent = text;
  $('status').classList.toggle('error', error);
};

const viewport = new Viewport($('viewport'));
const skeletonView = new SkeletonView(viewport.scene);
let character = null;
let selected = -1;

function select(index) {
  selected = character && index >= 0 && index < character.joints.length ? index : -1;
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
  motionPanel?.timeline.update(p.time);
});
$('play').addEventListener('click', () => player.play());
$('scrub').addEventListener('input', (e) => { player.play(false); player.setFrame(Number(e.target.value)); });
$('loop').addEventListener('change', (e) => { player.loop = e.target.checked; });
const retargetPanel = new RetargetPanel({ $, status, onChange: () => { exportPanel.sync(); motionPanel.schedule(); } });
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
async function open(source, name, serverId = null) {
  status(`Loading ${name}…`);
  try {
    const next = await loadCharacter(source, name);
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
    exportPanel.sync();
    const anims = character.gltf.animations.map((a) => a.name || 'unnamed');
    $('embedded-anim').replaceChildren(new Option(anims.length ? 'None (use Motion / Layers)' : 'none', ''), ...anims.map((n) => new Option(n, n)));
    $('embedded-row').hidden = !anims.length;
    if (player.motion) motionPanel.schedule();
    select(-1);
    applyVisibility();
    $('empty').hidden = true;
    $('joint-count').textContent = character.joints.length ? `${character.joints.length} joints` : '';
    const s = character.stats;
    const msg = `${name}: ${s.joints} joints, ${s.skinnedMeshes} skinned mesh${s.skinnedMeshes === 1 ? '' : 'es'}, ${s.triangles.toLocaleString()} triangles`;
    const extra = [...character.warnings, ...character.notes];
    status(extra.length ? `${msg} — ${extra.join(' ')}` : msg, character.warnings.length > 0);
  } catch (err) {
    console.error(err);
    status(`Could not load ${name}: ${err.message || err}`, true);
  }
}

$('file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (file) await open(await file.arrayBuffer(), file.name);
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

const exportPanel = new ExportPanel({
  $, status, motionPanel, retarget: retargetPanel,
  // Reopen an exported GLB: it replaces the character and plays its embedded animation.
  onOpen: async (url, file, animation) => {
    $('retarget-on').checked = false;
    player.clear();
    pathView.clear();
    await open(url, file);
    selectEmbedded(animation);
  },
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
  const file = [...e.dataTransfer.files].find((f) => /\.(glb|gltf)$/i.test(f.name));
  if (file) await open(await file.arrayBuffer(), file.name);
  else status('Drop a .glb or .gltf file.', true);
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

// Deep links: /studio/?load=samples/test_rig.glb&joint=LeftArm
//             /studio/?motion=sample:soma30-walk-s42&mode=path&preset=scurve&frame=45
//             (with load=...: the motion is retargeted onto the character; align=1 aligns rest poses;
//              mapping=open shows the mapping editor)
const params = new URLSearchParams(location.search);
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
  motionPanel.activeLayer.config = motionPanel.readForm();
  // stack=demo: a second, additive upper-body layer (in place) at half weight; mask=... overrides its mask.
  if (params.get('stack') === 'demo') {
    $('add-layer').click();
    clearTimeout(motionPanel.timer);
    const top = motionPanel.activeLayer;
    top.name = 'Upper additive';
    top.config = { ...top.config, mode: 'inplace' };
    if (['full', 'upper', 'lower', 'custom'].includes(params.get('mask'))) top.mask = params.get('mask');
    motionPanel.select(motionPanel.layers.length - 1);
  }
  motionPanel.syncVisibility();
  motionPanel.apply().then(() => {
    if (params.get('frame')) { player.play(false); player.setFrame(Number(params.get('frame'))); }
    if (params.get('mapping') === 'open' && $('mapping-editor').hidden) $('edit-mapping').click();
    if (params.get('export') === '1') $('export-glb').click();
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
