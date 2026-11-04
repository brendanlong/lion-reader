/**
 * @vitest-environment jsdom
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { hydrateRoot } from "react-dom/client";
import { act } from "react";
import { useAppBaseUrl } from "@/lib/hooks/useAppBaseUrl";

function Probe() {
  const baseUrl = useAppBaseUrl();
  return <div>{baseUrl && <code>{`${baseUrl}/api/mcp`}</code>}</div>;
}

describe("useAppBaseUrl", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("hydrates without a mismatch when NEXT_PUBLIC_APP_URL is unset, then shows the origin (#2277)", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");

    const serverHtml = renderToString(<Probe />);
    expect(serverHtml).not.toContain("<code>");

    const container = document.createElement("div");
    container.innerHTML = serverHtml;
    document.body.appendChild(container);

    const recoverableErrors: unknown[] = [];
    let root: ReturnType<typeof hydrateRoot> | undefined;
    await act(async () => {
      root = hydrateRoot(container, <Probe />, {
        onRecoverableError: (error) => {
          recoverableErrors.push(error);
        },
      });
    });

    expect(recoverableErrors).toEqual([]);
    expect(container.querySelector("code")?.textContent).toBe(`${window.location.origin}/api/mcp`);

    await act(async () => {
      root?.unmount();
    });
    container.remove();
  });

  it("renders NEXT_PUBLIC_APP_URL on the server when set", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://reader.example.com");

    expect(renderToString(<Probe />)).toContain("https://reader.example.com/api/mcp");
  });
});
