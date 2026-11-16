/**
 * The entries.list input for the current URL (`entriesListInputFor`).
 */

"use client";

import { useMemo } from "react";
import { useAppPathname, useAppSearchParams } from "./useAppLocation";
import { entriesListInputFor, type EntriesListInput } from "@/lib/queries/entries-list-input";

export function useEntriesListInput(): EntriesListInput {
  const pathname = useAppPathname();
  const searchParams = useAppSearchParams();
  return useMemo(() => entriesListInputFor(pathname, searchParams), [pathname, searchParams]);
}
