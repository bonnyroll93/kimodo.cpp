// Kimodo Studio entry point: wires viewport, loader, skeleton overlay, hierarchy and inspector.
import { Viewport } from './viewer/viewport.js';
import { loadCharacter, disposeCharacter } from './viewer/model-loader.js';
import { SkeletonView } from './viewer/skeleton-view.js';
import { installJointPicking } from './viewer/joint-selection.js';
import { SceneHierarchy } from './editor/scene-hierarchy.js';
import { Inspector } from './editor/inspector.js';

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

function applyVisibility() {
  if (character) character.root.traverse((o) => { if (o.isMesh) o.visible = $('show-mesh').checked; });
  skeletonView.setVisible({ joints: $('show-joints').checked, skeleton: $('show-skeleton').checked });
  viewport.grid.visible = $('show-grid').checked;
  viewport.axes.visible = $('show-axes').checked;
}
for (const id of ['show-mesh', 'show-skeleton', 'show-joints', 'show-grid', 'show-axes'])
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

$('frame').addEventListener('click', () => { if (character) viewport.frame(character.root); });
window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  if (e.key === 'f' || e.key === 'F') { if (character) viewport.frame(character.root); }
  if (e.key === 'Escape') select(-1);
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

// Deep link: /studio/?load=samples/test_rig.glb&joint=LeftArm
const params = new URLSearchParams(location.search);
if (params.get('load')) {
  const url = params.get('load');
  open(url, decodeURIComponent(url.split('/').pop())).then(() => {
    const joint = params.get('joint');
    if (joint && character) select(character.joints.findIndex((j) => j.name === joint));
  });
}
