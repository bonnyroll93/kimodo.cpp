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
  $('playbar').hidden = !p.motion;
  $('play').textContent = p.playing ? 'Pause' : 'Play';
  $('scrub').max = Math.max(p.frames - 1, 0);
  $('scrub').value = p.frame;
  $('frame-label').textContent = `${p.frame + 1} / ${p.frames} · ${p.time.toFixed(2)} s`;
});
$('play').addEventListener('click', () => player.play());
$('scrub').addEventListener('input', (e) => { player.play(false); player.setFrame(Number(e.target.value)); });
$('loop').addEventListener('change', (e) => { player.loop = e.target.checked; });
const motionPanel = new MotionPanel({
  $, player, pathView, status,
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
  player.setVisible({ joints: $('show-joints').checked, skeleton: $('show-skeleton').checked });
  pathView.visible = $('show-path').checked;
  viewport.grid.visible = $('show-grid').checked;
  viewport.axes.visible = $('show-axes').checked;
}
for (const id of ['show-mesh', 'show-skeleton', 'show-joints', 'show-grid', 'show-axes', 'show-path'])
  $(id).addEventListener('change', applyVisibility);

async function open(source, name) {
  status(`Loading ${name}…`);
  try {
    const next = await loadCharacter(source, name);
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
    select(-1);
    applyVisibility();
    $('empty').hidden = true;
    $('joint-count').textContent = character.joints.length ? `${character.joints.length} joints` : '';
    const s = character.stats;
    const msg = `${name}: ${s.joints} joints, ${s.skinnedMeshes} skinned mesh${s.skinnedMeshes === 1 ? '' : 'es'}, ${s.triangles.toLocaleString()} triangles`;
    status(character.warnings.length ? `${msg} — ${character.warnings.join(' ')}` : msg, character.warnings.length > 0);
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

// Frame the whole motion from its data (root trails + path), at least a person tall.
// side: view perpendicular to the overall travel, slightly from above.
function frameMotion(side = false) {
  const m = player.motion;
  if (!m) return;
  const box = new THREE.Box3();
  const p = new THREE.Vector3();
  for (const arr of [m.root, motionPanel.sourceRoot, motionPanel.samples])
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
  if (n) await open(`samples/${encodeURIComponent(n)}`, n);
});

applyVisibility();

// Deep links: /studio/?load=samples/test_rig.glb&joint=LeftArm
//             /studio/?motion=sample:soma30-walk-s42&mode=path&preset=scurve&frame=45
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
  $('motion-source').value = motion;
  motionPanel.syncVisibility();
  motionPanel.apply().then(() => {
    if (params.get('frame')) { player.play(false); player.setFrame(Number(params.get('frame'))); }
  });
}).catch((err) => status(`Cannot list motions: ${err.message || err}`, true));
if (params.get('load')) {
  const url = params.get('load');
  open(url, decodeURIComponent(url.split('/').pop())).then(() => {
    const joint = params.get('joint');
    if (joint && character) select(character.joints.findIndex((j) => j.name === joint));
  });
}
