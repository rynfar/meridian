/**
 * The in-page dialog and toast every Meridian page uses instead of the
 * browser's alert, confirm and prompt boxes, which block the page, cannot be
 * styled, and printed `[object Object]` when handed an error object.
 *
 * Carried by the shared header (profileBar.ts), so every page that embeds
 * `profileBarCss`/`profileBarJs` has `window.meridianDialog`:
 *
 * - `show({title, message, facts, note, link, actions, cancelValue, tone})`
 *   resolves with the chosen action's `value`, or `cancelValue` on Escape,
 *   a click outside, or Close.
 * - `tell(title, message, extra)` one OK button.
 * - `ask({title, message, confirmText, cancelText, danger})` resolves true/false.
 * - `fail(title, reply, fallback)` reads an error reply with `dialogErrorText`.
 * - `toast(text, tone)` a short note in the corner that fades by itself.
 *
 * Text is set with textContent, never as HTML. Dialogs queue: a second one
 * opens when the first closes.
 */

/**
 * Readable text for an error reply: its message plus its code, whichever
 * envelope the route speaks (`{error: "…", code}` or Anthropic's
 * `{error: {type, message}}`), else `fallback`. Serialized into the page.
 */
export function dialogErrorText(reply: unknown, fallback: string): string {
  if (typeof reply === "string") return reply || fallback
  if (!reply || typeof reply !== "object") return fallback
  const body = reply as { error?: unknown; code?: unknown; message?: unknown }
  let code = typeof body.code === "string" ? body.code : ""
  let message = ""
  if (typeof body.error === "string") {
    message = body.error
  } else if (body.error && typeof body.error === "object") {
    const inner = body.error as { message?: unknown; type?: unknown }
    if (typeof inner.message === "string") message = inner.message
    if (!code && typeof inner.type === "string") code = inner.type
  } else if (typeof body.message === "string") {
    message = body.message
  }
  if (!message) return fallback
  return code && message.indexOf(code) < 0 ? message + " (" + code + ")" : message
}

export const dialogCss = `
  .mdlg-backdrop {
    position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center; justify-content: center;
    padding: 16px; background: rgba(1,4,9,0.62);
  }
  .mdlg {
    width: min(480px, 100%); max-height: calc(100vh - 32px); overflow: auto;
    background: var(--surface); color: var(--text); border: 1px solid var(--border); border-radius: 12px;
    padding: 20px; box-shadow: 0 16px 48px rgba(1,4,9,0.6); font-size: 13px; line-height: 1.55;
  }
  .mdlg.tone-error { border-color: rgba(var(--red-rgb),0.55); }
  .mdlg.tone-warn { border-color: rgba(var(--yellow-rgb),0.55); }
  .mdlg-title { font-size: 16px; font-weight: 600; margin: 0 0 10px; overflow-wrap: anywhere; }
  .mdlg-msg { margin: 0 0 8px; white-space: pre-line; overflow-wrap: anywhere; }
  .mdlg-facts { margin: 10px 0; display: grid; grid-template-columns: max-content 1fr; gap: 4px 12px; }
  .mdlg-facts dt { color: var(--muted); font-size: 12px; }
  .mdlg-facts dd { margin: 0; overflow-wrap: anywhere; }
  .mdlg-note { margin: 10px 0 0; color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
  .mdlg-link { color: var(--accent); }
  .mdlg-actions { margin-top: 16px; display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
  .mdlg-btn {
    background: var(--surface2); color: var(--text); border: 1px solid var(--border); border-radius: 6px;
    padding: 6px 14px; font: inherit; font-size: 13px; cursor: pointer; min-height: 32px;
  }
  .mdlg-btn:hover, .mdlg-btn:focus-visible { border-color: var(--accent); color: var(--accent); outline: none; }
  .mdlg-btn.primary { color: var(--accent); border-color: var(--accent); }
  .mdlg-btn.primary:hover { background: rgba(88,166,255,0.12); }
  .mdlg-btn.danger { color: var(--red); border-color: rgba(var(--red-rgb),0.5); }
  .mdlg-btn.danger:hover, .mdlg-btn.danger:focus-visible { background: var(--red); color: var(--bg); border-color: var(--red); }
  .mdlg-toasts {
    position: fixed; right: 16px; bottom: 16px; z-index: 1001; display: flex; flex-direction: column; gap: 8px;
    max-width: min(360px, calc(100vw - 32px)); pointer-events: none;
  }
  .mdlg-toast {
    background: var(--surface2); color: var(--text); border: 1px solid var(--border); border-left: 3px solid var(--accent);
    border-radius: 8px; padding: 8px 12px; font-size: 13px; overflow-wrap: anywhere; transition: opacity 0.3s;
  }
  .mdlg-toast.tone-error { border-left-color: var(--red); }
  .mdlg-toast.tone-ok { border-left-color: var(--green); }
  .mdlg-toast.fading { opacity: 0; }
  @media (max-width: 640px) {
    .mdlg-btn { min-height: 40px; flex: 1 1 auto; }
  }
`

export const dialogJs = `
var meridianDialog = (function () {
  var errorText = ${dialogErrorText.toString()};
  var chain = Promise.resolve();

  function node(tag, cls, text) {
    var el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = String(text);
    return el;
  }

  function render(opts) {
    return new Promise(function (resolve) {
      var previous = document.activeElement;
      var backdrop = node('div', 'mdlg-backdrop');
      var box = node('div', 'mdlg' + (opts.tone ? ' tone-' + opts.tone : ''));
      box.setAttribute('role', opts.tone === 'error' || opts.tone === 'warn' ? 'alertdialog' : 'dialog');
      box.setAttribute('aria-modal', 'true');
      var titleId = 'mdlg-title-' + Date.now();
      box.setAttribute('aria-labelledby', titleId);
      var title = node('h2', 'mdlg-title', opts.title || 'Meridian');
      title.id = titleId;
      box.appendChild(title);
      var messages = Array.isArray(opts.message) ? opts.message : (opts.message ? [opts.message] : []);
      messages.forEach(function (m) { if (m) box.appendChild(node('p', 'mdlg-msg', m)); });
      if (Array.isArray(opts.facts) && opts.facts.length) {
        var dl = node('dl', 'mdlg-facts');
        opts.facts.forEach(function (f) { dl.appendChild(node('dt', '', f[0])); dl.appendChild(node('dd', '', f[1])); });
        box.appendChild(dl);
      }
      if (opts.note) box.appendChild(node('p', 'mdlg-note', opts.note));
      if (opts.link && opts.link.href) {
        var p = node('p', 'mdlg-note');
        var a = node('a', 'mdlg-link', opts.link.text || opts.link.href);
        a.href = opts.link.href;
        p.appendChild(a);
        box.appendChild(p);
      }
      var row = node('div', 'mdlg-actions');
      var actions = Array.isArray(opts.actions) && opts.actions.length ? opts.actions : [{ label: 'OK', value: true, kind: 'primary' }];
      var buttons = actions.map(function (action) {
        var b = node('button', 'mdlg-btn' + (action.kind ? ' ' + action.kind : ''), action.label);
        b.type = 'button';
        b.addEventListener('click', function () { close(action.value); });
        row.appendChild(b);
        return b;
      });
      box.appendChild(row);
      backdrop.appendChild(box);
      var done = false;
      function close(value) {
        if (done) return;
        done = true;
        document.removeEventListener('keydown', onKey, true);
        backdrop.remove();
        if (previous && previous.isConnected && typeof previous.focus === 'function') previous.focus();
        resolve(value);
      }
      function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(opts.cancelValue); return; }
        if (e.key !== 'Tab') return;
        var focusable = Array.prototype.slice.call(box.querySelectorAll('button, a[href]'));
        if (!focusable.length) return;
        var first = focusable[0], last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        else if (!box.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
      }
      backdrop.addEventListener('mousedown', function (e) { if (e.target === backdrop) close(opts.cancelValue); });
      document.addEventListener('keydown', onKey, true);
      document.body.appendChild(backdrop);
      var focusIndex = typeof opts.focus === 'number' ? opts.focus : buttons.length - 1;
      (buttons[focusIndex] || buttons[0]).focus();
    });
  }

  function show(opts) {
    var next = chain.then(function () { return render(opts || {}); });
    chain = next.then(function () {}, function () {});
    return next;
  }
  function tell(title, message, extra) {
    return show(Object.assign({ title: title, message: message, actions: [{ label: 'OK', value: true, kind: 'primary' }], cancelValue: true }, extra || {}));
  }
  function ask(opts) {
    return show({
      title: opts.title, message: opts.message, facts: opts.facts, note: opts.note, tone: opts.danger ? 'warn' : undefined,
      actions: [
        { label: opts.cancelText || 'Cancel', value: false },
        { label: opts.confirmText || 'Continue', value: true, kind: opts.danger ? 'danger' : 'primary' }
      ],
      cancelValue: false,
      focus: 0
    });
  }
  function fail(title, reply, fallback) {
    return tell(title, errorText(reply, fallback || 'Something went wrong.'), { tone: 'error' });
  }
  var toasts = null;
  function toast(text, tone) {
    if (!toasts || !toasts.isConnected) {
      toasts = node('div', 'mdlg-toasts');
      toasts.setAttribute('role', 'status');
      toasts.setAttribute('aria-live', 'polite');
      document.body.appendChild(toasts);
    }
    var t = node('div', 'mdlg-toast' + (tone ? ' tone-' + tone : ''), text);
    toasts.appendChild(t);
    setTimeout(function () { t.classList.add('fading'); setTimeout(function () { t.remove(); }, 400); }, 4000);
  }
  return { show: show, tell: tell, ask: ask, fail: fail, toast: toast, errorText: errorText };
})();
`
