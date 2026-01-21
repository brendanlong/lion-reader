/**
 * Test utilities for React component testing.
 *
 * Provides wrappers and helpers for testing components that use React Query.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  render,
  renderHook,
  type RenderOptions,
  type RenderHookOptions,
} from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";

/**
 * Creates a QueryClient configured for testing.
 * Disables retries and sets short cache times for fast tests.
 */
export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: 0,
        staleTime: 0,
      },
      mutations: {
        retry: false,
      },
    },
  });
}

interface TestProvidersProps {
  children: ReactNode;
  queryClient?: QueryClient;
}

/**
 * Wraps children with all necessary providers for testing.
 */
function TestProviders({ children, queryClient }: TestProvidersProps): ReactElement {
  const client = queryClient ?? createTestQueryClient();
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

type CustomRenderOptions = Omit<RenderOptions, "wrapper"> & {
  queryClient?: QueryClient;
};

/**
 * Renders a component with all necessary providers for testing.
 *
 * @example
 * ```tsx
 * const { getByText } = renderWithProviders(<MyComponent />);
 * expect(getByText("Hello")).toBeInTheDocument();
 * ```
 */
export function renderWithProviders(ui: ReactElement, options: CustomRenderOptions = {}) {
  const { queryClient, ...renderOptions } = options;

  function Wrapper({ children }: { children: ReactNode }) {
    return <TestProviders queryClient={queryClient}>{children}</TestProviders>;
  }

  return render(ui, { wrapper: Wrapper, ...renderOptions });
}

type CustomRenderHookOptions<TProps> = Omit<RenderHookOptions<TProps>, "wrapper"> & {
  queryClient?: QueryClient;
};

/**
 * Renders a hook with all necessary providers for testing.
 *
 * @example
 * ```tsx
 * const { result } = renderHookWithProviders(() => useMyHook());
 * expect(result.current.value).toBe(expected);
 * ```
 */
export function renderHookWithProviders<TResult, TProps>(
  hook: (props: TProps) => TResult,
  options: CustomRenderHookOptions<TProps> = {}
) {
  const { queryClient, ...renderOptions } = options;

  function Wrapper({ children }: { children: ReactNode }) {
    return <TestProviders queryClient={queryClient}>{children}</TestProviders>;
  }

  return renderHook(hook, { wrapper: Wrapper, ...renderOptions });
}

// Re-export everything from testing-library for convenience
export * from "@testing-library/react";
export { default as userEvent } from "@testing-library/user-event";
