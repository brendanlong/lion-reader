/**
 * E2E tests for the security response headers, in particular the nonce-based
 * Content-Security-Policy set by src/proxy.ts (issue #1275).
 *
 * The CSP is the XSS backstop behind the server-side sanitizer: a `<script>`
 * or inline event handler that survives a sanitizer regression must be blocked
 * by the browser. These tests pin:
 *
 * - the policy shape (nonce'd `script-src` with `'strict-dynamic'`,
 *   `default-src 'self'`, the baseline directives), with a fresh nonce per
 *   request that matches the inline scripts' `nonce` attributes;
 * - that injected markup with an inline event handler does NOT execute (the
 *   parser-inserted markup-injection vector CSP is here to stop);
 * - that a normally loaded app page produces no CSP violations (the app's own
 *   inline scripts, styles, and chunk loading all satisfy the policy).
 *
 * Known coverage gaps (policy allows these, but the e2e env never exercises
 * them): Sentry Session Replay (prod-DSN only; needs `worker-src blob:` +
 * the same-origin `/monitoring` tunnel) and the TTS narration downloads
 * (Hugging Face voice models via `*.hf.co` redirect hops, jsdelivr wasm).
 */

import { test, expect } from "@playwright/test";
import {
  getDb,
  createConfirmedUser,
  createSubscribedFeed,
  createUnreadEntry,
  loginAs,
  closeTestConnections,
} from "./helpers";

test.afterAll(async () => {
  await closeTestConnections();
});

/** Extracts the script-src nonce from a Content-Security-Policy header value. */
function extractNonce(csp: string): string | null {
  const match = csp.match(/script-src[^;]*'nonce-([A-Za-z0-9+/_=-]+)'/);
  return match ? match[1] : null;
}

test("HTML responses carry a nonce'd CSP that matches the inline scripts", async ({ request }) => {
  const response = await request.get("/login");
  expect(response.status()).toBe(200);

  const csp = response.headers()["content-security-policy"];
  expect(csp).toBeTruthy();

  // Policy shape: locked-down script-src plus the baseline directives.
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("'strict-dynamic'");
  expect(csp).toContain("object-src 'none'");
  expect(csp).toContain("base-uri 'self'");
  expect(csp).toContain("frame-ancestors 'none'");
  // No blanket inline-script escape hatch in script-src.
  expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);

  const nonce = extractNonce(csp);
  expect(nonce).toBeTruthy();

  // The app's inline scripts must carry the same nonce or the browser blocks
  // them. Check the raw HTML (browsers hide the nonce content attribute from
  // the DOM once parsed).
  const html = await response.text();
  expect(html).toContain(`nonce="${nonce}"`);
});

test("each request gets a fresh nonce", async ({ request }) => {
  const first = await request.get("/login");
  const second = await request.get("/login");
  const firstNonce = extractNonce(first.headers()["content-security-policy"] ?? "");
  const secondNonce = extractNonce(second.headers()["content-security-policy"] ?? "");
  expect(firstNonce).toBeTruthy();
  expect(secondNonce).toBeTruthy();
  expect(firstNonce).not.toBe(secondNonce);
});

test("injected inline event handlers are blocked by the CSP", async ({ page }) => {
  await page.goto("/login");

  const result = await page.evaluate(async () => {
    const violations: string[] = [];
    document.addEventListener("securitypolicyviolation", (e) => {
      violations.push(e.violatedDirective);
    });

    // Simulate a sanitizer bypass: markup with an inline event handler landing
    // in the DOM (the dangerouslySetInnerHTML injection shape). The handler
    // fires on error of a broken image; with a nonce-only script-src it must
    // never run. (A plain <script> inserted via innerHTML never executes per
    // the HTML spec regardless of CSP, so the handler is the testable vector.)
    interface PwnedWindow extends Window {
      __cspPwned?: boolean;
    }
    const container = document.createElement("div");
    container.innerHTML = '<img src="/nonexistent-image-404.png" onerror="window.__cspPwned=true">';
    document.body.appendChild(container);

    // Give the image time to fail and the (blocked) handler time to fire.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    return {
      pwned: (window as PwnedWindow).__cspPwned === true,
      violations,
    };
  });

  expect(result.pwned).toBe(false);
  expect(result.violations).toContain("script-src-attr");
});

test("a logged-in app page loads with zero CSP violations", async ({ page, baseURL }) => {
  const db = getDb();
  const user = await createConfirmedUser(db);
  const feed = await createSubscribedFeed(db, user.id);
  await createUnreadEntry(db, {
    feedId: feed.feedId,
    userId: user.id,
    title: "CSP smoke-test entry",
  });
  await loginAs(page.context(), user, baseURL!);

  const violations: string[] = [];
  await page.exposeFunction("__reportCspViolation", (report: string) => {
    violations.push(report);
  });
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) => {
      (
        window as Window & {
          __reportCspViolation?: (report: string) => void;
        }
      ).__reportCspViolation?.(
        `${e.violatedDirective}: ${e.blockedURI} (source: ${e.sourceFile}:${e.lineNumber}, sample: ${e.sample})`
      );
    });
  });

  // The main app shell: SSR inline scripts, theme script, chunk loading, tRPC
  // and SSE connections all have to satisfy the policy.
  await page.goto("/all");
  await expect(page.getByRole("main")).toBeVisible();
  await expect(page.getByRole("heading", { name: "CSP smoke-test entry" })).toBeVisible();
  // Let hydration, the SSE connection, and lazy chunks settle. (Can't use
  // waitForLoadState("networkidle") — the persistent SSE stream means the
  // network never goes idle.)
  await page.waitForTimeout(3000);

  // Zod 4 probes for eval support with `new Function("")` in a try/catch
  // (`allowsEval` in zod/v4/core/util.js) and cleanly falls back to its
  // non-JIT validation path when the CSP blocks it — correct behavior for us,
  // but the blocked probe still fires a one-time report-only violation event.
  // Filter that known-benign probe; anything else is a real policy gap.
  const unexpected = violations.filter((v) => !v.startsWith("script-src: eval ("));
  expect(unexpected).toEqual([]);
});
