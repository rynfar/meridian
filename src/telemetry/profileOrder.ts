/**
 * Profile ordering, shared by every page that renders the account list.
 *
 * The order itself already has a home: `PUT /settings/api/routing` persists
 * it as the `profileOrder` setting, and `resolvePriorityOrder()` in
 * src/proxy/routing.ts is what consumes it. This module owns the *display*
 * half — applying that saved order, computing the next order from a drag or
 * a keyboard move, and the drag gesture itself.
 *
 * The pure functions are the tested source of truth (profile-order.test.ts).
 * `reorderCss` / `reorderClientJs` are the single browser-side copy: the
 * pages are template literals that cannot import at runtime, so instead of
 * each pasting its own transcription they interpolate these, and there is
 * exactly one implementation of the gesture in the codebase.
 */

/**
 * Move the item at `from` to index `to`, returning a new array.
 *
 * Out-of-range indices (and a no-op move) return an unchanged copy rather
 * than throwing — the caller is a drag handler, and a drop outside the list
 * must not corrupt the order.
 */
export function moveInOrder<T>(order: readonly T[], from: number, to: number): T[] {
  const next = order.slice()
  if (from < 0 || from >= next.length) return next
  if (to < 0 || to >= next.length) return next
  if (from === to) return next
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved as T)
  return next
}

/**
 * Sort `items` by the id sequence in `order`.
 *
 * Ids in `order` come first, in that order. Anything not listed keeps its
 * original relative position at the end — a profile added since the order
 * was saved must still render, and it must render somewhere predictable.
 * This mirrors resolvePriorityOrder()'s "unlisted profiles appended in
 * config order" rule so every page and the router agree on what the order is.
 */
export function sortByOrder<T extends { id: string }>(items: readonly T[], order: readonly string[]): T[] {
  const rank = new Map<string, number>()
  for (let i = 0; i < order.length; i++) {
    if (!rank.has(order[i]!)) rank.set(order[i]!, i)
  }
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const ra = rank.get(a.item.id) ?? Number.MAX_SAFE_INTEGER
      const rb = rank.get(b.item.id) ?? Number.MAX_SAFE_INTEGER
      if (ra !== rb) return ra - rb
      return a.index - b.index
    })
    .map((entry) => entry.item)
}

/** Distance from a viewport edge at which a drag starts scrolling the page. */
export const EDGE_ZONE_PX = 96
/** Scroll step at the very edge, in px per animation frame (~60/s). */
export const MAX_SCROLL_PX_PER_FRAME = 20

/**
 * How far to scroll the page during a drag, given the pointer's viewport
 * position. Negative scrolls up, positive down, zero holds still.
 *
 * HTML5 drag-and-drop does not scroll the page for you once the list is
 * taller than the viewport, so a drag can only reach targets that were
 * already on screen. Ramping the speed with depth into the edge zone is
 * what makes both a nudge and a fast travel possible from one gesture.
 *
 * A pointer dragged past the edge reports a clientY outside the viewport;
 * that clamps to full speed rather than accelerating without bound. The
 * zone is capped at half the viewport so the two zones cannot overlap and
 * fight on a short window.
 */
export function edgeScrollVelocity(
  clientY: number,
  viewportHeight: number,
  edge: number = EDGE_ZONE_PX,
  maxSpeed: number = MAX_SCROLL_PX_PER_FRAME,
): number {
  if (!Number.isFinite(clientY) || !Number.isFinite(viewportHeight)) return 0
  if (viewportHeight <= 0) return 0
  const zone = Math.min(edge, viewportHeight / 2)
  if (zone <= 0) return 0
  if (clientY < zone) {
    return -Math.round(maxSpeed * Math.min(1, (zone - clientY) / zone))
  }
  const fromBottom = viewportHeight - clientY
  if (fromBottom < zone) {
    return Math.round(maxSpeed * Math.min(1, (zone - fromBottom) / zone))
  }
  return 0
}

/** Reorder affordances. Interpolated by every page that renders the list. */
export const reorderCss = `
  .profile-card.dragging { opacity: 0.45; border-color: var(--accent); }
  .profile-card.drop-target { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
  .drag-handle {
    background: none; border: 1px solid transparent; border-radius: 6px;
    color: var(--muted); cursor: grab; padding: 2px 6px; font-size: 15px;
    line-height: 1; user-select: none; flex-shrink: 0;
  }
  .drag-handle:hover { color: var(--accent); border-color: var(--border); }
  .drag-handle:focus-visible { outline: none; color: var(--accent); border-color: var(--accent); }
  .drag-handle:active { cursor: grabbing; }
  .order-index {
    font-family: 'SF Mono', SFMono-Regular, Consolas, monospace; font-size: 11px;
    color: var(--muted); min-width: 16px; text-align: right; flex-shrink: 0;
  }
  .order-note { font-size: 12px; color: var(--muted); margin-bottom: 12px; max-width: 620px; }
  .order-note code {
    font-family: 'SF Mono', SFMono-Regular, Consolas, monospace; font-size: 11px;
    background: var(--bg); padding: 1px 5px; border-radius: 4px; color: var(--accent2);
  }
  .order-note.locked { color: var(--yellow); }
  .sr-only {
    position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
    overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
  }
`

/** The live region the gesture announces moves into. Both pages embed it. */
export const reorderLiveRegionHtml = `<div id="orderStatus" class="sr-only" role="status" aria-live="polite"></div>`

/**
 * The browser half, as `window.meridianReorder`. Interpolated verbatim into
 * each page's inline script; see the module doc for why it is a string.
 *
 * Contract with the page: cards are `.profile-card[data-id]` inside
 * `#content`, rendered in the order `sortProfiles()` returned, and
 * `init({ onSaved })` is called once with a re-render callback.
 */
export const reorderClientJs = `
window.meridianReorder = (function () {
  function moveInOrder(order, from, to) {
    var next = order.slice();
    if (from < 0 || from >= next.length) return next;
    if (to < 0 || to >= next.length) return next;
    if (from === to) return next;
    var moved = next.splice(from, 1)[0];
    next.splice(to, 0, moved);
    return next;
  }

  function sortByOrder(items, order) {
    // Null-prototype: a profile called "constructor" or "toString" would
    // otherwise test true against Object.prototype and rank as position 0.
    var rank = Object.create(null);
    for (var i = 0; i < order.length; i++) {
      if (!(order[i] in rank)) rank[order[i]] = i;
    }
    return items
      .map(function (item, index) { return { item: item, index: index }; })
      .sort(function (a, b) {
        var ra = a.item.id in rank ? rank[a.item.id] : Number.MAX_SAFE_INTEGER;
        var rb = b.item.id in rank ? rank[b.item.id] : Number.MAX_SAFE_INTEGER;
        if (ra !== rb) return ra - rb;
        return a.index - b.index;
      })
      .map(function (entry) { return entry.item; });
  }

  // Escapes the attribute delimiter too. The profiles page's own esc() goes
  // through textContent, which leaves a double quote intact and would break
  // out of the aria-label this builds.
  function escAttr(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  var EDGE_ZONE_PX = ${EDGE_ZONE_PX};
  var MAX_SCROLL_PX_PER_FRAME = ${MAX_SCROLL_PX_PER_FRAME};

  // Mirrors edgeScrollVelocity in src/telemetry/profileOrder.ts, unit-tested
  // in profile-order.test.ts.
  function edgeScrollVelocity(clientY, viewportHeight) {
    if (!isFinite(clientY) || !isFinite(viewportHeight) || viewportHeight <= 0) return 0;
    var zone = Math.min(EDGE_ZONE_PX, viewportHeight / 2);
    if (zone <= 0) return 0;
    if (clientY < zone) return -Math.round(MAX_SCROLL_PX_PER_FRAME * Math.min(1, (zone - clientY) / zone));
    var fromBottom = viewportHeight - clientY;
    if (fromBottom < zone) return Math.round(MAX_SCROLL_PX_PER_FRAME * Math.min(1, (zone - fromBottom) / zone));
    return 0;
  }

  var velocity = 0;
  var frame = null;
  var pointerSeenAt = 0;
  // A drag that leaves the window stops producing dragover events while the
  // last velocity is still in force, which would scroll to the end on its
  // own. dragend covers the ordinary paths; this covers the rest.
  var POINTER_STALE_MS = 700;

  function step() {
    frame = null;
    if (velocity === 0) return;
    if (Date.now() - pointerSeenAt > POINTER_STALE_MS) { velocity = 0; return; }
    window.scrollBy(0, velocity);
    frame = window.requestAnimationFrame(step);
  }

  function trackPointer(e) {
    if (fromIndex === null) return;
    pointerSeenAt = Date.now();
    velocity = edgeScrollVelocity(e.clientY, window.innerHeight);
    if (velocity !== 0 && frame === null) frame = window.requestAnimationFrame(step);
  }

  function stopAutoScroll() {
    velocity = 0;
    if (frame !== null) { window.cancelAnimationFrame(frame); frame = null; }
  }

  var state = { order: [], envPinned: false };
  var fromIndex = null;
  var pendingFocusId = null;
  var onSaved = function () {};

  function adopt(cfg) {
    if (!cfg) return;
    if (Array.isArray(cfg.profileOrder)) state.order = cfg.profileOrder;
    state.envPinned = !!(cfg.envOverride && cfg.envOverride.profileOrder);
  }

  function sortProfiles(items) { return sortByOrder(items || [], state.order || []); }

  function announce(message) {
    var live = document.getElementById('orderStatus');
    if (live) live.textContent = message;
  }

  function noteHtml(reorderable) {
    return reorderable
      ? '<div class="order-note">Drag a card by its handle to reorder, or focus a handle and press \\u2191 / \\u2193. '
        + 'The order is saved, and drives <a href="/settings" style="color:var(--accent)">Priority routing</a> \\u2014 the pool drains from the top.</div>'
      : '<div class="order-note locked">Order is pinned by the <code>MERIDIAN_PROFILE_ORDER</code> environment variable. Unset it to reorder from here.</div>';
  }

  function handleHtml(id, index, total) {
    return '<span class="order-index">' + (index + 1) + '</span>'
      + '<button type="button" class="drag-handle" draggable="true" data-index="' + index + '"'
      + ' title="Drag to reorder, or press \\u2191 / \\u2193"'
      + ' aria-label="Reorder ' + escAttr(id) + ', position ' + (index + 1) + ' of ' + total
      + '. Press arrow up or arrow down to move.">\\u283f</button>';
  }

  // The rendered order is the truth the server must agree with — read it back
  // off the DOM rather than from the cached config, which may list ids the
  // current /profiles/list no longer has (PUT rejects unknown ids outright).
  function currentOrderIds() {
    var ids = [];
    var cards = document.querySelectorAll('.profile-card[data-id]');
    for (var i = 0; i < cards.length; i++) ids.push(cards[i].dataset.id);
    return ids;
  }

  function clearMarks() {
    var marked = document.querySelectorAll('.profile-card.dragging, .profile-card.drop-target');
    for (var i = 0; i < marked.length; i++) marked[i].classList.remove('dragging', 'drop-target');
  }

  function save(order, message) {
    var previous = state.order;
    state.order = order;
    return fetch('/settings/api/routing', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileOrder: order })
    }).catch(function () { return null; }).then(function (res) {
      if (!res || !res.ok) {
        state.order = previous;
        announce('Could not save the new order.');
      } else if (message) {
        announce(message);
      }
      return onSaved();
    });
  }

  function moveTo(from, to) {
    var order = currentOrderIds();
    if (to < 0 || to >= order.length || from === to) return;
    save(moveInOrder(order, from, to), order[from] + ' moved to position ' + (to + 1) + ' of ' + order.length + '.');
  }

  function init(opts) {
    if (opts && opts.onSaved) onSaved = opts.onSaved;
    var content = document.getElementById('content');

    content.addEventListener('dragstart', function (e) {
      var handle = e.target.closest && e.target.closest('.drag-handle');
      if (!handle) return;
      var card = handle.closest('.profile-card');
      fromIndex = Number(handle.dataset.index);
      pointerSeenAt = Date.now();
      e.dataTransfer.effectAllowed = 'move';
      // Firefox will not start a drag at all unless the payload is set.
      e.dataTransfer.setData('text/plain', card.dataset.id || '');
      if (e.dataTransfer.setDragImage) e.dataTransfer.setDragImage(card, 24, 24);
      card.classList.add('dragging');
    });

    content.addEventListener('dragover', function (e) {
      if (fromIndex === null) return;
      var card = e.target.closest && e.target.closest('.profile-card');
      if (!card) return;
      // preventDefault is what makes an element a drop target at all.
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      var marked = document.querySelectorAll('.profile-card.drop-target');
      for (var i = 0; i < marked.length; i++) marked[i].classList.remove('drop-target');
      if (Number(card.dataset.index) !== fromIndex) card.classList.add('drop-target');
    });

    content.addEventListener('drop', function (e) {
      if (fromIndex === null) return;
      var card = e.target.closest && e.target.closest('.profile-card');
      if (!card) return;
      e.preventDefault();
      var from = fromIndex;
      var to = Number(card.dataset.index);
      fromIndex = null;
      stopAutoScroll();
      clearMarks();
      moveTo(from, to);
    });

    content.addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      var handle = e.target.closest && e.target.closest('.drag-handle');
      if (!handle) return;
      e.preventDefault();
      var order = currentOrderIds();
      var from = Number(handle.dataset.index);
      var to = e.key === 'ArrowUp' ? from - 1 : from + 1;
      if (to < 0 || to >= order.length) return;
      pendingFocusId = order[from];
      moveTo(from, to);
    });

    // The page scrolls only while the pointer sits near a viewport edge, and
    // the pointer is over the header or the gap between cards as often as it
    // is over one — so this listens on the document, not on #content.
    document.addEventListener('dragover', trackPointer);
    document.addEventListener('dragend', function () {
      fromIndex = null;
      stopAutoScroll();
      clearMarks();
    });
    document.addEventListener('drop', stopAutoScroll);
  }

  // A poll landing mid-drag would replace the very cards being dragged.
  function dragging() { return fromIndex !== null; }

  // A re-render replaces the focused handle; without this the keyboard path
  // loses focus mid-reorder and the next arrow key goes nowhere.
  function focusAnchor() {
    var pending = pendingFocusId;
    pendingFocusId = null;
    if (pending) return pending;
    var active = document.activeElement;
    if (!active || !active.closest || !active.closest('.drag-handle')) return null;
    var card = active.closest('.profile-card');
    return card ? card.dataset.id : null;
  }

  function restoreFocus(id) {
    if (!id) return;
    var cards = document.querySelectorAll('.profile-card[data-id]');
    for (var i = 0; i < cards.length; i++) {
      if (cards[i].dataset.id !== id) continue;
      var handle = cards[i].querySelector('.drag-handle');
      if (handle) handle.focus();
      return;
    }
  }

  return {
    adopt: adopt,
    sortProfiles: sortProfiles,
    envPinned: function () { return state.envPinned; },
    noteHtml: noteHtml,
    handleHtml: handleHtml,
    init: init,
    dragging: dragging,
    focusAnchor: focusAnchor,
    restoreFocus: restoreFocus,
    announce: announce
  };
})();
`
