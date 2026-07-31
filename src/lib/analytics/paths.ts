/**
 * The closed vocabulary of paths we report to analytics.
 *
 * **We never send a real URL.** Every reported path is a constant from the
 * tables below, chosen by matching the route — not derived by sanitizing
 * `location.href`. That distinction is the whole design: a sanitizer is one
 * unanticipated route away from leaking (`/register?invite=<token>` is a
 * one-time signup credential, and entry/subscription/tag ids identify what a
 * specific person reads). With a lookup, an unmapped route reports *nothing*
 * until someone adds it here deliberately — and adding it is the moment to ask
 * whether that route's URL can carry a secret.
 *
 * The query string is never reported at all, so `?entry=<uuid>` cannot escape;
 * an opened entry is reported separately and coarsely, as its **type** only
 * (`analyticsPathForEntry`), so we learn "someone read a newsletter" and never
 * which one.
 *
 * `AnalyticsPath` is derived from the tables, so the union is closed by
 * construction and TypeScript rejects any attempt to report a computed string.
 */

/**
 * Routes with no dynamic segment. Keys are real pathnames, values are what we
 * report. Anything absent is deliberately not counted — including `/admin` and
 * the OAuth/complete-signup plumbing.
 */
const STATIC_ROUTES = {
  // Public
  "/demo": "/demo",
  "/demo/all": "/demo/list",
  "/demo/highlights": "/demo/list",
  "/login": "/login",
  "/register": "/register",
  "/terms": "/terms",
  "/privacy": "/privacy",
  // App — entry lists
  "/all": "/app/list/all",
  "/saved": "/app/list/saved",
  "/starred": "/app/list/starred",
  "/recently-read": "/app/list/recently-read",
  "/uncategorized": "/app/list/uncategorized",
  // App — everything else
  "/subscribe": "/app/subscribe",
  "/settings": "/app/settings",
  "/settings/ai": "/app/settings/ai",
  "/settings/appearance": "/app/settings/appearance",
  "/settings/delete-account": "/app/settings/delete-account",
  "/settings/email": "/app/settings/email",
  "/settings/feed-health": "/app/settings/feed-health",
  "/settings/integrations": "/app/settings/integrations",
  "/settings/sessions": "/app/settings/sessions",
  "/settings/subscriptions": "/app/settings/subscriptions",
} as const;

/**
 * Routes shaped `/<prefix>/<id>`. The id is **dropped** — a subscription or tag
 * id would identify what one person follows.
 */
const ID_ROUTES = {
  subscription: "/app/list/subscription",
  tag: "/app/list/tag",
} as const;

/**
 * Demo articles are dev-authored marketing content in this repo, not user data,
 * so reporting *which* one is read is safe and useful. Still an allowlist, not
 * a pass-through: an id that isn't one of these reports the bare `/demo/entry`.
 *
 * Duplicated from `DEMO_ARTICLES` rather than imported, because importing the
 * registry would pull every article's HTML body into the app bundle. The unit
 * test asserts this list equals the registry, so a new article fails CI here.
 */
const DEMO_ARTICLE_IDS = [
  "ai-summaries",
  "appearance",
  "auth-security",
  "browser-extension",
  "discord-bot",
  "email-newsletters",
  "file-upload",
  "full-content",
  "google-reader-api",
  "json-feed",
  "keyboard-shortcuts",
  "mcp-server",
  "open-source",
  "opml",
  "performance",
  "plugins",
  "pwa",
  "real-time",
  "rss-atom",
  "save-for-later",
  "search",
  "tags",
  "text-to-speech",
  "wallabag-api",
  "websub",
  "welcome",
] as const;

/** Entry types, mirroring the `feed_type` enum. */
export type EntryKind = "web" | "email" | "saved";

export type AnalyticsPath =
  | (typeof STATIC_ROUTES)[keyof typeof STATIC_ROUTES]
  | (typeof ID_ROUTES)[keyof typeof ID_ROUTES]
  | "/demo/entry"
  | `/demo/entry/${(typeof DEMO_ARTICLE_IDS)[number]}`
  | `/app/entry/${EntryKind}`;

const DEMO_ARTICLE_ID_SET: ReadonlySet<string> = new Set(DEMO_ARTICLE_IDS);

/** Exposed for the test that pins the list against the article registry. */
export const demoArticleIds: readonly string[] = DEMO_ARTICLE_IDS;

/**
 * The path to report for a route, or null when the route isn't counted.
 *
 * Takes a pathname only — never the full URL — so there is no code path on
 * which a query string could reach the caller.
 */
export function analyticsPathForRoute(pathname: string): AnalyticsPath | null {
  // Trailing slashes are equivalent to the bare route ("/all/" === "/all").
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;

  // hasOwn, not `in`: `in` walks the prototype chain, so "/constructor" and
  // "/__proto__" would resolve to Object.prototype members and get reported as
  // whatever those stringify to — defeating the closed-union guarantee.
  if (Object.hasOwn(STATIC_ROUTES, path)) {
    return STATIC_ROUTES[path as keyof typeof STATIC_ROUTES];
  }

  // Split rather than startsWith, so "/subscriptions-export" can't match the
  // "/subscription" prefix and report someone else's route.
  const segments = path.split("/").filter(Boolean);

  if (segments.length === 2 && Object.hasOwn(ID_ROUTES, segments[0])) {
    return ID_ROUTES[segments[0] as keyof typeof ID_ROUTES];
  }

  if (segments[0] === "demo" && segments.length === 3) {
    // /demo/entry/<id> is the internal destination of the next.config.ts
    // rewrite, so a browser is normally on /demo/all?entry=<id> and never here
    // — but a direct visit to the rewrite target renders too, and DemoRouter
    // resolves the article from the pathname in that case. Handle both.
    if (segments[1] === "entry") return analyticsPathForDemoEntry(segments[2]);
    if (segments[1] === "subscription" || segments[1] === "tag") return "/demo/list";
  }

  return null;
}

/** The path for an opened demo article, falling back to the bare route. */
export function analyticsPathForDemoEntry(id: string | null | undefined): AnalyticsPath {
  if (id && DEMO_ARTICLE_ID_SET.has(id)) {
    return `/demo/entry/${id as (typeof DEMO_ARTICLE_IDS)[number]}`;
  }
  return "/demo/entry";
}

/**
 * The path for an opened entry in the app: its type, never its id. This is the
 * only thing we ever learn about what a signed-in person reads.
 */
export function analyticsPathForEntry(kind: EntryKind): AnalyticsPath {
  return `/app/entry/${kind}`;
}
