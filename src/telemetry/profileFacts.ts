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
  if (!ts) return '\\u2014';
  var s = Math.floor((Date.now() - ts) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return new Date(ts).toLocaleString();
}

// "22d 4h", "5h 12m", "42m": the two largest units of a span.
function spanText(ms) {
  var mins = Math.floor(Math.abs(ms) / 60000);
  var d = Math.floor(mins / 1440);
  mins -= d * 1440;
  var h = Math.floor(mins / 60);
  var m = mins - h * 60;
  if (d > 0) return d + 'd ' + h + 'h';
  if (h > 0) return h + 'h ' + m + 'm';
  return m + 'm';
}

// The login's lifetime, right under Status: when it has to be renewed is the
// one fact here that someone has to act on before it happens. Past the
// deadline nothing can renew it, and it keeps working only until the current
// access token runs out.
function loginFacts(p, now) {
  var facts = [];
  if (p.firstUnauthedAt) {
    var why = p.unauthedReason === 'refresh_rejected' ? ' \\u2014 Anthropic refused to renew the login'
      : p.unauthedReason === 'credentials_cleared' ? ' \\u2014 the stored login was wiped' : '';
    facts.push({ label: 'Logged out', value: spanText(now - p.firstUnauthedAt) + ' ago', tone: 'err',
      title: 'Since ' + new Date(p.firstUnauthedAt).toLocaleString() + why });
  } else if (p.refreshTokenExpiresAt) {
    var left = p.refreshTokenExpiresAt - now;
    var deadline = new Date(p.refreshTokenExpiresAt).toLocaleString();
    var renewed = p.lastRefreshAt ? ' Token last renewed ' + timeAgo(p.lastRefreshAt) + '.' : '';
    if (left > 0) {
      facts.push({ label: 'Login expires', value: 'in ' + spanText(left), tone: p.renewalRequiredSoon ? 'warn' : '',
        title: deadline + '. Log in again before then.' + renewed });
    } else {
      var stops = p.accessTokenExpiresAt && p.accessTokenExpiresAt > now
        ? 'stops in ' + spanText(p.accessTokenExpiresAt - now)
        : spanText(left) + ' ago';
      facts.push({ label: 'Login expired', value: stops + ', log in again', tone: 'err',
        title: 'Expired ' + deadline + '; it can no longer be renewed.' + renewed });
    }
  }
  if (p.authObtainedAt) {
    facts.push({ label: 'Logged in', value: spanText(now - p.authObtainedAt) + ' ago', tone: '',
      title: new Date(p.authObtainedAt).toLocaleString() + (p.authObtainedVia === 'observed' ? ' (when Meridian found it)' : '') });
  }
  return facts;
}

function profileFacts(p) {
  var facts = [];
  var authStale = p.authProvenance && p.authProvenance !== 'live';
  var statusValue = p.authProvenance === 'never' ? 'never read' : (p.loggedIn ? '\\u2713 Authenticated' : '\\u2717 Not logged in');
  facts.push({
    label: 'Status',
    value: statusValue,
    tone: p.loggedIn ? 'ok' : 'err',
    cached: authStale && p.authProvenance !== 'never'
  });
  facts = facts.concat(loginFacts(p, Date.now()));
  if (p.email) facts.push({ label: 'Email', value: p.email, tone: '', cached: authStale });
  if (p.organizationName) facts.push({ label: 'Organization', value: p.organizationName, tone: '' });
  if (p.accountType) facts.push({ label: 'Account', value: p.accountType, tone: '' });
  var plan = p.planName || p.planLabel || p.subscriptionType;
  if (plan) facts.push({ label: 'Plan', value: plan, tone: '', cached: authStale, title: p.seatTier || p.rateLimitTier || '' });
  if (p.allowance) facts.push({ label: 'Allowance', value: p.allowance + ' of a Pro plan\\u2019s Claude Code usage', shortValue: p.allowance, tone: '', title: p.rateLimitTier || '' });
  if (p.aliases && p.aliases.length > 0) facts.push({ label: 'Former names', value: p.aliases.join(', '), tone: '', title: 'Requests naming these are served by this profile, until the name is added again' });
  if (p.lastSuccessAt) facts.push({ label: 'Last Verified', value: timeAgo(p.lastSuccessAt), tone: 'ok' });
  if (p.lastCheckedAt && p.lastCheckedAt !== p.lastSuccessAt) {
    facts.push({ label: 'Last Checked', value: timeAgo(p.lastCheckedAt), tone: '' });
  }
  return facts;
}
`
