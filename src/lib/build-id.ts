/**
 * Identifies the deploy a bundle came from. The client and server bundles of
 * one `next build` inline the same value, so a page whose SSE hello reports a
 * different one is running JavaScript from another deploy. Empty when the
 * build wasn't stamped (local dev, a bare `docker build`).
 */
export const BUILD_ID: string = process.env.NEXT_PUBLIC_BUILD_TIME ?? "";

/** Whether the server runs a different build than this page; unknown on either side counts as the same. */
export function isOtherBuild(serverBuildId: string | undefined, clientBuildId: string): boolean {
  return !!serverBuildId && !!clientBuildId && serverBuildId !== clientBuildId;
}
