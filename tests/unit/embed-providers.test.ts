import { describe, it, expect } from "vitest";
import { normalizeEmbed } from "@lion-reader/sanitizer";

/**
 * The iframe embed allow-list now lives in the native sanitizer
 * (native/sanitizer/core/src/embeds.rs); these tests exercise it through the
 * exported `normalizeEmbed` binding. Keep in sync with the Rust unit tests.
 */

/** Canonical hostnames every surviving embed src is rewritten to (embeds.rs). */
const EMBED_CANONICAL_HOSTNAMES = [
  "www.youtube-nocookie.com",
  "player.vimeo.com",
  "open.spotify.com",
  "w.soundcloud.com",
  "bandcamp.com",
  "codepen.io",
];

describe("normalizeEmbed", () => {
  it("returns null for empty/unrecognized srcs", () => {
    expect(normalizeEmbed("")).toBeNull();
    expect(normalizeEmbed("https://evil.example/fake-login")).toBeNull();
    expect(normalizeEmbed("javascript:alert(1)")).toBeNull();
  });

  it("rejects lookalike hostnames", () => {
    expect(normalizeEmbed("https://player.vimeo.com.evil.com/video/123")).toBeNull();
    expect(normalizeEmbed("https://open.spotify.com.evil.com/embed/track/x")).toBeNull();
    expect(normalizeEmbed("https://evil.com/player.vimeo.com/video/123")).toBeNull();
  });

  describe("YouTube", () => {
    it("normalizes to youtube-nocookie", () => {
      const out = normalizeEmbed("https://www.youtube.com/embed/dQw4w9WgXcQ");
      expect(out?.provider).toBe("YouTube");
      expect(out?.src).toBe("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ");
      expect(out?.sandbox).toContain("allow-scripts");
    });
  });

  describe("Vimeo", () => {
    it("keeps a numeric video id and the private hash", () => {
      const out = normalizeEmbed("https://player.vimeo.com/video/123456789?h=abc123&autoplay=1");
      expect(out?.provider).toBe("Vimeo");
      expect(out?.src).toBe("https://player.vimeo.com/video/123456789?h=abc123");
      expect(out?.src).not.toContain("autoplay");
    });

    it("treats protocol-relative srcs as https", () => {
      const out = normalizeEmbed("//player.vimeo.com/video/42");
      expect(out?.src).toBe("https://player.vimeo.com/video/42");
    });

    it("rejects non-video paths", () => {
      expect(normalizeEmbed("https://player.vimeo.com/video/abc")).toBeNull();
      expect(normalizeEmbed("https://player.vimeo.com/login")).toBeNull();
    });
  });

  describe("Spotify", () => {
    it("keeps track/album/playlist/episode embeds", () => {
      const out = normalizeEmbed("https://open.spotify.com/embed/track/4cOdK2wGLETKBW3PvgPWqT");
      expect(out?.provider).toBe("Spotify");
      expect(out?.src).toBe("https://open.spotify.com/embed/track/4cOdK2wGLETKBW3PvgPWqT");
    });

    it("supports the embed-podcast path and keeps the theme param", () => {
      const out = normalizeEmbed(
        "https://open.spotify.com/embed-podcast/episode/abc123?theme=0&utm_source=x"
      );
      expect(out?.src).toBe("https://open.spotify.com/embed-podcast/episode/abc123?theme=0");
      expect(out?.src).not.toContain("utm_source");
    });

    it("rejects unknown resource types", () => {
      expect(normalizeEmbed("https://open.spotify.com/embed/user/x")).toBeNull();
    });
  });

  describe("SoundCloud", () => {
    it("keeps the player when url points at SoundCloud, dropping auto_play", () => {
      const out = normalizeEmbed(
        "https://w.soundcloud.com/player/?url=https%3A%2F%2Fapi.soundcloud.com%2Ftracks%2F123&auto_play=true&color=%23ff5500"
      );
      expect(out?.provider).toBe("SoundCloud");
      expect(out?.src).toContain("url=https%3A%2F%2Fapi.soundcloud.com%2Ftracks%2F123");
      expect(out?.src).toContain("color=");
      expect(out?.src).not.toContain("auto_play");
    });

    it("rejects a player whose url points off SoundCloud", () => {
      expect(
        normalizeEmbed("https://w.soundcloud.com/player/?url=https%3A%2F%2Fevil.com%2Fx")
      ).toBeNull();
      expect(normalizeEmbed("https://w.soundcloud.com/player/")).toBeNull();
    });
  });

  describe("Bandcamp", () => {
    it("keeps a validated EmbeddedPlayer path", () => {
      const src =
        "https://bandcamp.com/EmbeddedPlayer/album=123456/size=large/bgcol=ffffff/linkcol=0687f5/transparent=true/";
      const out = normalizeEmbed(src);
      expect(out?.provider).toBe("Bandcamp");
      expect(out?.src).toBe(src);
    });

    it("rejects malformed player paths", () => {
      expect(normalizeEmbed("https://bandcamp.com/EmbeddedPlayer/album=<script>")).toBeNull();
      expect(normalizeEmbed("https://bandcamp.com/login")).toBeNull();
    });
  });

  describe("CodePen", () => {
    it("keeps embed and embed/preview pens", () => {
      expect(normalizeEmbed("https://codepen.io/team/embed/abcDEF")?.provider).toBe("CodePen");
      expect(
        normalizeEmbed("https://codepen.io/team/embed/preview/abcDEF?default-tab=result")?.src
      ).toBe("https://codepen.io/team/embed/preview/abcDEF?default-tab=result");
    });

    it("rejects the non-embed pen page", () => {
      expect(normalizeEmbed("https://codepen.io/team/pen/abcDEF")).toBeNull();
    });
  });

  it("only ever rewrites to a canonical hostname", () => {
    const srcs = [
      "https://www.youtube.com/embed/dQw4w9WgXcQ",
      "https://player.vimeo.com/video/123",
      "https://open.spotify.com/embed/track/abc",
      "https://w.soundcloud.com/player/?url=https%3A%2F%2Fsoundcloud.com%2Fa%2Fb",
      "https://bandcamp.com/EmbeddedPlayer/album=1/size=large/",
      "https://codepen.io/a/embed/b",
    ];
    for (const src of srcs) {
      const out = normalizeEmbed(src);
      expect(out).not.toBeNull();
      const host = new URL(out!.src).hostname;
      expect(EMBED_CANONICAL_HOSTNAMES).toContain(host);
    }
  });

  it("accepts the iframe srcs the YouTube plugin synthesizes (sync guard)", () => {
    // src/server/plugins/youtube.ts builds embeds on the canonical host, so
    // the sanitizer's (Rust) rules must keep accepting them or plugin-made
    // embeds would be stripped on the read path.
    const out = normalizeEmbed("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ");
    expect(out?.provider).toBe("YouTube");
    expect(out?.src).toBe("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ");
  });
});
