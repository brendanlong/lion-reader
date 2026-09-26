"use client";

import { Button } from "@/components/ui/button";
import { SpinnerIcon } from "@/components/ui/icons";

interface AdminQueryFallbackProps {
  query: { isError: boolean; refetch: () => unknown };
  /** What failed to load, e.g. "users". */
  noun: string;
}

/** Loading spinner, or an error message with a Retry button once the query has failed. */
export function AdminQueryFallback({ query, noun }: AdminQueryFallbackProps) {
  if (!query.isError) {
    return (
      <div className="flex items-center justify-center p-8">
        <SpinnerIcon className="text-faint h-6 w-6" />
      </div>
    );
  }
  return (
    <div className="p-8 text-center">
      <p className="ui-text-sm text-danger">{`Failed to load ${noun}. Please try again.`}</p>
      <Button variant="secondary" size="sm" onClick={() => query.refetch()} className="mt-2">
        Retry
      </Button>
    </div>
  );
}
