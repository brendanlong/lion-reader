import { describe, expect, it } from "vitest";
import { isEInkUserAgent } from "@/lib/theme/eink";

describe("isEInkUserAgent", () => {
  it("matches known e-reader device user agents", () => {
    const eReaderUserAgents = [
      // Kindle Paperwhite experimental browser
      "Mozilla/5.0 (X11; U; Linux armv7l like Android; en-us) AppleWebKit/531.2+ (KHTML, like Gecko) Version/5.0 Safari/533.2+ Kindle/3.0+",
      // Kobo eReader browser
      "Mozilla/5.0 (Linux; U; Android 2.0; en-us;) AppleWebKit/538.1 (KHTML, like Gecko) Version/4.0 Mobile Safari/538.1 (Kobo Touch 0373/4.38.23171)",
      // EinkBro on an Onyx Boox device
      "Mozilla/5.0 (Linux; Android 11; NoteAir2P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36 EinkBro/11.4.0",
      // Tolino
      "Mozilla/5.0 (Linux; U; Android 4.4.4; de-de; tolino tab 8 Build/KTU84P) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/33.0.0.0 Safari/537.36",
      // PocketBook InkPad
      "Mozilla/5.0 (X11; Linux; PocketBook) AppleWebKit/601.1 (KHTML, like Gecko) Version/8.0 Safari/601.1",
    ];
    for (const userAgent of eReaderUserAgents) {
      expect(isEInkUserAgent(userAgent), userAgent).toBe(true);
    }
  });

  it("does not match ordinary browser user agents", () => {
    const ordinaryUserAgents = [
      // Desktop Chrome
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      // Desktop Firefox
      "Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0",
      // iOS Safari
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
      // Android Chrome
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
    ];
    for (const userAgent of ordinaryUserAgents) {
      expect(isEInkUserAgent(userAgent), userAgent).toBe(false);
    }
  });

  it("requires word boundaries so substrings inside other words don't match", () => {
    expect(isEInkUserAgent("Mozilla/5.0 (SomeKindleryDevice)")).toBe(false);
  });
});
