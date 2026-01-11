# SSR/RSC Improvements

## Problem Statement

Currently, all data-fetching pages in the app use `'use client'` and fetch data via tRPC on the client side. This means:

- **No initial HTML content** - Pages render as empty shells until JavaScript loads and data fetches complete
- **No server-side caching benefits** - Every page load requires fresh client-side data fetching
- **Slower perceived performance** - Users see loading spinners instead of content
- **Worse SEO** (if applicable) - Search engines see empty shells

### Current State

- **17 of 17 data-fetching pages** use `'use client'` and client-side tRPC queries
- **No auth middleware** - Authentication is checked client-side via tRPC, meaning unauthenticated users load the full app shell before being redirected
- **Good example exists** - `/extension/save/page.tsx` demonstrates proper server-side auth, data fetching, and redirects

### Intentional Exceptions (No Changes Needed)

- **Webhook routes** - Correctly use `export const dynamic = 'force-dynamic'` since they must process fresh incoming data
- **piper-tts-web** - Uses `dynamic()` with `ssr: false` due to Node.js code in the library that breaks client bundling. The current workaround (webpack/turbopack config to stub `fs` and `path`) is functional.

## Solution

### 1. Auth Middleware

Add Next.js middleware to check authentication before pages render. This provides:

- Faster redirects for unauthenticated users (no need to load app shell)
- Consistent auth checking across all protected routes

**Implementation:**

```typescript
// src/middleware.ts
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
  "/favicon.ico",
];

export function middleware(request: NextRequest) {
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

**Infrastructure needed:**

1. **Server-side query client factory** - Create query clients that can be used in server components
2. **Hydration wrapper** - Dehydrate server state and pass to client
3. **Page pattern** - Server component fetches data, client component receives hydrated state

**Pattern:**

```typescript
// Server component (page.tsx)
import { createServerQueryClient, createServerCaller } from '@/lib/trpc/server';
import { HydrationBoundary, dehydrate } from '@tanstack/react-query';
import { AllPageClient } from './client';

export default async function AllPage() {
  const queryClient = createServerQueryClient();
  const caller = await createServerCaller();

  // Prefetch data
  await queryClient.prefetchInfiniteQuery({
    queryKey: [['entries', 'list'], { type: 'query', input: { feedId: undefined } }],
    queryFn: () => caller.entries.list({ feedId: undefined }),
    initialPageParam: undefined,
  });

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <AllPageClient />
    </HydrationBoundary>
  );
}

// Client component (client.tsx)
'use client';
// ... existing client code, useQuery calls will use hydrated data
```

## Implementation Plan

### Phase 1: Auth Middleware (Low Risk)

1. Create `src/middleware.ts` with session cookie checking
2. Test that protected routes redirect to login
3. Test that public routes remain accessible
4. Test that login redirect preserves the original URL

### Phase 2: Prefetching Infrastructure

1. Create `src/lib/trpc/server.ts` with:
   - `createServerQueryClient()` - Query client for server use
   - `createServerCaller()` - tRPC caller with server context
2. Update `TRPCProvider` to accept initial dehydrated state
3. Create helper utilities for common prefetch patterns

### Phase 3: Migrate Pages (Incremental)

Convert pages one at a time, starting with highest-traffic pages:

1. `/all` - Main entry list (most used)
2. `/feed/[feedId]` - Single feed view
3. `/tag/[tagId]` - Tag view
4. `/starred` - Starred entries
5. `/saved` - Saved articles
6. Settings pages (lower priority)

Each page conversion:

1. Create server component wrapper
2. Move existing code to `client.tsx`
3. Add prefetch calls for main data queries
4. Test hydration works correctly

## Files to Modify

### Phase 1

- `src/middleware.ts` (new)

### Phase 2

- `src/lib/trpc/server.ts` (new)
- `src/lib/trpc/provider.tsx` (update for hydration)

### Phase 3

- `src/app/(app)/all/page.tsx` → server wrapper + `client.tsx`
- `src/app/(app)/feed/[feedId]/page.tsx` → server wrapper + `client.tsx`
- `src/app/(app)/tag/[tagId]/page.tsx` → server wrapper + `client.tsx`
- `src/app/(app)/starred/page.tsx` → server wrapper + `client.tsx`
- `src/app/(app)/saved/page.tsx` → server wrapper + `client.tsx`
- `src/app/(app)/subscribe/page.tsx` → server wrapper + `client.tsx`

## Testing Plan

1. **Auth middleware**: Test login/logout flows, redirect preservation
2. **Hydration**: Verify data appears immediately without loading spinners
3. **Client interaction**: Verify mutations, pagination, and other interactions work after hydration
4. **Error handling**: Test behavior when server prefetch fails

## Rollback Plan

Each phase is independent:

- Middleware can be removed if issues arise
- Pages can be reverted to client-only individually
- No database changes required
