import { themeCss, profileBarCss, profileBarHtml, profileBarJs } from './profileBar'
import { providerViewCss } from './providerView'

export const providerPageHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Providers · Meridian</title><style>${themeCss}${profileBarCss}${providerViewCss}
*{box-sizing:border-box}body{margin:0;color:var(--text);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}.container{max-width:1040px;padding:36px 24px;margin:auto}h1{font-size:28px;font-weight:600;margin:0}h1+p{color:var(--muted);font-size:14px;margin:10px 0 24px}#provider-error{color:var(--yellow);font-size:13px}button:focus-visible,a:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:4px}
</style></head><body>${profileBarHtml}<main class="container"><h1>Providers</h1><p>One view of your subscriptions. Separate accounts, models and allowances.</p><p id="provider-error" role="status"></p><div id="provider-content" aria-live="polite">Loading provider usage…</div></main><script>
var selected = ['claude','antigravity'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'all';
var loading = false;
async function loadProviders() {
  if (loading) return; loading = true;
  try {
    var response = await fetch('/providers/view?provider=' + selected);
    if (!response.ok) throw new Error(response.status === 401 ? 'Authentication required to view provider usage.' : 'Provider data is unavailable. Retrying shortly.');
    var html = await response.text();
    var target = document.getElementById('provider-content');
    if (target.innerHTML !== html && !target.contains(document.activeElement)) target.innerHTML = html;
    document.getElementById('provider-error').textContent = '';
  } catch(error) { document.getElementById('provider-error').textContent = error.message; }
  finally { loading = false; }
}
document.getElementById('provider-content').addEventListener('click', function(event) {
  var button = event.target.closest('[data-provider]');
  if (!button || loading) return;
  selected = button.dataset.provider; location.hash = selected;
  document.getElementById('provider-content').focus(); button.blur(); loadProviders();
});
loadProviders();setInterval(loadProviders,10000);
${profileBarJs}
</script></body></html>`
