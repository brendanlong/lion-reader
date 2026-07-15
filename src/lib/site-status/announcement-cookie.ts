/**
 * Shared announcement-dismissal cookie name.
 *
 * Lives in its own module (NOT `"use client"`) so it can be imported as a real
 * string by both the server (root layout, which reads the cookie) and the client
 * (the banner, which writes it). Importing a value from a `"use client"` module
 * into a server component yields a client-reference proxy, not the string — so
 * the cookie name must not live in the banner component file.
 */
export const ANNOUNCEMENT_DISMISSED_COOKIE = "lion_announcement_dismissed";
