// The only script the reader view runs (its Content-Security-Policy allows
// just this file). It reports where the page has blocks that scroll sideways —
// wide tables and code — so ReaderWebView can keep a drag that starts on one
// from turning the page. `lionReader` is the message channel ReaderWebView
// opens to this origin only.
(function () {
  var last = "";

  function scrollsSideways(el) {
    if (el.scrollWidth <= el.clientWidth + 1) return false;
    var overflow = getComputedStyle(el).overflowX;
    return overflow === "auto" || overflow === "scroll";
  }

  function report() {
    if (!window.lionReader) return;
    var rects = [];
    var elements = document.body.getElementsByTagName("*");
    for (var i = 0; i < elements.length; i++) {
      if (!scrollsSideways(elements[i])) continue;
      var r = elements[i].getBoundingClientRect();
      rects.push([r.left, r.top + window.scrollY, r.right, r.bottom + window.scrollY]);
    }
    var message = JSON.stringify(rects);
    if (message !== last) {
      last = message;
      window.lionReader.postMessage(message);
    }
  }

  // Layout settles as images and fonts load.
  new ResizeObserver(report).observe(document.body);
  document.fonts.ready.then(report);
  window.addEventListener("load", report);
})();
