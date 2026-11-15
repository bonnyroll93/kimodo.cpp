// Layer timeline: one row per layer (bar = clip duration on the stack's time axis), the
// active layer highlighted, and a playhead. Click a row label to make that layer active,
// click or drag on the tracks to seek.

export class Timeline {
  // callbacks: select(i), seek(seconds)
  constructor(container, callbacks) {
    this.container = container;
    this.cb = callbacks;
    this.duration = 0;
    this.rows = [];
    this.playhead = document.createElement('div');
    this.playhead.className = 'tl-playhead';
    let dragging = false;
    const seek = (e) => {
      const tracks = this.container.querySelector('.tl-tracks');
      if (!tracks || this.duration <= 0) return;
      const rect = tracks.getBoundingClientRect();
      const u = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
      this.cb.seek(u * this.duration);
    };
    container.addEventListener('pointerdown', (e) => {
      if (!e.target.closest('.tl-track')) return;
      dragging = true;
      container.setPointerCapture(e.pointerId);
      seek(e);
    });
    container.addEventListener('pointermove', (e) => { if (dragging) seek(e); });
    container.addEventListener('pointerup', () => { dragging = false; });
  }

  // layers: [{name, duration, enabled, muted}], duration: stack seconds, active: index,
  // contacts: optional foot contacts [{foot: 'left'|'right', start, end}] in seconds.
  set({ layers, duration, active, contacts = null }) {
    this.duration = duration;
    this.container.replaceChildren();
    this.container.hidden = !layers.length;
    const labels = document.createElement('div');
    labels.className = 'tl-labels';
    const tracks = document.createElement('div');
    tracks.className = 'tl-tracks';
    // Top row = top of the stack, like the layer list.
    [...layers.keys()].reverse().forEach((i) => {
      const l = layers[i];
      const state = `${i === active ? ' active' : ''}${l.enabled ? '' : ' disabled'}${l.muted ? ' muted' : ''}`;
      const label = document.createElement('button');
      label.type = 'button';
      label.className = `tl-label${state}`;
      label.textContent = `${i + 1}. ${l.name}${l.muted ? ' (muted)' : ''}${l.enabled ? '' : ' (off)'}`;
      label.title = 'Select layer';
      label.addEventListener('click', () => this.cb.select(i));
      const track = document.createElement('div');
      track.className = `tl-track${state}`;
      const bar = document.createElement('div');
      bar.className = 'tl-bar';
      bar.style.width = `${duration > 0 ? Math.min(100, (l.duration / duration) * 100) : 100}%`;
      track.append(bar);
      labels.append(label);
      tracks.append(track);
    });
    if (contacts) {
      for (const foot of ['left', 'right']) {
        const label = document.createElement('div');
        label.className = 'tl-label foot';
        label.textContent = `${foot === 'left' ? 'Left' : 'Right'} foot contacts`;
        const track = document.createElement('div');
        track.className = `tl-track foot ${foot}`;
        for (const c of contacts.filter((x) => x.foot === foot)) {
          const bar = document.createElement('div');
          bar.className = 'tl-contact';
          bar.style.left = `${duration > 0 ? (c.start / duration) * 100 : 0}%`;
          bar.style.width = `${duration > 0 ? Math.max(0.5, ((c.end - c.start) / duration) * 100) : 0}%`;
          bar.title = `${foot} foot pinned ${c.start.toFixed(2)}–${c.end.toFixed(2)} s`;
          track.append(bar);
        }
        labels.append(label);
        tracks.append(track);
      }
    }
    tracks.append(this.playhead);
    this.container.append(labels, tracks);
  }

  update(time) {
    const u = this.duration > 0 ? Math.min(1, Math.max(0, time / this.duration)) : 0;
    this.playhead.style.left = `${u * 100}%`;
  }
}
