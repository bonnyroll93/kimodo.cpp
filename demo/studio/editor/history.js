// Undo / redo for the scene being edited (Ctrl+Z, Ctrl+Y / Ctrl+Shift+Z, toolbar buttons).
// Every edit ends in MotionPanel.schedule() (layers, sources, root motion and paths,
// keyframes from the gizmo and the graph editor, masks, clip timing, mapping, foot locking),
// so the history snapshots the editable state shortly after each scheduled change and keeps
// it when it differs from the previous one. Undo/redo restores a snapshot and re-applies it.
// Loading a character or opening a scene starts a new history.

const LIMIT = 100;

export class History {
  constructor({ $, status, motionPanel, retarget, keyPanel }) {
    Object.assign(this, { $, status, motionPanel, retarget, keyPanel });
    this.past = [];   // snapshots, last = current state
    this.future = [];
    this.restoring = false;
    this.timer = 0;

    // Record after every scheduled change (debounced so a drag or typing is one step).
    const schedule = motionPanel.schedule.bind(motionPanel);
    motionPanel.schedule = (...args) => {
      schedule(...args);
      if (!this.restoring) { clearTimeout(this.timer); this.timer = setTimeout(() => this.record(), 350); }
    };
    $('undo').addEventListener('click', () => this.undo());
    $('redo').addEventListener('click', () => this.redo());
    window.addEventListener('keydown', (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      // Text fields keep their own undo.
      if (e.target instanceof HTMLInputElement && e.target.type !== 'checkbox' && e.target.type !== 'range') return;
      if (e.target instanceof HTMLTextAreaElement) return;
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); this.undo(); }
      else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); this.redo(); }
    });
    this.sync();
  }

  snapshot() {
    const $ = this.$, mp = this.motionPanel;
    return JSON.stringify({
      layers: mp.layers.map(({ customMaskFrom, ...l }) => l),
      active: mp.active,
      length: mp.sceneLength,
      rig: mp.controlRig ?? null,
      rootScope: mp.rootScope,
      sceneRoot: mp.sceneRoot,
      retarget: { on: $('retarget-on').checked, align: $('align-rest').checked, mapping: this.retarget.mapping ?? null, pose: this.retarget.referencePose ?? null },
      foot: { on: $('foot-lock').checked, hips: $('hip-adjust').checked, h: $('foot-height').value, s: $('foot-speed').value, b: $('foot-blend').value },
      exportName: $('export-name').value,
    });
  }

  record() {
    if (this.restoring) return;
    const s = this.snapshot();
    if (this.past[this.past.length - 1] === s) return;
    this.past.push(s);
    if (this.past.length > LIMIT) this.past.shift();
    this.future = [];
    this.sync();
  }

  // Start a new history from the current state (character loaded, scene opened).
  reset() {
    clearTimeout(this.timer);
    this.past = [this.snapshot()];
    this.future = [];
    this.sync();
  }

  undo() {
    this.flushPending();
    if (this.past.length < 2) { this.status('Nothing to undo'); return; }
    this.future.push(this.past.pop());
    this.restore(this.past[this.past.length - 1]);
    this.status(`Undo (${this.past.length - 1} more)`);
  }

  redo() {
    this.flushPending();
    if (!this.future.length) { this.status('Nothing to redo'); return; }
    const s = this.future.pop();
    this.past.push(s);
    this.restore(s);
    this.status(`Redo (${this.future.length} more)`);
  }

  // A change scheduled but not yet recorded becomes its own step before undoing.
  flushPending() {
    if (this.timer) { clearTimeout(this.timer); this.timer = 0; this.record(); }
  }

  restore(json) {
    const $ = this.$, mp = this.motionPanel, s = JSON.parse(json);
    this.restoring = true;
    try {
      mp.layers = s.layers;
      mp.sceneLength = s.length ?? 0;
      mp.controlRig = s.rig ?? null;
      mp.rootScope = s.rootScope ?? 'clip';
      if (s.sceneRoot) mp.sceneRoot = s.sceneRoot;
      $('retarget-on').checked = s.retarget.on && !!this.retarget.character?.joints.length;
      $('align-rest').checked = s.retarget.align;
      this.retarget.mapping = s.retarget.mapping;
      this.retarget.referencePose = s.retarget.pose ?? null;
      this.retarget.syncPose();
      this.retarget.sync();
      this.retarget.renderEditor();
      $('foot-lock').checked = s.foot.on;
      $('hip-adjust').checked = s.foot.hips;
      $('foot-height').value = s.foot.h;
      $('foot-speed').value = s.foot.s;
      $('foot-blend').value = s.foot.b;
      $('foot-opts').hidden = !s.foot.on;
      $('export-name').value = s.exportName;
      mp.select(Math.min(s.active, mp.layers.length - 1));
      this.keyPanel?.sync();
      mp.schedule();
    } finally {
      this.restoring = false;
    }
    this.sync();
  }

  sync() {
    const undo = this.$('undo'), redo = this.$('redo');
    undo.disabled = this.past.length < 2;
    redo.disabled = !this.future.length;
    undo.title = `Undo (Ctrl+Z)${this.past.length > 1 ? ` · ${this.past.length - 1} step(s)` : ''}`;
    redo.title = `Redo (Ctrl+Y / Ctrl+Shift+Z)${this.future.length ? ` · ${this.future.length} step(s)` : ''}`;
  }
}
