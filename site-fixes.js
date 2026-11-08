/* Small behaviour fixes layered on top of the Claude Design page.
   Loaded by apply_patches.py (a <script> tag before </body>), so they survive re-exports. */
(() => {
  // While the magnifier lens is showing, hide the custom cursor so it doesn't cover the zoomed image.
  const style = document.createElement('style');
  style.textContent = 'body[data-lens-on] .df-cursor,body[data-lens-on] [data-cursor-label]{opacity:0!important;transition:none!important;}';
  document.head.appendChild(style);

  // The page's template engine can replace nodes after load, so watch style changes on the whole
  // document and react to whichever element is the magnifier lens right now.
  new MutationObserver(records => {
    for (const rec of records) {
      const el = rec.target;
      if (el.nodeType === 1 && el.hasAttribute('data-lens')) {
        document.body.toggleAttribute('data-lens-on', el.style.display === 'block');
      }
    }
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['style'], subtree: true });
})();
