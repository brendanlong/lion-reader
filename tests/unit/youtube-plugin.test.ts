/**
 * Unit tests for the YouTube plugin's `feed` capability and the `getFeedPlugin`
 * resolver. The plugin exists to floor YouTube's aggressive `max-age=900` cache
 * hint at an hour so we don't trip YouTube's per-IP rate limiting (issue #1114).
 */

import { describe, it, expect } from "vitest";
import { youtubePlugin, YOUTUBE_MIN_FETCH_INTERVAL_SECONDS } from "@/server/plugins/youtube";
import { getFeedPlugin } from "@/server/plugins";

describe("youtubePlugin.matchUrl", () => {
  it("matches channel, playlist, and legacy user feed URLs", () => {
    expect(
      youtubePlugin.matchUrl(
        new URL("https://www.youtube.com/feeds/videos.xml?channel_id=UCXuqSBlHAE6Xw-yeJA0Tunw")
      )
    ).toBe(true);
    expect(
      youtubePlugin.matchUrl(
        new URL("https://www.youtube.com/feeds/videos.xml?playlist_id=PL1234567890")
      )
    ).toBe(true);
    expect(
      youtubePlugin.matchUrl(new URL("https://www.youtube.com/feeds/videos.xml?user=somename"))
    ).toBe(true);
  });

  it("does not match non-feed YouTube URLs", () => {
    expect(youtubePlugin.matchUrl(new URL("https://www.youtube.com/watch?v=abc123"))).toBe(false);
    expect(youtubePlugin.matchUrl(new URL("https://www.youtube.com/@somechannel"))).toBe(false);
    expect(youtubePlugin.matchUrl(new URL("https://www.youtube.com/feeds/videos.xml"))).toBe(false);
  });
});

describe("getFeedPlugin resolution for YouTube", () => {
  it("resolves YouTube feed URLs to the plugin with the polling floor", () => {
    const plugin = getFeedPlugin(
      "https://www.youtube.com/feeds/videos.xml?channel_id=UCXuqSBlHAE6Xw-yeJA0Tunw"
    );
    expect(plugin?.name).toBe("youtube");
    expect(plugin?.capabilities.feed.minFetchIntervalSeconds).toBe(
      YOUTUBE_MIN_FETCH_INTERVAL_SECONDS
    );
  });

  it("resolves the bare and mobile hostnames too", () => {
    expect(getFeedPlugin("https://youtube.com/feeds/videos.xml?channel_id=UCabc")?.name).toBe(
      "youtube"
    );
    expect(getFeedPlugin("https://m.youtube.com/feeds/videos.xml?channel_id=UCabc")?.name).toBe(
      "youtube"
    );
  });

  it("does not resolve non-feed YouTube URLs", () => {
    expect(getFeedPlugin("https://www.youtube.com/watch?v=abc123")).toBeNull();
  });
});
