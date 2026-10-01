import { describe, expect, it } from "vitest";
import { appIntentUrl } from "../../src/app/(spa)/oauth/app-callback/OpenInApp";

describe("appIntentUrl", () => {
  it("hands the whole redirect, query and all, to the named app", () => {
    expect(
      appIntentUrl(
        "https://lionreader.com/oauth/app-callback?code=a%2Bb&state=s",
        "com.lionreader.app",
        "android.intent.action.VIEW"
      )
    ).toBe(
      "intent://lionreader.com/oauth/app-callback?code=a%2Bb&state=s#Intent;" +
        "scheme=https;action=android.intent.action.VIEW;" +
        "category=android.intent.category.BROWSABLE;package=com.lionreader.app;end"
    );
  });

  it("keeps a dev server's port and http scheme", () => {
    expect(
      appIntentUrl(
        "http://localhost:3000/oauth/app-callback/debug?code=c&state=s",
        "com.lionreader.app.debug",
        "com.lionreader.app.DEBUG_SIGN_IN_CALLBACK"
      )
    ).toMatch(
      /^intent:\/\/localhost:3000\/oauth\/app-callback\/debug\?code=c&state=s#Intent;scheme=http;/
    );
  });
});
