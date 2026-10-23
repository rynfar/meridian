/**
 * Two things a profile card says about itself that `/` and `/profiles` must
 * say the same way: that it holds the same account as another profile, and
 * that a sign-in just finished and its facts are on the way.
 *
 * DUPLICATE. `/profiles/list` names, per profile, the other profiles signed in
 * to the same account (`duplicateOf`, see src/proxy/duplicateProfiles.ts).
 * Both cards get a badge naming the other, so the reader can see which pair it
 * is and pick the one to sign in again or remove. Nothing is removed for them.
 *
 * UPDATING. A finished sign-in is followed by the reads that say who it signed
 * in as; `/profiles/list` reports them as `factsRefresh`. Between the page
 * learning the sign-in succeeded and its next answer, the server has not been
 * asked yet - so the page also remembers the sign-in itself, and an answer
 * that was REQUESTED before the sign-in finished is not allowed to clear it.
 * While a card is updating it stays on screen whatever the filters say: a card
 * the user just signed in must not vanish because its login state changed.
 *
 * `profileFindJs`'s pattern: the single browser-side copy, interpolated as a
 * string into each page, and evaluated verbatim by its tests.
 */
export const profileCardStatusJs = `
var meridianCardStatus=(function(){
  function escText(s){
    return String(s==null?'':s).replace(/[&<>"']/g,function(ch){
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch];
    });
  }
  var BASIS={
    'account-organization':'the same Claude account in the same organization',
    'email-organization':'the same email and organization (account id not read yet)',
    'seat':'the same ChatGPT seat',
    'workspace-email':'the same email in the same ChatGPT workspace'
  };
  function duplicateOf(p){return (p&&Array.isArray(p.duplicateOf))?p.duplicateOf:[]}
  function duplicateBadgeHtml(p,cls){
    var others=duplicateOf(p);
    if(others.length===0)return '';
    var title='Signed in to '+(BASIS[p.duplicateBasis]||'the same account')+' as '+others.join(', ')
      +': one account and one quota under '+(others.length+1)+' names. Sign one of them in to the account it was meant for, or remove it.';
    return '<span class="'+cls+' badge-duplicate" title="'+escText(title)+'">duplicate of '+escText(others.join(', '))+'</span>';
  }

  var pending=Object.create(null);
  function beginUpdate(id){pending[id]={since:Date.now()}}
  // requestedAt: when the /profiles/list answer holding p was asked for.
  function updateOf(p,requestedAt){
    if(!p)return null;
    var server=p.factsRefresh;
    var local=pending[p.id];
    if(server&&server.state==='updating')return {state:'updating'};
    if(server&&server.state==='failed'){
      delete pending[p.id];
      return {state:'failed',error:server.error||'The account details could not be read.'};
    }
    if(!local)return null;
    if(requestedAt!=null&&requestedAt<local.since)return {state:'updating'};
    delete pending[p.id];
    return null;
  }
  function updating(id){return !!pending[id]}
  function updateHtml(view){
    if(!view)return '';
    if(view.state==='updating')return '<div class="card-updating" role="status"><span class="card-spinner" aria-hidden="true"></span>Updating with the new sign-in\\u2026</div>';
    return '<div class="card-update-failed" role="alert">'+escText(view.error)+'</div>';
  }
  return {
    duplicateOf:duplicateOf,
    duplicateBadgeHtml:duplicateBadgeHtml,
    beginUpdate:beginUpdate,
    updateOf:updateOf,
    updating:updating,
    updateHtml:updateHtml
  };
})();
`

export const profileCardStatusCss = `
  .badge-duplicate { background: rgba(210,153,34,0.14); color: var(--yellow); border: 1px solid rgba(210,153,34,0.45); }
  .card-updating { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--accent, var(--text)); margin: 6px 0 10px; }
  .card-update-failed { font-size: 12px; color: var(--red); margin: 6px 0 10px; }
  .card-spinner { width: 12px; height: 12px; border-radius: 50%; border: 2px solid currentColor; border-right-color: transparent;
    display: inline-block; animation: card-spin 0.8s linear infinite; flex: none; }
  .profile-card.updating { opacity: 0.85; }
  @keyframes card-spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .card-spinner { animation-duration: 2.4s; } }
`
