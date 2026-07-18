/**
 * Save Page Layout
 *
 * Provides TRPCProvider for the bookmarklet save page.
 */

import { TRPCProvider } from "@/lib/trpc/provider";

interface SaveLayoutProps {
  children: React.ReactNode;
}

export default function SaveLayout({ children }: SaveLayoutProps) {
  return <TRPCProvider>{children}</TRPCProvider>;
}
