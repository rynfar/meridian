import { profileTableMarkupJs } from "./profileTableMarkup"

export { profileTableCss } from "./profileTableCss"

type Page = "home" | "profiles"

const catalog = [
  ["name", "Name"], ["provider", "Provider"], ["active", "Active"], ["login", "Login"],
  ["fiveHour", "5-hour"], ["weekly", "Weekly"], ["extra", "Extra usage"],
  ["spent", "Spent"], ["routing", "Routing"], ["cost", "Est. API value"], ["credits", "Credits"],
  ["fullReset", "Full reset"], ["fableReset", "Fable reset"], ["otherReset", "Other reset"],
  ["chatgptReset", "ChatGPT resets"],
] as const

const profilesHidden = ["credits", "chatgptReset"]
const columnsByPage = {
  home: catalog,
  profiles: catalog.filter(([id]) => id !== "cost"),
} as const
const presets = {
  home: ["name", "provider", "active", "login", "fiveHour", "weekly"],
  profiles: columnsByPage.profiles.map(([id]) => id).filter(id => !profilesHidden.includes(id)),
} as const

export function profileTableJs(page: Page): string {
  return `
var meridianProfileTable = (function () {
  const columns = new Map(${JSON.stringify(columnsByPage[page])});
  const ids = Array.from(columns.keys());
  const preset = ${JSON.stringify(presets[page])};
  const storageKey = ${JSON.stringify(`meridian.profileTable.${page}`)};
  let configOpen = false;
  let addSort = false;
  let announcement = '';
  let dragged = null;
  let preferences = readPreferences();

  function defaults() {
    return { view: 'tiles', order: ids, hidden: ids.filter(id => !preset.includes(id)), sort: [] };
  }

  function knownIds(value) {
    return Array.isArray(value) ? Array.from(new Set(value.filter(id => columns.has(id)))) : [];
  }

  function readPreferences() {
    const fallback = defaults();
    let saved;
    try {
      saved = JSON.parse(localStorage.getItem(storageKey));
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof DOMException) return fallback;
      throw error;
    }
    if (!saved || typeof saved !== 'object') return fallback;
    const storedOrder = knownIds(saved.order);
    const added = ids.filter(id => !storedOrder.includes(id));
    const hidden = Array.isArray(saved.hidden) ? Array.from(new Set([
      ...knownIds(saved.hidden), ...added.filter(id => fallback.hidden.includes(id)),
    ])) : fallback.hidden;
    const sort = new Map();
    if (Array.isArray(saved.sort)) for (const key of saved.sort) {
      if (key && columns.has(key.id) && !hidden.includes(key.id) && !sort.has(key.id) &&
          (key.direction === 'asc' || key.direction === 'desc')) sort.set(key.id, { id: key.id, direction: key.direction });
    }
    return { view: saved.view === 'table' ? 'table' : 'tiles', order: storedOrder.concat(added), hidden, sort: Array.from(sort.values()) };
  }

  function savePreferences() {
    try { localStorage.setItem(storageKey, JSON.stringify(preferences)); }
    catch (error) { if (!(error instanceof DOMException)) throw error; }
  }

  function isTable() { return preferences.view === 'table'; }

  const collator = new Intl.Collator(undefined, { sensitivity: 'base' });
  function compareRows(a, b) {
    for (const { id, direction } of preferences.sort) {
      const left = sortValue(a.cells[id]?.value);
      const right = sortValue(b.cells[id]?.value);
      if (left == null && right == null) continue;
      if (left == null) return 1;
      if (right == null) return -1;
      const comparison = typeof left === 'number' && typeof right === 'number' ? left - right :
        typeof left !== typeof right ? (typeof left === 'number' ? -1 : 1) : collator.compare(left, right);
      if (comparison) return direction === 'asc' ? comparison : -comparison;
    }
    return 0;
  }

  function sortValue(value) {
    return typeof value === 'number' && !Number.isFinite(value) ? null : value;
  }

  function toggleSort(id, append) {
    const current = preferences.sort;
    const existing = current.find(key => key.id === id);
    const direction = existing?.direction === 'asc' ? 'desc' : 'asc';
    const next = { id, direction };
    preferences.sort = append ? (existing ? current.map(key => key.id === id ? next : key) : [...current, next]) : [next];
  }

  function moveColumn(id, destination) {
    const from = preferences.order.indexOf(id);
    if (from < 0 || from === destination || destination < 0 || destination >= preferences.order.length) return false;
    const order = moveItem(preferences.order, from, destination);
    preferences.order = order;
    announcement = columns.get(id) + ' moved to position ' + (destination + 1) + ' of ' + order.length + '.';
    return true;
  }

  function moveItem(list, from, to) {
    const next = list.slice();
    next.splice(to, 0, next.splice(from, 1)[0]);
    return next;
  }

  ${profileTableMarkupJs}

  function init(root, redraw) {
    const doc = root.ownerDocument || root;
    const controlSelector = '[data-profile-table-control]';
    const columnSelector = '[data-profile-table-option]';
    let dropTarget = null;

    function focusControl(key) {
      if (!key) return false;
      const control = root.querySelector('button[data-profile-table-control="' + key + '"]');
      if (!control || control.disabled) return false;
      if (doc.activeElement !== control) control.focus({ preventScroll: true });
      return true;
    }

    function update(focus, fallback) {
      const prior = doc.activeElement?.getAttribute('data-profile-table-control');
      redraw();
      if (!focusControl(focus || prior)) focusControl(fallback);
    }

    root.addEventListener('click', event => {
      const button = event.target.closest?.('button' + controlSelector);
      if (!button || button.disabled) return;
      const [command, id] = button.getAttribute('data-profile-table-control').split(':');
      if (id && !columns.has(id)) return;
      let fallback;
      let persist = true;
      switch (command) {
        case 'tiles':
        case 'table':
          if (preferences.view === command) return;
          preferences.view = command;
          configOpen = false;
          addSort = false;
          break;
        case 'columns':
          configOpen = !configOpen;
          persist = false;
          break;
        case 'add-sort':
          addSort = !addSort;
          persist = false;
          break;
        case 'clear-sort':
          preferences.sort = [];
          addSort = false;
          fallback = 'columns';
          break;
        case 'reset':
          preferences = { ...defaults(), view: preferences.view };
          announcement = 'Table preferences reset.';
          addSort = false;
          break;
        case 'hide':
          if (preferences.hidden.includes(id)) preferences.hidden = preferences.hidden.filter(column => column !== id);
          else {
            preferences.hidden = [...preferences.hidden, id];
            preferences.sort = preferences.sort.filter(key => key.id !== id);
            if (!preferences.sort.length) addSort = false;
          }
          break;
        case 'up':
        case 'down': {
          const offset = command === 'up' ? -1 : 1;
          if (!moveColumn(id, preferences.order.indexOf(id) + offset)) return;
          fallback = (command === 'up' ? 'down:' : 'up:') + id;
          break;
        }
        case 'sort':
          toggleSort(id, event.shiftKey || addSort);
          addSort = false;
          break;
        case 'sort-direction':
          toggleSort(id, true);
          break;
        case 'sort-earlier':
        case 'sort-later': {
          const from = preferences.sort.findIndex(key => key.id === id);
          const earlier = command === 'sort-earlier';
          const to = from + (earlier ? -1 : 1);
          if (from < 0 || to < 0 || to >= preferences.sort.length) return;
          preferences.sort = moveItem(preferences.sort, from, to);
          fallback = (earlier ? 'sort-later:' : 'sort-earlier:') + id;
          break;
        }
        case 'sort-remove': {
          const from = preferences.sort.findIndex(key => key.id === id);
          preferences.sort = preferences.sort.filter(key => key.id !== id);
          const next = preferences.sort[from] ?? preferences.sort.at(-1);
          if (!next) addSort = false;
          fallback = next ? 'sort-remove:' + next.id : 'columns';
          break;
        }
        default:
          return;
      }
      if (persist) savePreferences();
      update(null, fallback);
    });

    root.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || !configOpen || !event.target.closest?.('.profile-table-config, [data-profile-table-control="columns"]')) return;
      event.preventDefault();
      configOpen = false;
      update('columns');
    });

    function markDropTarget(target) {
      if (target === dropTarget) return;
      dropTarget?.removeAttribute('data-drop-target');
      target?.setAttribute('data-drop-target', '');
      dropTarget = target;
    }

    root.addEventListener('dragstart', event => {
      const id = event.target.closest?.('[data-profile-table-grip]')?.getAttribute('data-profile-table-grip');
      if (!columns.has(id) || !event.dataTransfer) return;
      dragged = id;
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', columns.get(id));
    });

    root.addEventListener('dragover', event => {
      if (!dragged) return;
      const target = event.target.closest?.(columnSelector);
      const destination = target?.getAttribute('data-profile-table-option');
      markDropTarget(destination && destination !== dragged ? target : null);
      if (!dropTarget || !event.dataTransfer) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
    });

    root.addEventListener('dragleave', event => {
      if (dropTarget && !dropTarget.contains(event.relatedTarget)) markDropTarget(null);
    });

    root.addEventListener('drop', event => {
      if (!dragged) return;
      const target = event.target.closest?.(columnSelector);
      const destination = preferences.order.indexOf(target?.getAttribute('data-profile-table-option'));
      const moved = moveColumn(dragged, destination);
      dragged = null;
      markDropTarget(null);
      if (!moved) return;
      event.preventDefault();
      savePreferences();
      update();
    });

    root.addEventListener('dragend', () => {
      dragged = null;
      markDropTarget(null);
    });
  }

  return { toolbarHtml, isTable, tableHtml, init, dragging: () => dragged !== null };
})();
`
}
