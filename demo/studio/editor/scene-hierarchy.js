// Collapsible joint tree with filtering; the single source of selection events from the panel.
export class SceneHierarchy {
  constructor(container, filterInput, onSelect) {
    this.container = container;
    this.onSelect = onSelect;
    this.items = [];
    filterInput.addEventListener('input', () => this.filter(filterInput.value));
    this.filterInput = filterInput;
  }

  setCharacter(character) {
    this.container.replaceChildren();
    this.items = [];
    this.filterInput.value = '';
    if (!character || !character.joints.length) {
      const p = document.createElement('p');
      p.className = 'muted pad';
      p.textContent = character ? 'This file has no skinned skeleton.' : 'No character loaded.';
      this.container.append(p);
      return;
    }
    const { joints } = character;
    const build = (index) => {
      const j = joints[index];
      const li = document.createElement('li');
      li.setAttribute('role', 'treeitem');
      const row = document.createElement('div');
      row.className = 'node' + (j.deforming ? '' : ' nondeforming');
      row.title = j.deforming ? j.name : `${j.name} (no skin influence)`;
      const twisty = document.createElement('span');
      twisty.className = 'twisty';
      twisty.textContent = j.children.length ? '▾' : '';
      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = j.name;
      row.append(twisty, label);
      li.append(row);
      twisty.addEventListener('click', (e) => {
        e.stopPropagation();
        li.classList.toggle('collapsed');
        twisty.textContent = li.classList.contains('collapsed') ? '▸' : '▾';
      });
      row.addEventListener('click', () => this.onSelect(index));
      this.items[index] = { li, row, name: j.name.toLowerCase() };
      if (j.children.length) {
        const ul = document.createElement('ul');
        ul.setAttribute('role', 'group');
        for (const c of j.children) ul.append(build(c));
        li.append(ul);
      }
      return li;
    };
    const ul = document.createElement('ul');
    for (const r of character.roots) ul.append(build(r));
    this.container.append(ul);
  }

  select(index) {
    for (const it of this.items) it?.row.classList.remove('selected');
    const it = this.items[index];
    if (!it) return;
    // Expand ancestors so the selection is visible.
    for (let el = it.li.parentElement; el && el !== this.container; el = el.parentElement)
      if (el.classList.contains('collapsed')) {
        el.classList.remove('collapsed');
        const tw = el.querySelector(':scope > .node > .twisty');
        if (tw) tw.textContent = '▾';
      }
    it.row.classList.add('selected');
    it.row.scrollIntoView({ block: 'nearest' });
  }

  filter(text) {
    const q = text.trim().toLowerCase();
    // A joint stays visible if it or any descendant matches.
    const visit = (li) => {
      const index = this.items.findIndex((it) => it?.li === li);
      let match = !q || this.items[index].name.includes(q);
      const ul = li.querySelector(':scope > ul');
      if (ul) for (const child of ul.children) match = visit(child) || match;
      li.classList.toggle('hidden-by-filter', !match);
      return match;
    };
    const top = this.container.querySelector(':scope > ul');
    if (top) for (const li of top.children) visit(li);
  }
}
