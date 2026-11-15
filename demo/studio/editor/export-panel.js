// Export the current result (retargeted motion or layer stack on the loaded character) as
// one GLB through /api/export, then download it or reopen it in the viewer.

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
      if (this.result) this.onOpen(this.result.url, `${this.result.name}.glb`, this.result.name);
    });
  }

  sync() {
    const ok = !!this.retarget.enabled;
    this.$('export-glb').disabled = !ok;
    this.$('export-hint').textContent = ok ? '' : 'Retarget onto a character to export it.';
  }

  async export() {
    const $ = this.$;
    try {
      const rt = await this.retarget.request();
      if (!rt) throw new Error('retarget onto a character first');
      const foot_lock = this.motionPanel.footLockRequest();
      const body = { name: $('export-name').value || 'Kimodo', ...rt, ...this.motionPanel.stackBody(), ...(foot_lock ? { foot_lock } : {}) };
      $('export-glb').disabled = true;
      this.status('Exporting GLB…');
      const r = await fetch('/api/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const res = await r.json();
      if (!r.ok) throw new Error(res.error || `HTTP ${r.status}`);
      this.result = res;
      $('export-link').href = res.download;
      $('export-link').download = `${res.name}.glb`;
      $('export-link').textContent = `Download ${res.name}.glb (${(res.bytes / 1024).toFixed(0)} KiB)`;
      $('export-result').hidden = false;
      this.status(`Exported ${res.name}.glb: ${res.meta.frames} frames, ${res.meta.joints.length} joints`);
    } catch (err) {
      this.status(`Export failed: ${err.message || err}`, true);
    } finally {
      this.sync();
    }
  }
}
