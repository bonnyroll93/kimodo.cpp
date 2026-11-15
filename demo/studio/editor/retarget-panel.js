// Retarget controls: enable/disable, joint mapping (automatic, editable, JSON load/save) and
// diagnostics. The mapping uses original glTF joint names, like the C++ importer.

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
    $('align-rest').addEventListener('change', () => this.onChange());
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

  setCharacter(character, { id = null, upload = null } = {}) {
    this.character = character;
    this.characterId = id;
    this.upload = upload;
    this.mapping = null;
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
    this.sourceNames = r.ok ? (await r.json()).names : [];
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
    return { character: await this.ensureCharacterId(), mapping, align_rest: this.$('align-rest').checked };
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
