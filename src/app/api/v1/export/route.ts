/**
 * GET /api/v1/export
 *
 * The account export zip (`services/library-export.ts`), streamed while it's
 * built. A route handler because tRPC can't stream a binary body; the settings
 * page links here directly, so the browser's download manager does the saving.
 *
 * A failure partway through cuts the stream short, which the browser reports as
 * a failed download rather than saving a truncated zip.
 */

import { logger } from "@/lib/logger";
import { authenticateRouteRequest } from "@/server/auth/route-auth";
import { db } from "@/server/db";
import { checkRouteRateLimit } from "@/server/rate-limit";
import { streamLibraryExport } from "@/server/services/library-export";

export async function GET(req: Request): Promise<Response> {
  const auth = await authenticateRouteRequest(req.headers);
  if (!auth) {
    return new Response("Sign in to export your library", { status: 401 });
  }
  if (!auth.confirmed) {
    return new Response("Complete signup before exporting", { status: 403 });
  }

  const rateLimited = await checkRouteRateLimit(req, "libraryExport", { userId: auth.userId });
  if (rateLimited) return rateLimited;

  const exportedAt = new Date();
  const { userId } = auth;
  const chunks = streamLibraryExport(db, userId, exportedAt);
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await chunks.next();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (error) {
        logger.error("Library export failed", {
          userId,
          error: error instanceof Error ? error.message : String(error),
        });
        controller.error(error);
      }
    },
    async cancel() {
      await chunks.return(undefined);
    },
  });

  const filename = `lion-reader-export-${exportedAt.toISOString().slice(0, 10)}.zip`;
  return new Response(body, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
