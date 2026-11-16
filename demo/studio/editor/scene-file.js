// Save / open the studio scene as JSON: character reference, anim clips (track, timing, motion
// source, root motion, path waypoints, blend, weight, masks...) and anim layers (keyframes), scene length, retarget mapping and options, foot
// locking, export name, view toggles, playback position and camera.
// Motions and characters are referenced, not embedded: sample rigs by name, uploaded
// characters by content hash (the demo keeps them), motions by their gallery/sample id.

import { normalizeLayers } from './motion-panel.js';

const FORMAT = 'kimodo-studio-scene';
const TOGGLES = ['show-mesh', 'show-skeleton', 'show-joints', 'show-grid', 'show-axes', 'show-path', 'show-source'];

export class SceneFile {
  constructor(ctx) {
    this.ctx = ctx;
    const { $ } = ctx;
    $('save-scene').addEventListener('click', () => this.save().catch((e) => ctx.status(`Cannot save the scene: ${e.message || e}`, true)));
    $('open-scene').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      try {
        await this.restore(JSON.parse(await file.text()), file.name);
      } catch (err) {
        ctx.status(`Cannot open the scene: ${err.message || err}`, true);
      }
    });
  }

  async collect() {
    const { $, viewport, player, motionPanel, retargetPanel, getCharacter } = this.ctx;
    const character = getCharacter();
    let characterRef = null;
    if (character) {
      let id = null;
      try { id = await retargetPanel.ensureCharacterId(); } catch { /* not uploadable: keep the name only */ }
      characterRef = { name: character.name, id };
    }
    const num = (id) => Number($(id).value) || 0;
    return {
      format: FORMAT,
      version: 1,
      saved: new Date().toISOString(),
      character: characterRef,
      layers: motionPanel.layers.map(({ customMaskFrom, ...l }) => structuredClone(l)),
      active_layer: motionPanel.active,
      retarget: {
        enabled: $('retarget-on').checked, align_rest: $('align-rest').checked,
        mapping: retargetPanel.mapping ? structuredClone(retargetPanel.mapping) : null,
        reference_pose: retargetPanel.referencePose ?? null,
      },
      foot_lock: {
        enabled: $('foot-lock').checked, adjust_hips: $('hip-adjust').checked,
        height: num('foot-height'), speed: num('foot-speed'), blend: num('foot-blend'),
      },
      export_name: $('export-name').value,
      view: Object.fromEntries(TOGGLES.map((id) => [id, $(id).checked])),
      scene_length: motionPanel.sceneLength,
      anim_start: motionPanel.animStart ?? 0,
      control_rig: motionPanel.controlRig ?? null,
      root_scope: motionPanel.rootScope,
      groups: structuredClone(motionPanel.groups ?? []),
      scene_root: structuredClone(motionPanel.sceneRoot),
      playback: { frame: player.frame, loop: player.loop, range: player.range ?? null },
      camera: { position: viewport.camera.position.toArray(), target: viewport.controls.target.toArray() },
    };
  }

  async save() {
    const scene = await this.collect();
    const blob = new Blob([JSON.stringify(scene, null, 2) + '\n'], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    const base = (scene.character?.name ?? 'scene').replace(/\.[^.]+$/, '');
    a.download = `${base}.kimodo-scene.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    this.ctx.status(`Scene saved: ${scene.layers.length} clip(s) / anim layer(s)${scene.character ? `, character ${scene.character.name}` : ''}`);
  }

  async restore(scene, fileName) {
    const { $, viewport, player, motionPanel, retargetPanel, exportPanel, openCharacter, clearCharacter, applyVisibility, status } = this.ctx;
    if (scene?.format !== FORMAT || scene.version !== 1) throw new Error('not a Kimodo studio scene (version 1)');
    if (!Array.isArray(scene.layers) || !scene.layers.length) throw new Error('the scene has no layers');
    status(`Opening ${fileName}…`);
    clearTimeout(motionPanel.timer);
    const warnings = [];

    // Character first (it resets the retarget panel).
    const c = scene.character;
    if (c?.id?.startsWith('sample:')) {
      await openCharacter(`samples/${encodeURIComponent(c.id.slice(7))}`, c.name, c.id);
    } else if (c?.id?.startsWith('upload:')) {
      await openCharacter(`/api/characters/${encodeURIComponent(c.id.slice(7))}.glb`, c.name, c.id);
    } else if (c) {
      warnings.push(`character "${c.name}" was not stored on the server: open it again with Open GLB`);
    } else {
      clearCharacter();
    }
    if (c && !this.ctx.getCharacter()) warnings.push(`character "${c.name}" could not be loaded`);

    // Options.
    for (const [id, on] of Object.entries(scene.view ?? {})) if ($(id)) $(id).checked = !!on;
    const fl = scene.foot_lock ?? {};
    $('foot-lock').checked = !!fl.enabled;
    $('hip-adjust').checked = fl.adjust_hips !== false;
    $('foot-height').value = fl.height ?? 0;
    $('foot-speed').value = fl.speed ?? 0;
    $('foot-blend').value = fl.blend ?? 4;
    $('foot-opts').hidden = !fl.enabled;
    $('export-name').value = scene.export_name || 'Kimodo';
    $('retarget-on').checked = !!scene.retarget?.enabled && !!this.ctx.getCharacter();
    $('align-rest').checked = !!scene.retarget?.align_rest;

    // Layers and the active layer's form.
    await motionPanel.loadSources();
    const missing = scene.layers.map((l) => l.config?.source).filter((s) => s && !motionPanel.sources.has(s));
    if (missing.length) warnings.push(`motion source(s) not found on this server: ${[...new Set(missing)].join(', ')}`);
    motionPanel.layers = normalizeLayers(structuredClone(scene.layers));
    motionPanel.sceneLength = Math.max(0, Number(scene.scene_length) || 0);
    motionPanel.animStart = Math.max(0, Math.round(Number(scene.anim_start) || 0));
    motionPanel.controlRig = scene.control_rig ? structuredClone(scene.control_rig) : null;
    motionPanel.rootScope = scene.root_scope === 'scene' ? 'scene' : 'clip';
    motionPanel.groups = Array.isArray(scene.groups) ? structuredClone(scene.groups) : [];
    motionPanel.groupFocus = null;
    if (scene.scene_root) motionPanel.sceneRoot = structuredClone(scene.scene_root);
    motionPanel.select(Math.min(Math.max(0, scene.active_layer | 0), motionPanel.layers.length - 1));

    // The saved mapping belongs to the base layer's skeleton.
    const key = motionPanel.sources.get(motionPanel.layers[0].config?.source)?.skeleton_key;
    if (key) await retargetPanel.setSource(key);
    retargetPanel.mapping = scene.retarget?.mapping ? structuredClone(scene.retarget.mapping) : null;
    retargetPanel.referencePose = scene.retarget?.reference_pose ?? null;
    retargetPanel.syncPose();
    retargetPanel.sync();
    exportPanel.sync();
    applyVisibility();

    await motionPanel.apply();
    clearTimeout(motionPanel.timer);
    player.loop = scene.playback?.loop !== false;
    $('loop').checked = player.loop;
    player.play(false);
    player.setRange(Array.isArray(scene.playback?.range) ? scene.playback.range : null);
    player.setFrame(scene.playback?.frame ?? 0);
    motionPanel.renderTimeline();
    if (scene.camera?.position && scene.camera?.target) {
      viewport.camera.position.fromArray(scene.camera.position);
      viewport.controls.target.fromArray(scene.camera.target);
      viewport.controls.update();
    }
    this.ctx.onOpened?.();
    if (warnings.length) status(`Scene opened with warnings: ${warnings.join('; ')}`, true);
    else status(`Scene opened: ${fileName}`);
  }
}
