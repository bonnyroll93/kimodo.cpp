// Export the current result (retargeted motion or layer stack on the loaded character) as
// one GLB or FBX through /api/export (FBX: the GLB converted by Blender on the server, when
// it has Blender), then download it or reopen it in the viewer.

export class ExportPanel {
  constructor({ $, status, motionPanel, retarget, onOpen, takes = null }) {
    this.takes = takes; // editor/takes.js (all-takes export)
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
    $('export-takes').addEventListener('change', () => this.sync());
    $('export-mode').addEventListener('change', () => this.sync());
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
    const all = this.$('export-takes').value === 'all';
    this.$('export-mode-row').hidden = !all;
    const n = this.takes?.takes.length ?? 1;
    this.$('export-glb').textContent = all ? `Export ${n} take${n === 1 ? '' : 's'} (${this.format.toUpperCase()})` : `Export ${this.format.toUpperCase()}`;
    this.$('export-hint').textContent = ok ? '' : 'Retarget onto a character to export it.';
  }

  async export() {
    const $ = this.$;
    if ($('export-takes').value === 'all' && this.takes) return this.exportTakes();
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
      $('export-files').hidden = true;
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

  // Every take: one file each (+ a zip), one file with a take per animation, or all takes in
  // sequence on one timeline (/api/export/takes).
  async exportTakes() {
    const $ = this.$, mode = $('export-mode').value, format = this.format;
    try {
      const rt = await this.retarget.request();
      if (!rt) throw new Error('retarget onto a character first');
      const foot_lock = this.motionPanel.footLockRequest();
      const takes = this.takes.takes.map((t, k) => ({
        name: t.name,
        stack: this.takes.withTake(k, () => ({ ...rt, ...this.motionPanel.stackBody(), ...(foot_lock ? { foot_lock } : {}) })),
      }));
      $('export-glb').disabled = true;
      this.status(`Exporting ${takes.length} take(s) (${mode === 'per_take' ? 'one file each' : mode === 'single' ? 'one file' : 'in sequence'}, ${format.toUpperCase()})…`);
      const r = await fetch('/api/export/takes', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: $('export-name').value || 'Kimodo', format, mode, takes }) });
      const res = await r.json();
      if (!r.ok) throw new Error(res.error || `HTTP ${r.status}`);
      const first = res.files[0];
      this.result = { url: first.url, file: first.file, name: first.take || res.name };
      $('export-link').href = (res.zip ?? first).url + '?download=1';
      $('export-link').download = (res.zip ?? first).file;
      $('export-link').textContent = `Download ${(res.zip ?? first).file} (${(((res.zip ?? first).bytes) / 1024).toFixed(0)} KiB)`;
      const list = $('export-files');
      list.replaceChildren();
      if (res.files.length > 1) for (const f of res.files) {
        const a = document.createElement('a');
        Object.assign(a, { href: f.url + '?download=1', download: f.file, textContent: `${f.take ? `${f.take}: ` : ''}${f.file} (${(f.bytes / 1024).toFixed(0)} KiB)` });
        list.append(a);
      }
      list.hidden = res.files.length < 2;
      $('export-result').hidden = false;
      this.status(`Exported ${takes.length} take(s): ${res.files.map((f) => f.file).join(', ')}${res.zip ? ` (+ ${res.zip.file})` : ''}`);
    } catch (err) {
      this.status(`Export failed: ${err.message || err}`, true);
    } finally {
      this.sync();
    }
  }
}
