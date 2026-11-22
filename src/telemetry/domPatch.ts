/**
 * Patch a live page from freshly rendered markup instead of replacing it.
 *
 * `/` and `/profiles` poll every ten seconds and used to assign the whole
 * `#content` through `innerHTML`. Every poll then threw away every node on the
 * page: a browser find-in-page (^F) lost its highlights and its place, a text
 * selection vanished mid-copy, and focus and scroll anchoring were left to
 * chance - even when nothing on the page had changed.
 *
 * This keeps the nodes that are still there and touches only what differs:
 * an attribute that changed, a text node whose text changed, a card that
 * appeared, moved or went away. A node is matched to its new rendering by its
 * `data-key` or `id` when it has one (cards: their profile id, so a reorder
 * moves the card itself), otherwise by position among its unkeyed siblings
 * with the same tag. A node carrying `data-patch-own` keeps its children: the
 * page's script fills it (a sign-in panel) and the render leaves it empty.
 *
 * `profileFindJs`'s pattern: the single browser-side copy, interpolated as a
 * string into each page, and evaluated verbatim by its tests.
 */
export const domPatchJs = `
var meridianPatch=(function(){
  function keyOf(n){
    if(!n||n.nodeType!==1)return null;
    return n.getAttribute('data-key')||n.getAttribute('id')||null;
  }
  function sameKind(a,b){
    return a.nodeType===b.nodeType&&a.nodeName===b.nodeName&&keyOf(a)===keyOf(b);
  }
  function syncAttributes(el,src){
    var stale=[],i;
    for(i=0;i<el.attributes.length;i++)if(!src.hasAttribute(el.attributes[i].name))stale.push(el.attributes[i].name);
    for(i=0;i<stale.length;i++)el.removeAttribute(stale[i]);
    for(i=0;i<src.attributes.length;i++){
      var a=src.attributes[i];
      if(el.getAttribute(a.name)!==a.value)el.setAttribute(a.name,a.value);
    }
  }
  function morphNode(el,src){
    if(el.nodeType!==1){
      if(el.nodeValue!==src.nodeValue)el.nodeValue=src.nodeValue;
      return;
    }
    syncAttributes(el,src);
    if(el.hasAttribute('data-patch-own'))return;
    morphChildren(el,src);
  }
  // Walks the new children in order with a cursor over the old ones: a match
  // at the cursor is patched where it stands, a keyed match elsewhere is moved
  // to the cursor, and anything unmatched is inserted. What is left past the
  // cursor at the end is what the new rendering no longer has.
  function morphChildren(target,source){
    var keyed=Object.create(null),wanted=Object.create(null),c;
    for(c=target.firstChild;c;c=c.nextSibling){var k=keyOf(c);if(k!=null)keyed[k]=c}
    for(c=source.firstChild;c;c=c.nextSibling){var w=keyOf(c);if(w!=null)wanted[w]=true}
    var cursor=target.firstChild;
    var src=source.firstChild;
    while(src){
      var next=src.nextSibling;
      // A keyed node the new rendering does not have goes now, so the unkeyed
      // siblings behind it can still be matched in place.
      while(cursor&&keyOf(cursor)!=null&&!wanted[keyOf(cursor)]){
        var gone=cursor;cursor=cursor.nextSibling;target.removeChild(gone);
      }
      var key=keyOf(src);
      var match=null;
      if(key!=null){
        match=keyed[key]||null;
        if(match&&!sameKind(match,src))match=null;
        if(match)delete keyed[key];
      }else if(cursor&&keyOf(cursor)==null&&sameKind(cursor,src)){
        match=cursor;
      }
      if(match){
        if(match===cursor)cursor=cursor.nextSibling;
        else target.insertBefore(match,cursor);
        morphNode(match,src);
      }else{
        target.insertBefore(src,cursor);
      }
      src=next;
    }
    while(cursor){var after=cursor.nextSibling;target.removeChild(cursor);cursor=after}
  }
  return {
    morphChildren:morphChildren,
    html:function(target,markup){
      var t=document.createElement('template');
      t.innerHTML=markup;
      if(!t.content){target.innerHTML=markup;return}
      morphChildren(target,t.content);
    }
  };
})();
`
