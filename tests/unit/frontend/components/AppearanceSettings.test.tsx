/**
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderToString } from "react-dom/server";
import { hydrateRoot } from "react-dom/client";
import { act } from "react";
import { stubMemoryLocalStorage } from "../../../utils/component-test-helpers";
import { ThemeProvider } from "@/lib/theme/ThemeProvider";
import { THEME_STORAGE_KEY } from "@/lib/theme/config";
import { AppearanceProvider } from "@/lib/appearance/AppearanceProvider";
import { AppearanceSettings } from "@/components/settings/AppearanceSettings";

// next-themes decides it's on the server when its module loads, so under jsdom
// it always reads localStorage. Emulate what it returns on a real server.
let renderingOnServer = false;
vi.mock("next-themes", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next-themes")>();
  return {
    ...actual,
    useTheme: () => {
      const value = actual.useTheme();
      return renderingOnServer ? { ...value, theme: undefined, resolvedTheme: undefined } : value;
    },
  };
});

function Page() {
  return (
    <ThemeProvider>
      <AppearanceProvider>
        <AppearanceSettings />
      </AppearanceProvider>
    </ThemeProvider>
  );
}

function renderOnServer(): string {
  renderingOnServer = true;
  try {
    return renderToString(<Page />);
  } finally {
    renderingOnServer = false;
  }
}

describe("AppearanceSettings hydration", () => {
  let localStorageMock: Storage;

  beforeEach(() => {
    localStorageMock = stubMemoryLocalStorage();
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
      }))
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // #1934
  it.each([null, "dark"])(
    "matches the server render when the stored theme is %s",
    async (stored) => {
      if (stored) localStorageMock.setItem(THEME_STORAGE_KEY, stored);
      const serverHtml = renderOnServer();

      const container = document.createElement("div");
      container.innerHTML = serverHtml;
      document.body.appendChild(container);

      const recoverableErrors: unknown[] = [];
      let root: ReturnType<typeof hydrateRoot> | undefined;
      await act(async () => {
        root = hydrateRoot(container, <Page />, {
          onRecoverableError: (error) => {
            recoverableErrors.push(error);
          },
        });
      });

      expect(recoverableErrors).toEqual([]);
      // After hydration the stored theme shows.
      const selectedTheme = [...container.querySelectorAll('button[aria-pressed="true"]')]
        .map((button) => button.textContent)
        .find((label) => label && ["Auto", "Light", "Dark", "E-paper"].includes(label));
      expect(selectedTheme).toBe(stored === "dark" ? "Dark" : "Auto");

      await act(async () => {
        root?.unmount();
      });
      container.remove();
    }
  );
});
