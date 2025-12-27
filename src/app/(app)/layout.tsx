/**
 * App Layout
 *
 * Server component wrapper that provides TRPCProvider and forces dynamic rendering.
 * The actual layout UI is in AppLayoutContent.
 */

import { TRPCProvider } from "@/lib/trpc/provider";
import { AppLayoutContent } from "./AppLayoutContent";

// Force dynamic rendering - all app pages require authentication
export const dynamic = "force-dynamic";

interface AppLayoutProps {
  children: React.ReactNode;
}

export default function AppLayout({ children }: AppLayoutProps) {
  return (
    <TRPCProvider>
      <AppLayoutContent>{children}</AppLayoutContent>
    </TRPCProvider>
  );
}
