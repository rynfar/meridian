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
 *
 * A ChatGPT seat (`provider: "chatgpt"` from /profiles/list) is a profile like
 * any other and gets the same facts. Where the vendor differs the words do:
 * its allowance is a multiple of ChatGPT Plus rather than of Claude Pro, its
 * banked rate-limit resets are a fact of their own, and its login belongs to
 * whatever owns the seat's credentials, which is usually not Meridian.
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

// The two largest units of an advisory stored expiry countdown.
function expirySpan(ms) {
  var mins = Math.floor(Math.abs(ms) / 60000);
  var d = Math.floor(mins / 1440);
  mins -= d * 1440;
  var h = Math.floor(mins / 60);
  var m = mins - h * 60;
  if (d > 0) return d + 'd ' + h + 'h';
  if (h > 0) return h + 'h ' + m + 'm';
  return m + 'm';
}

function expiryFacts(p, now) {
  var facts = [];
  if (p.refreshTokenExpiresAt) {
    var left = p.refreshTokenExpiresAt - now;
    facts.push({ label: 'Refresh deadline',
      value: left > 0 ? 'in ' + expirySpan(left) : 'passed \\u2014 login may need renewal',
      tone: left <= 0 || p.renewalRequiredSoon ? 'warn' : '',
      title: new Date(p.refreshTokenExpiresAt).toLocaleString()
        + '. Reported by the stored credential; log in again before then. Authentication is checked separately.' });
  }
  if (p.accessTokenExpiresAt) {
    var accessLeft = p.accessTokenExpiresAt - now;
    facts.push({ label: 'Stored access token',
      value: accessLeft > 0 ? 'expires in ' + expirySpan(accessLeft) : 'expiry passed',
      tone: accessLeft <= 0 ? 'warn' : '',
      title: new Date(p.accessTokenExpiresAt).toLocaleString()
        + '. Recorded expiry, which may be estimated. Authentication is checked separately.' });
  }
  return facts;
}

function isChatGptProfile(p) {
  return !!p && (p.provider === 'chatgpt' || p.type === 'chatgpt');
}

// How long until a banked reset expires, in its largest whole unit: 13d, 5h, 40m.
function resetExpiryIn(ts, now) {
  var ms = ts - now;
  if (!(ms > 0)) return 'now';
  var minutes = Math.floor(ms / 60000);
  if (minutes < 60) return Math.max(1, minutes) + 'm';
  var hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + 'h';
  return Math.floor(hours / 24) + 'd';
}

// "1 (expires 13d)", "2 (expire 3d, 11d)", "0" - or "unknown" when the seat
// had no valid token to ask with. An expiry the list did not state reads as
// "unknown" in its place rather than shortening the list.
function formatResets(resets, now) {
  if (!resets || typeof resets.available !== 'number') return 'unknown';
  var count = resets.available;
  if (count <= 0) return '0';
  var expiries = Array.isArray(resets.expiresAt) ? resets.expiresAt : [];
  if (expiries.length === 0) return count + ' (expiry unknown)';
  var parts = expiries.map(function (ts) { return ts == null ? 'unknown' : resetExpiryIn(ts, now); });
  return count + ' (' + (parts.length === 1 ? 'expires ' : 'expire ') + parts.join(', ') + ')';
}

var CHATGPT_TOKEN_STATUS = {
  expired: '\\u2717 Access token expired',
  refused: '\\u2717 Token refused by chatgpt.com',
  no_token: '\\u2717 No access token',
  requires_reauth: '\\u2717 Needs sign-in',
  unknown: '\\u2717 Not in the credential store'
};

var CHATGPT_OWNER_STATE = {
  quota_exhausted: 'quota exhausted',
  cooling_down: 'cooling down',
  disabled: 'disabled',
  no_authority: 'no refresh authority'
};

function ownerName(owner) {
  if (!owner) return '';
  if (owner.name === 'meridian') return 'Meridian';
  return owner.name + (owner.account ? ' \\u00b7 account ' + owner.account : '');
}

function profileFacts(p) {
  var facts = [];
  var chatgpt = isChatGptProfile(p);
  var authStale = p.authProvenance && p.authProvenance !== 'live';
  var statusValue = p.authProvenance === 'never' ? 'never read'
    : p.loggedIn ? '\\u2713 Authenticated'
    : (chatgpt && CHATGPT_TOKEN_STATUS[p.tokenState]) || '\\u2717 Not logged in';
  facts.push({
    label: 'Status',
    value: statusValue,
    tone: p.loggedIn ? 'ok' : 'err',
    cached: authStale && p.authProvenance !== 'never'
  });
  if (chatgpt && !p.loggedIn && typeof p.renewalRetryAt === 'number') {
    var retryIn = p.renewalRetryAt - Date.now();
    facts.push({ label: 'Next renewal', value: retryIn > 0 ? 'in ' + expirySpan(retryIn) : 'now', tone: '',
      title: 'chatgpt.com refused the access token; Meridian renews it on its own at ' + new Date(p.renewalRetryAt).toLocaleString() });
  }
  facts = facts.concat(expiryFacts(p, Date.now()));
  if (p.email) facts.push({ label: 'Email', value: p.email, tone: '', cached: authStale });
  if (p.organizationName) facts.push({ label: 'Organization', value: p.organizationName, tone: '' });
  if (p.accountType) facts.push({ label: 'Account', value: p.accountType, tone: '' });
  var plan = p.planName || p.planLabel || p.subscriptionType;
  if (plan) facts.push({ label: 'Plan', value: plan, tone: '', cached: authStale, title: p.seatTier || p.rateLimitTier || (chatgpt ? p.subscriptionType || '' : '') });
  if (chatgpt) {
    facts.push({
      label: 'Resets',
      value: formatResets(p.resets, Date.now()),
      tone: '',
      title: 'Banked rate-limit resets, as chatgpt.com lists them. Each clears the seat\\u2019s windows once when redeemed '
        + '(oc-codex-multi-auth\\u2019s codex-reset tool); Meridian only reads them.'
    });
  }
  if (p.allowance) {
    facts.push({
      label: 'Allowance',
      value: chatgpt && p.planTier === 'free'
        ? p.allowance + ': a free seat has almost no Codex usage'
        : p.allowance + (chatgpt ? ' of a ChatGPT Plus plan\\u2019s Codex usage' : ' of a Pro plan\\u2019s Claude Code usage'),
      shortValue: p.allowance,
      tone: '',
      title: p.rateLimitTier || ''
    });
  }
  if (chatgpt && p.planTier === 'free') {
    var deferred = p.freeSeatDeferred;
    facts.push({
      label: 'Routing',
      value: deferred
        ? 'Active, but free: ' + deferred.servedFirstBy.join(', ') + ' serve' + (deferred.servedFirstBy.length === 1 ? 's' : '') + ' unpinned work first'
        : 'Free plan: serves unpinned work after every paid seat',
      shortValue: deferred ? 'paid seats first' : 'free seat last',
      tone: '',
      title: 'A free-plan seat refuses most Codex models, so it takes unpinned work only once no paid seat has plan usage left, '
        + (p.freeSeatOrder === 'after-credits'
          ? 'and only after every seat that can serve on Codex credits (Settings \\u2192 Free-Plan Seats).'
          : 'and before any seat spends Codex credits (Settings \\u2192 Free-Plan Seats).')
    });
  }
  if (chatgpt && p.owner) {
    facts.push({
      label: 'Owner',
      value: ownerName(p.owner),
      tone: '',
      title: p.owner.name === 'meridian'
        ? 'Meridian holds this seat\\u2019s login and renews its token.'
        : 'Meridian reads this seat\\u2019s login from ' + p.owner.name + ' and never changes it: sign-in, renewal and removal happen there.'
    });
  }
  if (chatgpt && CHATGPT_OWNER_STATE[p.unavailable]) {
    facts.push({ label: 'Owner state', value: CHATGPT_OWNER_STATE[p.unavailable], tone: '' });
  }
  if (p.aliases && p.aliases.length > 0) facts.push({ label: 'Former names', value: p.aliases.join(', '), tone: '', title: 'Requests naming these are served by this profile, until the name is added again' });
  if (p.lastSuccessAt) facts.push({ label: 'Last Verified', value: timeAgo(p.lastSuccessAt), tone: 'ok' });
  if (p.lastCheckedAt && p.lastCheckedAt !== p.lastSuccessAt) {
    facts.push({ label: 'Last Checked', value: timeAgo(p.lastCheckedAt), tone: '' });
  }
  return facts;
}

// How to give a profile that cannot serve back its access, in the words of
// whoever holds its login: Meridian's own command for a Claude profile, the
// owning tool's for a ChatGPT seat Meridian only follows. \`pill\` is the short
// label a card shows, \`reason\` why, \`summary\` the reason with the command
// to run - a tooltip's worth.
function profileAccessHelp(p) {
  if (!isChatGptProfile(p)) {
    return { pill: 'needs login', reason: 'Cannot serve requests.', summary: 'Cannot serve requests \\u2014 run: meridian profile login ' + p.id };
  }
  var owner = p.owner || {};
  if (owner.name === 'meridian') {
    if (p.tokenState === 'refused' && typeof p.renewalRetryAt === 'number') {
      var retryIn = p.renewalRetryAt - Date.now();
      var renewing = 'chatgpt.com refused this seat\\u2019s access token. Meridian renews it on its own, next ' + (retryIn > 0 ? 'in ' + expirySpan(retryIn) : 'now') + '.';
      return { pill: 'renewing', reason: renewing, summary: renewing + ' Sign it in again only if a renewal is refused.' };
    }
    var owned = 'Meridian holds this seat\\u2019s login and cannot renew it.';
    if (owner.webSignIn) {
      return { pill: 'needs login', reason: owned, summary: owned + ' Sign it in again with Sign in again on its card.' };
    }
    return { pill: 'needs login', reason: owned, summary: owned + ' Bring a fresh one in with: ' + owner.importCommand };
  }
  var signIn = owner.login + ' \\u2192 ' + owner.loginMethod + ' \\u2192 ' + (p.label || p.id) + ' \\u2192 Refresh account';
  if (p.tokenState === 'expired') {
    var expired = 'The access token expired. ' + owner.name + ' owns this login and renews it; Meridian only reads it.';
    return { pill: 'token expired', reason: expired, summary: expired + ' Renew it now: ' + owner.refresh };
  }
  if (p.tokenState === 'refused') {
    var refused = 'chatgpt.com refused this seat\\u2019s access token. ' + owner.name + ' owns this login; sign the seat in again there.';
    return { pill: 'token refused', reason: refused, summary: refused + ' Run: ' + signIn };
  }
  var missing = 'No usable access token. ' + owner.name + ' owns this login; sign the seat in there.';
  return { pill: 'needs login', reason: missing, summary: missing + ' Run: ' + signIn };
}

// Why a ChatGPT seat shows no usage windows, in a phrase; '' when nothing
// explains it yet. Claude profiles keep their own wording on each page.
var CHATGPT_USAGE_GAP = {
  token_expired: 'the access token expired, and Meridian never renews a token it follows',
  unauthorized: 'chatgpt.com refused this seat\\u2019s access token',
  no_token: 'there is no access token in the owner\\u2019s store',
  disabled: 'the seat is disabled at its owner',
  rate_limited: 'the usage endpoint is rate limiting, retrying',
  upstream_error: 'the usage endpoint failed, retrying',
  invalid_response: 'the usage endpoint answered with something unreadable, retrying',
  identity_mismatch: 'the stored token belongs to another account, so its usage is not shown',
  invalid_token: 'the stored access token could not be decoded'
};

function chatGptUsageGap(error) {
  return (error && CHATGPT_USAGE_GAP[error]) || '';
}

// A seat's purchased Codex credits, for the slot where a Claude account's
// extra usage goes: both keep an account serving once its plan's windows are
// spent. Null - no block - for a seat that holds none, as a Claude account
// with extra usage off shows none.
//
// \`quota\` is the seat's /v1/usage/quota/all entry: its credits policy says
// when the balance may be spent, and \`servingOnCredits\` that it is being
// spent now - a seat paying for turns with what may be real money is the one
// thing on the card that must not be missed, so it takes the warning tone.
var CODEX_CREDITS_POLICY_NOTE = {
  never: 'never used \\u2014 credits policy is never',
  reserve: 'used only when no seat has plan usage left',
  immediately: 'used as soon as this seat\\u2019s plan usage is drained'
};

function codexCreditsView(credits, quota) {
  if (!credits) return null;
  var value = credits.unlimited ? 'unlimited'
    : typeof credits.balance === 'number' && credits.balance > 0
      ? credits.balance.toLocaleString('en-US', { maximumFractionDigits: 2 }) + ' credits'
      : credits.hasCredits ? 'available' : null;
  if (value === null) return null;
  var policy = quota && CODEX_CREDITS_POLICY_NOTE[quota.creditsPolicy] ? quota.creditsPolicy : null;
  var serving = !!(quota && quota.servingOnCredits);
  var pace = codexCreditsPace(credits, quota, Date.now());
  return {
    pace: pace,
    value: value,
    note: credits.overageLimitReached ? 'overage limit reached'
      : serving ? 'plan usage spent \\u2014 serving on credits now'
      : policy ? CODEX_CREDITS_POLICY_NOTE[policy]
      : 'used once the plan\\u2019s limits run out',
    status: credits.overageLimitReached ? 'high' : serving ? 'warn' : 'ok',
    serving: serving,
    policy: policy ? 'policy: ' + policy + (quota.creditsPolicySource === 'seat' ? ' (this seat)' : '') : null
  };
}

// "45m", "1h35m", "3d4h": how long a balance lasts at a pace.
function creditsDuration(hours) {
  if (!(hours > 0) || !isFinite(hours)) return null;
  if (hours >= 24 * 365) return 'over a year';
  var minutes = Math.max(1, Math.round(hours * 60));
  if (minutes < 60) return minutes + 'm';
  if (minutes < 48 * 60) return Math.floor(minutes / 60) + 'h' + (minutes % 60 ? (minutes % 60) + 'm' : '');
  var wholeHours = Math.round(hours);
  return Math.floor(wholeHours / 24) + 'd' + (wholeHours % 24 ? (wholeHours % 24) + 'h' : '');
}

// How long a seat's balance would last at this instance's pace of credits
// (\`quota.creditsBurn\`, every seat's traffic priced on the credits rate
// card). A seat not paying with credits now gets the same figure framed as
// hypothetical, so it is never read as live burn. Null where nothing is known.
function codexCreditsPace(credits, quota, now) {
  if (credits.unlimited) return { text: 'unlimited', title: 'Unlimited credits: no balance to run out', approximate: false };
  var burn = quota && quota.creditsBurn;
  if (!burn) return null;
  if (burn.status === 'idle') return { text: 'idle', title: 'No ChatGPT traffic in the last ' + burn.windowMinutes + ' minutes', approximate: false };
  if (burn.status === 'unknown_rate') {
    return { text: 'no estimate', title: 'No credit rate for ' + burn.models.join(', ') + ', so the pace is unknown', approximate: false };
  }
  if (typeof credits.balance !== 'number' || !(credits.balance > 0)) return null;
  var lasts = creditsDuration(credits.balance / burn.creditsPerHour);
  if (!lasts) return null;
  var mix = burn.mix.map(function (m) {
    var pct = Math.round(m.share * 100);
    return (pct < 1 && m.share > 0 ? '<1' : pct) + '% ' + m.model;
  }).join(' / ');
  var approximate = burn.approximate.length > 0;
  var title = Math.round(burn.creditsPerHour).toLocaleString('en-US') + ' credits/h over the last ' + burn.windowMinutes
    + ' minutes, ' + burn.turns + ' turn' + (burn.turns === 1 ? '' : 's') + ' across all seats: ' + mix
    + (approximate ? '. Approximate: ' + burn.approximate.join('; ') : '');
  var mark = approximate ? '~' : '';
  var serving = !!(quota && quota.servingOnCredits);
  if (serving) return { text: 'est. out in ' + mark + lasts + ' at current pace', title: title, approximate: approximate };
  var policy = quota && quota.creditsPolicy;
  var start = policy === 'never' ? 'not spent (policy never)'
    : policy === 'reserve' ? 'starts after every seat\\u2019s plan limits'
    : 'starts after plan limits';
  return { text: start + '; would last ~' + lasts + ' at current pace', title: title, approximate: approximate };
}

// Which vendor is refusing a profile, and what the page calls it.
function refusalSubject(p) {
  return isChatGptProfile(p) ? { vendor: 'ChatGPT', noun: 'seat' } : { vendor: 'Anthropic', noun: 'account' };
}
`
