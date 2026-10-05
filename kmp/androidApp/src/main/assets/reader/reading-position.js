// Reports where the reader is, so ReaderWebView can bring a page that loads
// again (a new renderer, an edited article) back there: the article element at
// the top of the screen, numbered as narration.js numbers them (it runs after
// this, before the app can ask to restore), and how far through it, as a
// fraction of its height so the place survives a change of text size.
(function () {
  var REPORT_AFTER_MILLIS = 150;

  function elements() {
    return document.querySelectorAll("[data-para-id]");
  }

  // The innermost element across the top of the screen; else, in a gap, the
  // first one below it.
  function anchor() {
    if (window.scrollY <= 0) return null;
    var all = elements();
    var found = null;
    for (var i = 0; i < all.length; i++) {
      var box = all[i].getBoundingClientRect();
      if (box.height <= 0 || box.bottom <= 0) continue;
      if (box.top > 0 && found) break;
      found = { element: i, offset: -box.top / box.height };
      if (box.top > 0) break;
    }
    return found;
  }

  var timer = 0;
  var last = "";
  document.addEventListener(
    "scroll",
    function (event) {
      if (event.target !== document || !window.lionReader) return;
      clearTimeout(timer);
      timer = setTimeout(function () {
        var message = JSON.stringify({ type: "position", at: anchor() });
        if (message === last) return;
        last = message;
        window.lionReader.postMessage(message);
      }, REPORT_AFTER_MILLIS);
    },
    { passive: true },
  );

  // Once is enough: the browser's scroll anchoring keeps the place as fonts
  // and images load around it.
  window.lionPosition = {
    restore: function (element, offset) {
      var target = elements()[element];
      if (!target) return;
      var box = target.getBoundingClientRect();
      window.scrollTo(0, window.scrollY + box.top + offset * box.height);
    },
  };
})();
