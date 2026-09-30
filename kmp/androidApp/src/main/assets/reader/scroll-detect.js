// Reports the page's sideways-scrolling blocks (our stylesheet makes only
// `pre` and `table` scroll) and which way each can still scroll, so
// ReaderWebView can keep a drag on one from turning the page.
(function () {
  var last = "";

  function report() {
    if (!window.lionReader) return;
    var rects = [];
    var blocks = document.querySelectorAll("pre, table");
    for (var i = 0; i < blocks.length; i++) {
      var el = blocks[i];
      var max = el.scrollWidth - el.clientWidth;
      if (max <= 1) continue;
      var r = el.getBoundingClientRect();
      rects.push([
        r.left + window.scrollX,
        r.top + window.scrollY,
        r.right + window.scrollX,
        r.bottom + window.scrollY,
        el.scrollLeft > 0 ? 1 : 0,
        el.scrollLeft < max - 1 ? 1 : 0,
      ]);
    }
    var message = JSON.stringify(rects);
    if (message !== last) {
      last = message;
      window.lionReader.postMessage(message);
    }
  }

  report();
  // Layout settles as images and fonts load; blocks reach their edges as they
  // scroll.
  new ResizeObserver(report).observe(document.body);
  // A wide view's body keeps its (capped) size but moves.
  window.addEventListener("resize", report);
  document.fonts.ready.then(report);
  document.addEventListener(
    "scroll",
    function (event) {
      // The page scrolling doesn't move blocks within it.
      if (event.target !== document) report();
    },
    { capture: true, passive: true },
  );
})();
