/**
 * KeyboardShortcutsProvider Component
 *
 * Provides keyboard shortcuts context and handles the ? shortcut
 * to show the shortcuts modal. Wraps the app layout.
 */

"use client";

import { createContext, useContext, useState, useCallback, useMemo } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { KeyboardShortcutsModal } from "./KeyboardShortcutsModal";
import { useKeyboardShortcutsEnabled } from "@/lib/hooks/useKeyboardShortcutsEnabled";

/**
 * Context value for keyboard shortcuts.
 *
 * Whether shortcuts are enabled is deliberately not in here (read it with
 * `useKeyboardShortcutsEnabled`): it's stored in localStorage, so it changes
 * right after hydration, and a context change before the server-rendered entry
 * list's Suspense boundary hydrates makes React discard its server HTML (see
 * `useCanRenderStreamedQuery`).
 */
interface KeyboardShortcutsContextValue {
  /** Open the keyboard shortcuts modal */
  openShortcutsModal: () => void;
  /** Close the keyboard shortcuts modal */
  closeShortcutsModal: () => void;
  /** Whether the modal is currently open */
  isModalOpen: boolean;
}

const KeyboardShortcutsContext = createContext<KeyboardShortcutsContextValue | null>(null);

/**
 * Hook to access keyboard shortcuts context
 */
export function useKeyboardShortcutsContext() {
  const context = useContext(KeyboardShortcutsContext);
  if (!context) {
    throw new Error("useKeyboardShortcutsContext must be used within a KeyboardShortcutsProvider");
  }
  return context;
}

interface KeyboardShortcutsProviderProps {
  children: React.ReactNode;
}

export function KeyboardShortcutsProvider({ children }: KeyboardShortcutsProviderProps) {
  const { enabled } = useKeyboardShortcutsEnabled();
  const [isModalOpen, setIsModalOpen] = useState(false);

  const openShortcutsModal = useCallback(() => {
    setIsModalOpen(true);
  }, []);

  const closeShortcutsModal = useCallback(() => {
    setIsModalOpen(false);
  }, []);

  useHotkeys(
    "shift+?",
    (e) => {
      e.preventDefault();
      openShortcutsModal();
    },
    // useKey matches the produced character (event.key): without it the "?"
    // would be compared to the physical key code ("slash"), which never matches.
    {
      enabled: enabled && !isModalOpen,
      enableOnFormTags: false,
      useKey: true,
    },
    [enabled, isModalOpen, openShortcutsModal]
  );

  const contextValue = useMemo<KeyboardShortcutsContextValue>(
    () => ({
      openShortcutsModal,
      closeShortcutsModal,
      isModalOpen,
    }),
    [openShortcutsModal, closeShortcutsModal, isModalOpen]
  );

  return (
    <KeyboardShortcutsContext.Provider value={contextValue}>
      {children}
      <KeyboardShortcutsModal isOpen={isModalOpen} onClose={closeShortcutsModal} />
    </KeyboardShortcutsContext.Provider>
  );
}
