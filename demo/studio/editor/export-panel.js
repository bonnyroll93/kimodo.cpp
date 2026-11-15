// Export the current result (retargeted motion or layer stack on the loaded character) as
// one GLB or FBX through /api/export (FBX: the GLB converted by Blender on the server, when
// it has Blender), then download it or reopen it in the viewer.

export class ExportPanel {
  constructor({ $, status, motionPanel, retarget, onOpen }) {
    this.$ = $;
    this.status = status;
    this.motionPanel = motionPanel;
    this.retarget = retarget;
    this.onOpen = onOpen; // (url, fileName) => Promise
    this.result = null;
    $('export-glb').addEventListener('click', () => this.export());
    $('open-export').addEventListener('click', () => {
      if (this.result) this.onOpen(this.result.url, this.result.file ?? `${this.result.name}.glb`, this.result.name);
    });
    $('export-format').addEventListener('change', () => this.sync());
    // FBX export needs Blender on the server.
    fetch('/api/fbx').then((r) => r.json()).then((info) => {
      const opt = $('export-format').querySelector('option[value="fbx"]');
      opt.disabled = !info.available;
      opt.textContent = info.available ? 'FBX' : 'FBX (needs Blender)';
      $('export-format').title = info.available ? `FBX through ${info.blender}` : 'FBX export needs Blender on the server (-blender PATH)';
      if (!info.available && $('export-format').value === 'fbx') $('export-format').value = 'glb';
      this.sync();
    }).catch(() => {});
  }

  get format() { return this.$('export-format').value === 'fbx' ? 'fbx' : 'glb'; }

  sync() {
    const ok = !!this.retarget.enabled;
    this.$('export-glb').disabled = !ok;
    this.$('export-glb').textContent = `Export ${this.format.toUpperCase()}`;
    this.$('export-hint').textContent = ok ? '' : 'Retarget onto a character to export it.';
  }

  async export() {
    const $ = this.$;
    try {
      const rt = await this.retarget.request();
      if (!rt) throw new Error('retarget onto a character first');
      const foot_lock = this.motionPanel.footLockRequest();
      const format = this.format;
      const body = { name: $('export-name').value || 'Kimodo', format, ...rt, ...this.motionPanel.stackBody(), ...(foot_lock ? { foot_lock } : {}) };
      $('export-glb').disabled = true;
      this.status(format === 'fbx' ? 'Exporting FBX (baking, then converting with Blender: this takes a few seconds)…' : 'Exporting GLB…');
      const r = await fetch('/api/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const res = await r.json();
      if (!r.ok) throw new Error(res.error || `HTTP ${r.status}`);
      this.result = res;
      $('export-link').href = res.download;
      const file = res.file ?? `${res.name}.glb`;
      $('export-link').download = file;
      $('export-link').textContent = `Download ${file} (${(res.bytes / 1024).toFixed(0)} KiB)`;
      $('export-result').hidden = false;
      this.status(`Exported ${file}: ${res.meta.frames} frames, ${res.meta.joints.length} joints`);
    } catch (err) {
      this.status(`Export failed: ${err.message || err}`, true);
    } finally {
      this.sync();
    }
  }
}
