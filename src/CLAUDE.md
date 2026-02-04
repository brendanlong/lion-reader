# Source Code Guidelines

- Use Suspense and useSuspenseQuery with appropriate fallbacks and well-factored components with small suspense boundaries unless you have a good reason not to

## Frontend State Management

When working on queries, mutations, or cache invalidation, read and update:

**@src/FRONTEND_STATE.md**

This document lists all tRPC queries and mutations, their invalidation patterns, and how they interact across components. It must be kept in sync when:

- Adding new queries or mutations
- Changing cache invalidation patterns
- Adding optimistic updates or direct cache updates
- Modifying SSE event handling

The goal is to maintain cache consistency across the app. All mutations should properly invalidate related queries so the UI stays in sync with the server.
