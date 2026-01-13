/**
 * App Layout
 *
 * Server component wrapper that provides TRPCProvider.
 * The actual layout UI is in AppLayoutContent.
 *
 * Generates an initial sync cursor (server timestamp) that's used for:
 * - SSE catch-up sync on reconnect
 * - Polling sync if SSE is unavailable
 * This ensures no events are missed between page load and SSE connection.
 */

import { TRPCProvider } from "@/lib/trpc/provider";
import { AppLayoutContent } from "./AppLayoutContent";

interface AppLayoutProps {
  children: React.ReactNode;
}

export default function AppLayout({ children }: AppLayoutProps) {
  // Generate initial sync cursor using server time (accurate, no client clock skew)
  const initialSyncCursor = new Date().toISOString();

  return (
    <TRPCProvider>
      <AppLayoutContent initialSyncCursor={initialSyncCursor}>{children}</AppLayoutContent>
    </TRPCProvider>
  );
}
