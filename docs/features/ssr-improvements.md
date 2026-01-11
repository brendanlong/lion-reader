# SSR/RSC Improvements

## Problem Statement

Currently, all data-fetching pages in the app use `'use client'` and fetch data via tRPC on the client side. This means:

- **No initial HTML content** - Pages render as empty shells until JavaScript loads and data fetches complete
- **No server-side caching benefits** - Every page load requires fresh client-side data fetching
- **Slower perceived performance** - Users see loading spinners instead of content
- **Worse SEO** (if applicable) - Search engines see empty shells

### Intentional Exceptions (No Changes Needed)

- **Webhook routes** - Correctly use `export const dynamic = 'force-dynamic'` since they must process fresh incoming data
- **piper-tts-web** - Uses `dynamic()` with `ssr: false` due to Node.js code in the library that breaks client bundling. The current workaround (webpack/turbopack config to stub `fs` and `path`) is functional.

## Solution

### 1. Auth Proxy

Next.js 16 uses `proxy.ts` (replacing the deprecated `middleware.ts`) to check authentication before pages render. This provides:

- Faster redirects for unauthenticated users (no need to load app shell)
- Consistent auth checking across all protected routes

**Implementation:** `src/proxy.ts`

```typescript
// src/proxy.ts
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const PUBLIC_PATHS = [
  "/",
  "/login",
  "/register",
  "/auth/oauth/callback",
  "/auth/oauth/complete",
  "/api/",
  "/_next/",
  "/extension/",
  "/favicon.ico",
];

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Allow public paths
  if (PUBLIC_PATHS.some((path) => pathname.startsWith(path) || pathname === path)) {
    return NextResponse.next();
  }

  // Check for session cookie
  const session = request.cookies.get("session");
  if (!session?.value) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("redirect", pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
```

### 2. Server-Side Data Prefetching

Use tRPC's server-side calling pattern with React Query's hydration to prefetch data on the server and pass it to the client.

**Infrastructure:** `src/lib/trpc/server.ts`

- `createServerQueryClient()` - Query client for server use
- `createServerCaller()` - tRPC caller with server context

**Page Pattern:**

```typescript
// Server component (page.tsx)
import { dehydrate } from "@tanstack/react-query";
import { createServerQueryClient, createServerCaller } from "@/lib/trpc/server";
import { HydrationBoundary } from "@/lib/trpc/provider";
import { AllEntriesClient } from "./client";

export default async function AllEntriesPage({ searchParams }) {
  const params = await searchParams;
  const unreadOnly = params.unreadOnly !== "false"; // default true
  const sortOrder = params.sort === "oldest" ? "oldest" : "newest";

  const queryClient = createServerQueryClient();
  const { caller, session } = await createServerCaller();

  if (session) {
    await queryClient.prefetchInfiniteQuery({
      queryKey: [
        ["entries", "list"],
        { input: { unreadOnly, sortOrder, limit: 20 }, type: "infinite" },
      ],
      queryFn: () => caller.entries.list({ unreadOnly, sortOrder, limit: 20 }),
      initialPageParam: undefined,
    });
  }

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <AllEntriesClient />
    </HydrationBoundary>
  );
}
```

### 3. URL-Based View Preferences

View preferences (unreadOnly, sortOrder) are synced to URL query params:

- `/all?unreadOnly=false&sort=oldest` - Show all entries, oldest first
- `/starred?sort=newest` - Show unread starred entries (default), newest first

This enables:

- Server-side prefetching with correct filters
- Shareable/bookmarkable filtered views
- Browser back/forward navigation through filter changes

## Implementation Status

### Completed

- [x] Auth proxy (`src/proxy.ts`)
- [x] Server-side prefetching infrastructure (`src/lib/trpc/server.ts`)
- [x] `/all` page conversion
- [x] `/feed/[feedId]` page conversion
- [x] `/tag/[tagId]` page conversion
- [x] `/starred` page conversion
- [x] `/saved` page conversion

### Not Converting (Intentionally)

- `/subscribe` - All queries are manually triggered by user input
- Settings pages - Lower priority, complex state management

## Files Modified

### Infrastructure

- `src/proxy.ts` - Auth proxy for early redirect
- `src/lib/trpc/server.ts` - Server-side tRPC utilities
- `src/lib/trpc/provider.tsx` - Re-exports HydrationBoundary

### Pages

- `src/app/(app)/all/page.tsx` + `client.tsx`
- `src/app/(app)/feed/[feedId]/page.tsx` + `client.tsx`
- `src/app/(app)/tag/[tagId]/page.tsx` + `client.tsx`
- `src/app/(app)/starred/page.tsx` + `client.tsx`
- `src/app/(app)/saved/page.tsx` + `client.tsx`

## Testing Plan

1. **Auth proxy**: Test login/logout flows, redirect preservation
2. **Hydration**: Verify data appears immediately without loading spinners
3. **Client interaction**: Verify mutations, pagination, and other interactions work after hydration
4. **Error handling**: Test behavior when server prefetch fails
5. **URL params**: Verify filter changes update URL and vice versa

## Rollback Plan

Each phase is independent:

- Proxy can be removed if issues arise
- Pages can be reverted to client-only individually
- No database changes required
