import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * The repo's root package.json is `"type": "module"`, but the esbuild bundles
 * (server/worker/migrate/discord-bot) are emitted as CommonJS. Without a marker,
 * Node would read `dist/*.js` as ESM (inheriting the root type) and refuse to
 * run them. Drop a `dist/package.json` scoping the output dir back to CommonJS
 * so `node dist/server.js` (fly.toml, Dockerfile, `pnpm start`) keeps working.
 *
 * Called by every build-*.mjs after esbuild writes its outfile, so the marker
 * exists whether the bundles are built together (`build:all`) or individually
 * (CI's e2e job builds only the server).
 */
export function writeDistCjsMarker(distDir) {
  mkdirSync(distDir, { recursive: true });
  writeFileSync(
    join(distDir, "package.json"),
    JSON.stringify({ type: "commonjs" }, null, 2) + "\n"
  );
}
