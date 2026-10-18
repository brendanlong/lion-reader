/**
 * OAuth client resolution: the built-in app client, registered clients, and
 * Client ID Metadata Document (CIMD) clients, whose documents are fetched and
 * cached here.
 */

import { eq } from "drizzle-orm";
import { db } from "@/server/db";
import { oauthClients } from "@/server/db/schema";
import { parseScopes } from "./utils";
import { APP_CLIENT_ID, getAppClient } from "./app-client";
import { logger } from "@/lib/logger";
import { USER_AGENT } from "@/server/http/user-agent";
import { fetchWithSsrfProtection } from "@/server/http/ssrf";
import { readResponseBufferWithSizeLimit } from "@/server/http/fetch";
import {
  isValidClientIdMetadataUrl,
  validateClientMetadataDocument,
  selectClientMetadata,
  type CimdFetchOutcome,
  type ClientMetadata,
} from "./cimd";

/**
 * Resolved client information (from DB or CIMD)
 */
export interface ResolvedClient {
  clientId: string;
  name: string;
  redirectUris: string[];
  grantTypes: string[];
  scopes: string[] | null;
  isPublic: boolean;
  clientSecretHash: string | null;
  fromDatabase: boolean;
}

/**
 * Resolves a client by ID: the built-in app client, then the database, then a
 * CIMD fetch if the ID is a URL.
 */
export async function resolveClient(clientId: string): Promise<ResolvedClient | null> {
  if (clientId === APP_CLIENT_ID) {
    return getAppClient();
  }

  // Then try the database
  const dbClient = await db
    .select()
    .from(oauthClients)
    .where(eq(oauthClients.clientId, clientId))
    .limit(1);

  if (dbClient.length > 0) {
    const client = dbClient[0];
    return {
      clientId: client.clientId,
      name: client.name,
      redirectUris: client.redirectUris,
      grantTypes: client.grantTypes,
      scopes: client.scopes,
      isPublic: client.isPublic,
      clientSecretHash: client.clientSecretHash,
      fromDatabase: true,
    };
  }

  if (isValidClientIdMetadataUrl(clientId)) {
    const metadata = await fetchClientMetadata(clientId);
    if (metadata) {
      return {
        clientId: metadata.client_id,
        name: metadata.client_name ?? "Unknown Application",
        // redirectUris is a security allowlist and cached/pinned metadata is
        // shared by reference — hand out copies.
        redirectUris: [...metadata.redirect_uris],
        grantTypes: metadata.grant_types
          ? [...metadata.grant_types]
          : ["authorization_code", "refresh_token"],
        // parseScopes drops unrecognized scopes (same policy as DCR). A
        // document offering only unknown scopes yields [] — fails closed with
        // invalid_scope — never null, which would mean "no restriction".
        scopes: metadata.scope !== undefined ? parseScopes(metadata.scope) : null,
        isPublic: true, // CIMD clients are always public
        clientSecretHash: null,
        fromDatabase: false,
      };
    }
  }

  return null;
}

/**
 * Timeout for Client ID Metadata Document fetches (10 seconds).
 */
const CLIENT_METADATA_TIMEOUT_MS = 10000;

/**
 * Maximum Client ID Metadata Document size. The spec recommends documents stay
 * under ~5 KB; 16 KiB is generous headroom while bounding what one cache entry
 * can retain of attacker-supplied bytes.
 */
const CLIENT_METADATA_MAX_BYTES = 16 * 1024;

/**
 * CIMD resolution results are cached in-process — claude.ai re-runs discovery
 * on every connect, and each authorize + consent + token round trip would
 * otherwise refetch the same document three times. Successes cache for 5
 * minutes (matching the `max-age=300` Anthropic serves). Failures cache as
 * `null` for 60 seconds — NOT as a document (the spec forbids caching
 * errors/invalid documents as metadata), but as a short negative entry so an
 * unauthenticated attacker hammering /oauth/authorize with a failing URL
 * client_id can't turn us into a fetch amplifier against a third party. (A
 * transport failure that falls back to a pin caches the pin, under the
 * positive TTL.)
 *
 * The cache is capped because client_id URLs are attacker-suppliable via
 * unauthenticated requests; eviction deletes-before-set so refreshing a hot
 * key (claude.ai's document) moves it to the back of the FIFO instead of
 * leaving it permanently first in line for eviction.
 */
const CLIENT_METADATA_CACHE_TTL_MS = 5 * 60 * 1000;
const CLIENT_METADATA_NEGATIVE_TTL_MS = 60 * 1000;
const CLIENT_METADATA_CACHE_MAX_ENTRIES = 100;
const clientMetadataCache = new Map<
  string,
  { metadata: ClientMetadata | null; expiresAt: number }
>();

function cacheClientMetadata(url: string, metadata: ClientMetadata | null): void {
  clientMetadataCache.delete(url);
  if (clientMetadataCache.size >= CLIENT_METADATA_CACHE_MAX_ENTRIES) {
    const oldest = clientMetadataCache.keys().next().value;
    if (oldest !== undefined) clientMetadataCache.delete(oldest);
  }
  clientMetadataCache.set(url, {
    metadata,
    expiresAt:
      Date.now() + (metadata ? CLIENT_METADATA_CACHE_TTL_MS : CLIENT_METADATA_NEGATIVE_TTL_MS),
  });
}

/**
 * Resolves a Client ID Metadata Document for `url`: cache → live fetch →
 * pinned fallback (`selectClientMetadata`).
 */
async function fetchClientMetadata(url: string): Promise<ClientMetadata | null> {
  const cached = clientMetadataCache.get(url);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.metadata;
  }

  const outcome = await fetchClientMetadataLive(url);
  const metadata = selectClientMetadata(url, outcome);
  if (outcome.kind !== "ok") {
    logger.warn("CIMD client metadata fetch did not return a usable document", {
      url,
      kind: outcome.kind,
      usingPinnedFallback: metadata !== null,
    });
  }
  cacheClientMetadata(url, metadata);
  return metadata;
}

/**
 * The URL is an arbitrary client_id reachable via unauthenticated
 * /oauth/authorize requests, so the fetch is SSRF-protected, time- and
 * size-limited — and **never follows redirects**: the document ↔ client_id
 * binding is a string comparison against the URL we resolved, so an open
 * redirect on any trusted HTTPS host could otherwise serve an attacker's
 * document while the consent screen displays the trusted hostname.
 */
async function fetchClientMetadataLive(url: string): Promise<CimdFetchOutcome> {
  let response: Response;
  try {
    response = await fetchWithSsrfProtection(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": USER_AGENT,
      },
      redirect: "manual",
      signal: AbortSignal.timeout(CLIENT_METADATA_TIMEOUT_MS),
    });
  } catch {
    return { kind: "transport-failure" };
  }

  // 404/410 = the origin withdrawing the document; any other non-2xx is not
  // authoritative.
  if (response.status === 404 || response.status === 410) {
    return { kind: "rejected" };
  }
  if (!response.ok) {
    return { kind: "transport-failure" };
  }

  let parsed: unknown;
  try {
    const body = await readResponseBufferWithSizeLimit(response, CLIENT_METADATA_MAX_BYTES, url);
    parsed = JSON.parse(body.toString());
  } catch {
    // Unreadable or non-JSON body (e.g. a challenge page served with a 200).
    return { kind: "transport-failure" };
  }

  const metadata = validateClientMetadataDocument(url, parsed);
  return metadata ? { kind: "ok", metadata } : { kind: "rejected" };
}
