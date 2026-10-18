import type { UrlPlugin } from "./types";

/**
 * Substack plugin: resolves the links in Substack newsletter emails.
 *
 * Emails link the post title to an app deep link
 * (`https://substack.com/app-link/post?publication_id=…&post_id=…`), which
 * can't be turned into a web URL without fetching it, and their "Read in app"
 * button to `https://open.substack.com/pub/{publication}/p/{slug}?…`. Post
 * URLs carry tracking parameters that don't identify the post.
 */
export const substackPlugin: UrlPlugin = {
  name: "substack",
  hosts: ["substack.com", "*.substack.com"],

  matchUrl(url: URL): boolean {
    if (url.hostname === "substack.com") return url.pathname.startsWith("/app-link/");
    return url.hostname === "open.substack.com" || url.pathname.startsWith("/p/");
  },

  capabilities: {
    emailLink: {
      resolve(url: URL): URL | null {
        if (url.hostname === "substack.com") return null;
        return new URL(url.pathname, `https://${url.hostname}`);
      },
    },
  },
};
