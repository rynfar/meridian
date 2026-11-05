/**
 * Whether the reader has text selected in the page's `#content`.
 *
 * On `/` every switchable account card is itself a switch button. Releasing a
 * drag-select over a card's text (to copy an email or an id) dispatches a
 * click on that card, which would move all traffic to that account. By the
 * time a plain click fires, the browser has already collapsed any earlier
 * selection, so a selection still standing at click time means the click
 * finished a selection rather than asking for a switch.
 *
 * A selection outside `#content` (the header, the nav) does not count: no
 * card can be under it.
 *
 * `reorderClientJs`'s pattern: the single browser-side copy, interpolated as
 * a string into the page and evaluated verbatim by its tests.
 */
export const textSelectionJs = `
var meridianSelection=(function(){
  function live(){
    var sel=window.getSelection?window.getSelection():null;
    if(!sel||sel.isCollapsed||!sel.toString())return false;
    var content=document.getElementById('content');
    return !!(content&&sel.anchorNode&&content.contains(sel.anchorNode));
  }
  return {live:live};
})();
`
