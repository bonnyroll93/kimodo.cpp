// Retarget controls: enable/disable, joint mapping (automatic, editable, JSON load/save) and
// diagnostics. The mapping uses original glTF joint names, like the C++ importer.

import { checkBindPose, poseCharacter, restoreBindPose } from './bind-pose.js';
import { sourceName } from './source-names.js';

const esc = (s) => String(s);

export class RetargetPanel {
  constructor({ $, status, onChange }) {
    this.$ = $;
    this.status = status;
    this.onChange = onChange; // called when the retarget input changes (re-apply)
    this.character = null;    // loaded character (model-loader result)
    this.characterId = null;  // server id: sample:<file> or upload:<hash>
    this.upload = null;       // ArrayBuffer of a locally opened file, uploaded on demand
    this.skeletonKey = null;
    this.sourceNames = [];
    this.mapping = null;
    this.timer = 0;

    $('retarget-on').addEventListener('change', () => { this.sync(); this.onChange(); });
    $('align-rest').addEventListener('change', () => { this.alignTouched = true; this.showTPose(false); this.onChange(); });
    $('clear-tpose').addEventListener('click', () => { this.setReferencePose(null); this.status('Using the automatic T-pose again'); });
    $('show-tpose').addEventListener('click', () => this.showTPose(!this.tposeShown).catch((e) => this.status(`T-pose preview: ${e.message || e}`, true)));
    $('edit-mapping').addEventListener('click', () => {
      $('mapping-editor').hidden = !$('mapping-editor').hidden;
      $('edit-mapping').textContent = $('mapping-editor').hidden ? 'Edit mapping' : 'Hide mapping';
      if (!$('mapping-editor').hidden) this.renderEditor();
    });
    $('auto-mapping').addEventListener('click', async () => {
      this.mapping = null;
      await this.ensureMapping(true);
      this.renderEditor();
      this.onChange();
    });
    $('save-mapping').addEventListener('click', () => this.download());
    $('load-mapping').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      try {
        const parsed = JSON.parse(await file.text());
        if (!Array.isArray(parsed.joints)) throw new Error('missing "joints" array');
        this.mapping = parsed;
        await this.check();
        this.renderEditor();
        this.onChange();
      } catch (err) {
        this.status(`Cannot load mapping: ${err.message || err}`, true);
      }
    });
    this.sync();
  }

  get enabled() { return this.$('retarget-on').checked && !!this.character && this.character.joints.length > 0; }

  // Mappings edited for a character are remembered for the session, so switching rigs back
  // and forth keeps them.
  cacheKey() { return this.character ? `${this.characterId ?? this.character.name}|${this.skeletonKey ?? ''}` : null; }

  setCharacter(character, { id = null, upload = null } = {}) {
    this.mappingCache ??= new Map();
    if (this.mapping && this.cacheKey()) this.mappingCache.set(this.cacheKey(), this.mapping);
    this.showTPose(false);
    this.character = character;
    this.characterId = id;
    this.alignTouched = false; // the bind-pose check may turn alignment on for a new character
    this.poseInfo = null;
    this.$('pose-status').textContent = '';
    this.syncPose();
    this.upload = upload;
    this.mapping = this.mappingCache.get(this.cacheKey()) ?? null;
    this.referencePose = this.poseCache?.get(this.character?.name ?? '') ?? null; // edited T-pose, per character
    this.diagnostics(null);
    if (character && character.joints.length) this.$('retarget-on').checked = true;
    this.sync();
    this.renderEditor();
  }

  async setSource(skeletonKey) {
    if (skeletonKey === this.skeletonKey) return;
    this.skeletonKey = skeletonKey;
    this.mapping = null;
    const r = await fetch(`/api/skeletons/${encodeURIComponent(skeletonKey)}`);
    this.sourceDef = r.ok ? await r.json() : null;
    this.sourceNames = this.sourceDef?.names ?? [];
  }

  // The source skeleton's rest: are its arms horizontal (a T-pose)? Native rests have identity
  // rotations, so an upper arm points along its forearm joint's offset. G1 rests arms down.
  sourceRestArms() {
    const d = this.sourceDef;
    if (!d?.names || !d.offsets) return null;
    const out = [];
    for (const side of ['Left', 'Right']) {
      const i = d.names.indexOf(sourceName(this.skeletonKey, `${side}ForeArm`));
      if (i < 0) continue;
      const [x, y, z] = d.offsets[i], len = Math.hypot(x, y, z);
      if (len > 1e-6) out.push({ side, degrees: (Math.asin(y / len) * 180) / Math.PI });
    }
    return out.length ? out : null;
  }

  sync() {
    const has = !!this.character && this.character.joints.length > 0;
    this.$('retarget-on').disabled = !has;
    this.$('retarget-hint').textContent = has ? '' : 'Load a rigged character (Open GLB / Sample rigs) to retarget the motion onto it.';
    this.$('retarget-opts').hidden = !this.enabled;
  }

  async ensureCharacterId() {
    if (this.characterId) return this.characterId;
    if (!this.upload) throw new Error('character file not available for upload');
    this.status('Uploading character…');
    const r = await fetch('/api/characters', { method: 'POST', body: this.upload });
    const body = await r.json();
    if (!r.ok) throw new Error(body.error || `upload failed (HTTP ${r.status})`);
    this.characterId = body.id;
    return this.characterId;
  }

  async ensureMapping(force = false) {
    if (this.mapping && !force) return this.mapping;
    const id = await this.ensureCharacterId();
    const r = await fetch(`/api/retarget/map?character=${encodeURIComponent(id)}&skeleton=${encodeURIComponent(this.skeletonKey)}`);
    const body = await r.json();
    if (!r.ok) throw new Error(body.error || `mapping failed (HTTP ${r.status})`);
    this.mapping = body.mapping;
    this.diagnostics(body);
    this.checkPose();
    return this.mapping;
  }

  async check() {
    const id = await this.ensureCharacterId();
    const r = await fetch('/api/retarget/check', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ character: id, skeleton: this.skeletonKey, mapping: this.mapping }),
    });
    const body = await r.json();
    if (!r.ok) throw new Error(body.error || `check failed (HTTP ${r.status})`);
    this.diagnostics(body);
    return body;
  }

  // Request fragment for /api/retarget, or null when retargeting is off.
  async request() {
    if (!this.enabled) return null;
    const mapping = await this.ensureMapping();
    return { character: await this.ensureCharacterId(), mapping, align_rest: this.$('align-rest').checked,
      ...(this.referencePose ? { reference_pose: this.referencePose } : {}) };
  }

  // Bind pose check: not a T-pose -> retarget from the T-pose (unless the user chose otherwise).
  checkPose() {
    const info = this.character && checkBindPose(this.character, this.mapping, this.skeletonKey);
    this.poseInfo = info;
    const $ = this.$;
    if (!info) { $('pose-status').textContent = ''; return; }
    const arms = info.arms.map((a) => `${a.side.toLowerCase()} arm ${a.degrees > 0 ? '+' : ''}${a.degrees.toFixed(0)}°`).join(', ');
    // The source skeleton at rest without horizontal arms (e.g. the Unitree G1: arms down):
    // the character's rest must be aligned onto it too.
    const src = this.sourceRestArms();
    const srcNotT = !!src && src.some((a) => Math.abs(a.degrees) > 12);
    if ((!info.tpose || srcNotT) && !this.alignTouched && !$('align-rest').checked) {
      $('align-rest').checked = true;
      this.status(srcNotT && info.tpose
        ? `${this.skeletonKey} rests with its arms at ${src.map((a) => `${a.degrees.toFixed(0)}°`).join(' / ')} (not a T-pose): "Retarget from T-pose" turned on so the arms follow`
        : `${this.character.name}: bind pose is an ${info.label} (${arms}) — retargeting from its T-pose ("Retarget from T-pose" turned on)`);
    }
    const tail = this.referencePose ? ' → retargeted from your edited T-pose'
      : info.tpose ? '' : $('align-rest').checked ? ' → retargeted from the T-pose' : ' — turn on "Retarget from T-pose"';
    $('pose-status').textContent = `Bind pose: ${info.label} (${arms})${tail}`;
  }

  // The character's hand-edited T-pose (null: the automatic one); remembered per character.
  setReferencePose(pose) {
    this.referencePose = pose;
    this.poseCache ??= new Map();
    if (this.character) this.poseCache.set(this.character.name, pose);
    this.checkPose();
    this.syncPose();
    this.onChange();
  }

  syncPose() {
    const custom = !!this.referencePose;
    this.$('align-rest').disabled = custom;
    this.$('clear-tpose').hidden = !custom;
    this.$('edit-tpose').textContent = custom ? 'Edit T-pose (custom)' : 'Edit T-pose';
  }

  // T-pose preview: the character as the retargeting sees it at the source's rest.
  async showTPose(on) {
    const $ = this.$;
    if (!on) {
      if (this.tposeShown) {
        this.tposeShown = false;
        $('show-tpose').classList.remove('on');
        $('show-tpose').textContent = 'Show T-pose';
        if (this.onRestorePose) this.onRestorePose();
        else if (this.character) restoreBindPose(this.character);
      }
      return;
    }
    if (!this.character || !this.skeletonKey) throw new Error('load a character and a motion first');
    const body = { character: await this.ensureCharacterId(), skeleton: this.skeletonKey, mapping: await this.ensureMapping(),
      ...(this.referencePose ? { reference_pose: this.referencePose } : {}) };
    const r = await fetch('/api/retarget/tpose', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const res = await r.json();
    if (!r.ok) throw new Error(res.error || `HTTP ${r.status}`);
    const rot = new Float32Array(await (await fetch(res.rotations)).arrayBuffer());
    this.onBeforePose?.();
    poseCharacter(this.character, res.meta, rot);
    this.tposeShown = true;
    $('show-tpose').classList.add('on');
    $('show-tpose').textContent = 'Hide T-pose';
    this.status('T-pose preview: the pose the retargeting starts from (change frame or press Hide to go back)');
  }

  diagnostics(d) {
    const box = this.$('mapping-status');
    box.replaceChildren();
    if (!d) return;
    const mapped = this.mapping?.joints?.length ?? 0;
    const total = this.character?.joints.length ?? 0;
    const head = document.createElement('div');
    head.textContent = `${mapped} / ${total} target joints mapped` +
      (d.facing_yaw_degrees !== undefined ? ` · facing ${Math.round(d.facing_yaw_degrees)}° · root scale ${Number(d.root_scale).toFixed(2)}` : '');
    box.append(head);
    for (const [cls, list] of [['diag-error', d.errors || []], ['diag-warning', d.warnings || []]])
      for (const msg of list) {
        const p = document.createElement('div');
        p.className = cls;
        p.textContent = msg;
        box.append(p);
      }
  }

  renderEditor() {
    const host = this.$('mapping-rows');
    host.replaceChildren();
    if (this.$('mapping-editor').hidden || !this.character) return;
    const bySource = new Map((this.mapping?.joints || []).map((j) => [j.target, j.source]));
    const depth = (j) => { let d = 0; for (let p = j.parent; p >= 0; p = this.character.joints[p].parent) d++; return d; };
    for (const j of this.character.joints) {
      const row = document.createElement('label');
      row.className = 'map-row' + (j.deforming ? '' : ' nondeforming');
      const name = document.createElement('span');
      name.className = 'map-target';
      name.style.paddingLeft = `${Math.min(depth(j), 8) * 6}px`;
      name.textContent = esc(j.name);
      const select = document.createElement('select');
      select.append(new Option('— rest —', ''));
      for (const s of this.sourceNames) select.append(new Option(s, s));
      select.value = bySource.get(j.name) || '';
      select.addEventListener('change', () => this.edit(j.name, select.value));
      row.append(name, select);
      host.append(row);
    }
  }

  edit(target, source) {
    if (!this.mapping) this.mapping = { version: 1, joints: [] };
    this.mapping.joints = this.mapping.joints.filter((j) => j.target !== target);
    if (source) {
      this.mapping.joints.push({ target, source });
      const order = new Map(this.character.joints.map((j, i) => [j.name, i]));
      this.mapping.joints.sort((a, b) => (order.get(a.target) ?? 1e9) - (order.get(b.target) ?? 1e9));
    }
    clearTimeout(this.timer);
    this.timer = setTimeout(async () => {
      try {
        const d = await this.check();
        if (!d.errors?.length) this.onChange();
      } catch (err) {
        this.status(`Mapping check failed: ${err.message || err}`, true);
      }
    }, 250);
  }

  download() {
    if (!this.mapping) return;
    const blob = new Blob([JSON.stringify(this.mapping, null, 2) + '\n'], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    const base = (this.character?.name || 'character').replace(/\.[^.]+$/, '');
    a.download = `${base}.${this.skeletonKey || 'source'}.mapping.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
}
