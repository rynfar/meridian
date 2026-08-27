/**
 * What a profile card states about an account, in one place.
 *
 * Two surfaces render the same list — the detail grid on /profiles and the
 * hover overlay on the landing page — so the list lives here instead of being
 * written twice and drifting apart the first time a row is added.
 *
 * Emitted as browser source rather than a TypeScript function because the
 * pages are string templates concatenated at import time, the same arrangement
 * `profileBarJs` uses. The unit tests evaluate this exact text, so what they
 * assert is what the browser runs.
 *
 * Values are plain text; escaping is the page's job, since only the page knows
 * whether it is filling a grid cell or an overlay row.
 */
export const profileFactsJs = `
function timeAgo(ts) {
  if (!ts) return '\u2014';
  var s = Math.floor((Date.now() - ts) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return new Date(ts).toLocaleString();
}

function profileFacts(p) {
  var facts = [];
  facts.push({
    label: 'Status',
    value: p.loggedIn ? '\u2713 Authenticated' : '\u2717 Not logged in',
    tone: p.loggedIn ? 'ok' : 'err'
  });
  if (p.email) facts.push({ label: 'Email', value: p.email, tone: '' });
  if (p.organizationName) facts.push({ label: 'Organization', value: p.organizationName, tone: '' });
  if (p.subscriptionType) facts.push({ label: 'Plan', value: p.subscriptionType, tone: '' });
  if (p.lastSuccessAt) facts.push({ label: 'Last Verified', value: timeAgo(p.lastSuccessAt), tone: 'ok' });
  if (p.lastCheckedAt && p.lastCheckedAt !== p.lastSuccessAt) {
    facts.push({ label: 'Last Checked', value: timeAgo(p.lastCheckedAt), tone: '' });
  }
  return facts;
}
`
