"use client";

import { Button } from "@/components/ui/button";

/**
 * Hands this page's URL (the sign-in redirect) to the debug app through its
 * dev-only `DEBUG_SIGN_IN_CALLBACK` intent filter, which Chrome opens from an
 * `intent:` link. Built on click, so the code never ends up in the markup.
 */
export function OpenInDebugApp() {
  function open() {
    const url = new URL(window.location.href);
    window.location.href =
      `intent://${url.host}${url.pathname}${url.search}#Intent;` +
      `scheme=${url.protocol.replace(":", "")};` +
      "action=com.lionreader.app.DEBUG_SIGN_IN_CALLBACK;" +
      "package=com.lionreader.app.debug;end";
  }

  return (
    <Button className="mt-4 w-full" onClick={open}>
      Open in the debug app
    </Button>
  );
}
