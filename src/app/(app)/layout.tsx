/**
 * App Layout
 *
 * Server component wrapper that provides TRPCProvider.
 * The actual layout UI is in AppLayoutContent.
 */

import { TRPCProvider } from "@/lib/trpc/provider";
import { AppLayoutContent } from "./AppLayoutContent";

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
