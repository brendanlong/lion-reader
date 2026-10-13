/**
 * UserEmail Component
 *
 * Displays the current user's email with Suspense streaming support.
 */

"use client";

import { Suspense } from "react";
import { trpc } from "@/lib/trpc/client";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { SkeletonText } from "@/components/ui/skeleton";

/**
 * Inner component that suspends on auth.me query.
 */
function UserEmailContent() {
  const [data] = trpc.auth.me.useSuspenseQuery();
  return <>{data.user.email}</>;
}

/**
 * Skeleton fallback while loading.
 */
function UserEmailSkeleton() {
  return <SkeletonText width="w-full" className="inline-flex w-36 align-top" />;
}

/**
 * User email with built-in Suspense and ErrorBoundary.
 */
export function UserEmail() {
  return (
    <ErrorBoundary fallback={<>...</>}>
      <Suspense fallback={<UserEmailSkeleton />}>
        <UserEmailContent />
      </Suspense>
    </ErrorBoundary>
  );
}
