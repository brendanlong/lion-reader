/**
 * HTTP client for tRPC API calls during benchmarks.
 *
 * Handles authentication (login + session cookie) and provides typed
 * helpers for calling tRPC queries and mutations.
 */

import { BASE_URL } from "./server";

export interface BenchmarkClient {
  sessionToken: string;
  baseUrl: string;
}

/**
 * Log in as a user and return a client with the session token.
 */
export async function createClient(email: string, password: string): Promise<BenchmarkClient> {
  const response = await fetch(`${BASE_URL}/api/trpc/auth.login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ json: { email, password } }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Login failed (${response.status}): ${body}`);
  }

  const data = await response.json();
  const sessionToken = data.result?.data?.json?.sessionToken;
  if (!sessionToken) {
    throw new Error(`Login response missing sessionToken: ${JSON.stringify(data)}`);
  }

  return { sessionToken, baseUrl: BASE_URL };
}

/**
 * Execute a tRPC query (GET request).
 */
export async function trpcQuery(
  client: BenchmarkClient,
  procedure: string,
  input?: Record<string, unknown>
): Promise<unknown> {
  const url = new URL(`/api/trpc/${procedure}`, client.baseUrl);
  if (input !== undefined) {
    url.searchParams.set("input", JSON.stringify({ json: input }));
  }

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${client.sessionToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`${procedure} failed: ${response.status}`);
  }

  const data = await response.json();
  return data.result?.data?.json;
}

/**
 * Execute a tRPC mutation (POST request).
 */
export async function trpcMutation(
  client: BenchmarkClient,
  procedure: string,
  input?: Record<string, unknown>
): Promise<unknown> {
  const response = await fetch(`${client.baseUrl}/api/trpc/${procedure}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${client.sessionToken}`,
    },
    body: JSON.stringify({ json: input ?? {} }),
  });

  if (!response.ok) {
    throw new Error(`${procedure} failed: ${response.status}`);
  }

  const data = await response.json();
  return data.result?.data?.json;
}
