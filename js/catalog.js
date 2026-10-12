// Saved-rule catalogue persisted in localStorage, with JSON import / export.

const KEY = 'cellular3d.catalog.v1';

function read() {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function write(list) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
    return true;
  } catch (e) {
    console.warn('catalog: save failed', e);
    return false;
  }
}

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

export const Catalog = {
  list() {
    return read().sort((a, b) => b.created - a.created);
  },
  add(entry) {
    const list = read();
    const item = { id: uid(), created: Date.now(), ...entry };
    list.push(item);
    if (!write(list)) {
      // Storage is full: retry without the thumbnail so the rule itself survives.
      list[list.length - 1] = { ...item, thumb: null };
      if (!write(list)) throw new Error('Хранилище браузера переполнено');
    }
    return item;
  },
  update(id, patch) {
    const list = read();
    const i = list.findIndex((e) => e.id === id);
    if (i < 0) return;
    list[i] = { ...list[i], ...patch };
    write(list);
  },
  remove(id) {
    write(read().filter((e) => e.id !== id));
  },
  exportJSON() {
    return JSON.stringify({ format: 'cellular3d-catalog', version: 1, items: read() }, null, 2);
  },
  importJSON(text) {
    const data = JSON.parse(text);
    const items = Array.isArray(data) ? data : data.items;
    if (!Array.isArray(items)) throw new Error('Неверный формат файла');
    const list = read();
    const known = new Set(list.map((e) => e.id));
    let added = 0;
    for (const it of items) {
      if (!it || typeof it.rule !== 'string') continue;
      const item = { ...it, id: it.id && !known.has(it.id) ? it.id : uid(), created: it.created || Date.now() };
      known.add(item.id);
      list.push(item);
      added++;
    }
    if (!write(list)) throw new Error('Хранилище браузера переполнено');
    return added;
  },
};
