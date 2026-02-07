/**
 * Demo Layout
 *
 * Server component that provides SEO metadata for the demo route hierarchy.
 * No auth check — demo is accessible to everyone.
 */

import { type ReactNode } from "react";
import { type Metadata } from "next";
import { DemoLayoutContent } from "./DemoLayoutContent";

export const metadata: Metadata = {
  title: "Lion Reader Demo",
  description:
    "Explore Lion Reader's features with this interactive demo. A modern, fast, and open-source feed reader.",
};

export default function DemoLayout({ children }: { children: ReactNode }) {
  return <DemoLayoutContent>{children}</DemoLayoutContent>;
}
