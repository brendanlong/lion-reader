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
 * Context value for keyboard shortcuts
 */
interface KeyboardShortcutsContextValue {
  /** Whether keyboard shortcuts are enabled */
  enabled: boolean;
  /** Function to enable/disable keyboard shortcuts */
  setEnabled: (value: boolean) => void;
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
  const { enabled, setEnabled, isLoading } = useKeyboardShortcutsEnabled();
  const [isModalOpen, setIsModalOpen] = useState(false);

  const openShortcutsModal = useCallback(() => {
    setIsModalOpen(true);
  }, []);

  const closeShortcutsModal = useCallback(() => {
    setIsModalOpen(false);
  }, []);

  // ? shortcut to open help modal
  // Note: We use "shift+/" because ? is shift+/ on most keyboards
  useHotkeys(
    "shift+/",
    (e) => {
      e.preventDefault();
      openShortcutsModal();
    },
    {
      enabled: enabled && !isLoading && !isModalOpen,
      enableOnFormTags: false,
    },
    [enabled, isLoading, isModalOpen, openShortcutsModal]
  );

  const contextValue = useMemo<KeyboardShortcutsContextValue>(
    () => ({
      enabled,
      setEnabled,
      openShortcutsModal,
      closeShortcutsModal,
      isModalOpen,
    }),
    [enabled, setEnabled, openShortcutsModal, closeShortcutsModal, isModalOpen]
  );

  return (
    <KeyboardShortcutsContext.Provider value={contextValue}>
      {children}
      <KeyboardShortcutsModal isOpen={isModalOpen} onClose={closeShortcutsModal} />
    </KeyboardShortcutsContext.Provider>
  );
}
