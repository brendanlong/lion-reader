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
      // An RTL block's scrollLeft runs from -max (scrolled to its end) to 0.
      var rtl = getComputedStyle(el).direction === "rtl";
      var left = rtl ? el.scrollLeft > 1 - max : el.scrollLeft > 0;
      var right = rtl ? el.scrollLeft < -1 : el.scrollLeft < max - 1;
      var r = el.getBoundingClientRect();
      rects.push([
        r.left + window.scrollX,
        r.top + window.scrollY,
        r.right + window.scrollX,
        r.bottom + window.scrollY,
        left ? 1 : 0,
        right ? 1 : 0,
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
