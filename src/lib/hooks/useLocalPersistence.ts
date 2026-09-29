/**
 * Local persistence of the entry store (see "Local Persistence" in
 * src/FRONTEND_STATE.md): a per-device setting, off by default, that the
 * operator can override with LOCAL_PERSISTENCE_DISABLED.
 */

"use client";

import { createContext, createElement, useContext, useEffect, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { trpc } from "@/lib/trpc/client";
import { createStoredBoolean } from "@/lib/stored-boolean";
import { useIsHydrated } from "@/lib/hooks/useIsHydrated";
import { attachLocalPersistence, getLocalDb } from "@/lib/local-db/local-db";
import {
  deleteLocalPersistence,
  isLocalPersistenceSupported,
  openLocalPersistence,
} from "@/lib/local-db/persistence";

const setting = createStoredBoolean("lion-reader:local-persistence", false);

/** Whether the operator allows local persistence (false = kill switch on). */
const AllowedContext = createContext(false);

export function LocalPersistenceProvider({
  allowed,
  children,
}: {
  allowed: boolean;
  children: ReactNode;
}) {
  useAttachLocalPersistence(allowed);
  return createElement(AllowedContext.Provider, { value: allowed }, children);
}

/**
 * Attaches local persistence to this QueryClient's store once the user is
 * known, if the setting is on. With the kill switch on, deletes whatever an
 * earlier session stored instead.
 */
function useAttachLocalPersistence(allowed: boolean): void {
  const queryClient = useQueryClient();
  const enabled = setting.useValue();
  const userId = trpc.auth.me.useQuery(undefined, { retry: false }).data?.user.id;

  useEffect(() => {
    if (!allowed) {
      void deleteLocalPersistence();
      return;
    }
    if (!enabled || !userId || !isLocalPersistenceSupported()) return;
    const db = getLocalDb(queryClient);
    if (db.persistence) return;
    openLocalPersistence(userId)
      .then((persistence) => attachLocalPersistence(db, persistence))
      .catch((error: unknown) => {
        // Best-effort: without persistence the store simply stays in memory.
        console.warn("Failed to attach local persistence", error);
      });
  }, [allowed, enabled, userId, queryClient]);
}

export interface LocalPersistenceSetting {
  /** Whether this device can offer the setting (operator allows it, browser supports it). */
  available: boolean;
  enabled: boolean;
  /**
   * Changes the setting and reloads, so the store starts over in the new
   * mode rather than switching under a running app. Turning it off deletes
   * the stored data first.
   */
  setEnabled: (value: boolean) => Promise<void>;
}

export function useLocalPersistenceSetting(): LocalPersistenceSetting {
  const allowed = useContext(AllowedContext);
  const enabled = setting.useValue();
  // The server can't tell whether the browser supports it, so the first
  // render agrees with the server's (unavailable) until hydration.
  const isHydrated = useIsHydrated();
  return {
    available: allowed && isHydrated && isLocalPersistenceSupported(),
    enabled,
    setEnabled: async (value) => {
      if (!value) await deleteLocalPersistence();
      setting.set(value);
      window.location.reload();
    },
  };
}
