# Frontend Testing Plan

This document outlines the strategy for adding frontend tests to Lion Reader.

## Overview

The codebase already follows good patterns for testability:

1. **Business logic is extracted** into hooks (`useEntryMutations`, `useKeyboardShortcuts`) and cache operations (`src/lib/cache/`)
2. **Components are mostly presentational** - data flows through props and callbacks
3. **UI components are pure** - no data fetching, just props

This means we can add tests incrementally without major refactoring.

## Testing Layers

### Layer 1: Pure Utilities (No mocks needed)

**Location**: `tests/unit/frontend/`

Functions that have no React or external dependencies:

| File                                       | Functions                         | Priority |
| ------------------------------------------ | --------------------------------- | -------- |
| `src/lib/format.ts`                        | `formatRelativeTime`, `getDomain` | High     |
| `src/components/entries/EntryListItem.tsx` | `getItemClasses`                  | Medium   |

**Example test**:

```typescript
import { formatRelativeTime } from "@/lib/format";

describe("formatRelativeTime", () => {
  it("returns 'just now' for recent times", () => {
    const now = new Date();
    expect(formatRelativeTime(now)).toBe("just now");
  });
});
```

### Layer 2: Cache Operations (Mock tRPC utils)

**Location**: `tests/unit/frontend/cache/`

The cache operations in `src/lib/cache/operations.ts` are pure functions that take `TRPCClientUtils` and perform cache updates. These are critical for correctness.

| Function                    | What it does                                          |
| --------------------------- | ----------------------------------------------------- |
| `handleEntriesMarkedRead`   | Updates 6+ caches when entries are marked read/unread |
| `handleEntryStarred`        | Updates caches when entry is starred                  |
| `handleEntryUnstarred`      | Updates caches when entry is unstarred                |
| `handleSubscriptionCreated` | Adds subscription to cache                            |
| `handleSubscriptionDeleted` | Removes subscription from cache                       |
| `handleNewEntry`            | Updates counts when SSE delivers new entry            |

**Testing approach**: Create mock `TRPCClientUtils` that tracks cache mutations.

### Layer 3: UI Components (React Testing Library)

**Location**: `tests/unit/frontend/components/`

Pure presentational components that take props and render UI.

| Component       | Test focus                                    |
| --------------- | --------------------------------------------- |
| `Button`        | Variants, loading state, disabled state       |
| `Alert`         | Variants (error, success, warning, info)      |
| `Card`          | Renders children                              |
| `Dialog`        | Open/close, focus trap, escape key            |
| `Input`         | Label, error state, disabled state            |
| `EntryListItem` | Read/unread styling, callbacks fire correctly |
| `SortToggle`    | Toggle callback                               |
| `UnreadToggle`  | Toggle callback                               |

**Testing approach**: Use React Testing Library to render and assert.

### Layer 4: Hooks with React Query (QueryClient wrapper)

**Location**: `tests/unit/frontend/hooks/`

Hooks that use React Query need a test wrapper with `QueryClientProvider`.

| Hook                   | Complexity | Test focus                                 |
| ---------------------- | ---------- | ------------------------------------------ |
| `useEntryMutations`    | Medium     | Mutations trigger correct cache operations |
| `useKeyboardShortcuts` | Medium     | Keyboard navigation, entry selection       |
| `useNarrationSettings` | Low        | localStorage persistence                   |

**Testing approach**: Use `renderHook` with a custom wrapper that provides test `QueryClient`.

### Layer 5: Components with tRPC Queries (MSW or mock client)

**Location**: `tests/integration/frontend/`

Components that embed tRPC queries/mutations.

| Component                | Queries/Mutations                            |
| ------------------------ | -------------------------------------------- |
| `EntryContent`           | `entries.get`                                |
| `EditSubscriptionDialog` | `tags.list`, `subscriptions.update`          |
| `Sidebar`                | `subscriptions.list`, `subscriptions.delete` |

**Testing approach**: Mock tRPC at the client level or use MSW for network mocking.

## Test Infrastructure

### Required Dependencies

```bash
pnpm add -D @testing-library/react @testing-library/dom jsdom
```

### Vitest Configuration

The vitest config includes the setup file for jest-dom matchers. The jsdom environment is
specified per-file using the `@vitest-environment` directive (Vitest 4.x removed global environment matching).

```typescript
// vitest.config.ts - already configured
import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    pool: "threads",
    fileParallelism: false,
    setupFiles: ["./tests/setup.ts"],
  },
});
```

### Specifying jsdom Environment

Add this comment at the top of any test file that needs DOM APIs (React components, hooks with DOM):

```typescript
/**
 * @vitest-environment jsdom
 */

// Your test imports and code...
```

Pure function tests (like `format.test.ts` and `cache/operations.test.ts`) don't need jsdom.

### Test Utilities

Create `tests/utils/react.tsx`:

```typescript
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, type RenderOptions } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";

function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function TestProviders({ children }: { children: ReactNode }) {
  const queryClient = createTestQueryClient();
  return (
    <QueryClientProvider client={queryClient}>
      {children}
    </QueryClientProvider>
  );
}

export function renderWithProviders(
  ui: ReactElement,
  options?: Omit<RenderOptions, "wrapper">
) {
  return render(ui, { wrapper: TestProviders, ...options });
}

export * from "@testing-library/react";
```

## Implementation Priority

### Phase 1: Foundation (Issues #1-2)

1. Add testing dependencies
2. Set up vitest config for jsdom
3. Create test utilities

### Phase 2: Pure Functions (Issue #3)

1. `formatRelativeTime` tests
2. `getDomain` tests
3. `getItemClasses` tests

### Phase 3: Cache Operations (Issue #4)

1. Create mock `TRPCClientUtils`
2. Test `handleEntriesMarkedRead`
3. Test `handleEntryStarred`/`handleEntryUnstarred`
4. Test `handleNewEntry`

### Phase 4: UI Components (Issue #5)

1. `Button` component tests
2. `Alert` component tests
3. `EntryListItem` component tests

### Phase 5: Hooks (Issue #6)

1. `useEntryMutations` tests
2. `useNarrationSettings` tests

### Phase 6: Integration (Issue #7)

1. Set up MSW or mock tRPC client
2. Test `EntryContent` with mock data
3. Test `Sidebar` with mock subscriptions

## Guidelines

### Do

- Test behavior, not implementation
- Use data-testid sparingly (prefer accessible queries)
- Test edge cases (empty states, error states, loading states)
- Keep tests focused on one behavior

### Don't

- Mock internal implementation details
- Test React/library internals
- Write tests that duplicate component code
- Create overly broad integration tests

## File Structure

```
tests/
  unit/
    frontend/
      format.test.ts           # Pure utility tests
      cache/
        operations.test.ts     # Cache operation tests
      components/
        Button.test.tsx        # UI component tests
        EntryListItem.test.tsx
      hooks/
        useEntryMutations.test.tsx
  integration/
    frontend/
      EntryContent.test.tsx    # Components with queries
  utils/
    react.tsx                  # Test utilities
```

## Running Tests

```bash
# Run all tests
pnpm test

# Run only frontend unit tests
pnpm test tests/unit/frontend

# Run specific test file
pnpm test tests/unit/frontend/format.test.ts
```
