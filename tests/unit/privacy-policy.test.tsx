/**
 * @vitest-environment jsdom
 */

/**
 * The privacy policy must name every AI provider we send user data to (root
 * CLAUDE.md, "Third-Party Providers"): adding a provider without updating the
 * policy fails here.
 */

import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import PrivacyPolicyPage from "@/app/(public)/privacy/page";
import {
  AI_PROVIDER_INFO,
  SPEECH_PROVIDERS,
  TEXT_AI_PROVIDERS,
  type AiProvider,
} from "@/lib/ai/providers";
import { NARRATION_PROVIDERS } from "@/lib/narration/constants";

function linksInSubsection(headingId: string): string[] {
  const { container } = render(<PrivacyPolicyPage />);
  const subsection = container.querySelector(`#${headingId}`)?.parentElement;
  expect(subsection, `#${headingId}`).toBeTruthy();
  return [...subsection!.querySelectorAll("a")].map((a) => a.getAttribute("href") ?? "");
}

describe("privacy policy AI providers", () => {
  it.each([
    ["article-summarization", TEXT_AI_PROVIDERS],
    ["audio-narration", [...NARRATION_PROVIDERS, ...SPEECH_PROVIDERS]],
  ] satisfies [string, readonly AiProvider[]][])(
    "#%s links the privacy policy of every provider it may send data to",
    (headingId, providers) => {
      const links = linksInSubsection(headingId);
      for (const provider of providers) {
        expect(links, provider).toContain(AI_PROVIDER_INFO[provider].privacyPolicyUrl);
      }
    }
  );
});
