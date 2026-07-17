/**
 * Shared explanation of why Lion Reader isn't available in the European Union on
 * EU-restricted instances (EU_RESTRICTED=true / the `euRestricted` signup-config
 * flag).
 *
 * The prose is deduplicated here so the registration warning (which can't sign
 * up) and the complete-signup footnote (which confirms you're not in the EU)
 * stay in sync. Keep it as inline phrasing so each caller can wrap it in
 * whatever container fits its context.
 */

export function EuRestrictionReason() {
  return (
    <>
      Despite our strict{" "}
      <a href="/privacy" target="_blank" rel="noopener noreferrer" className="underline">
        privacy policy
      </a>
      , EU law would require us to{" "}
      <a
        href="https://www.activemind.legal/guides/fine-eu-representative/"
        target="_blank"
        rel="noopener noreferrer"
        className="underline"
      >
        retain a lawyer
      </a>
      , which isn&apos;t viable for a free project. You&apos;re welcome to{" "}
      <a
        href="https://github.com/brendanlong/lion-reader"
        target="_blank"
        rel="noopener noreferrer"
        className="underline"
      >
        self-host Lion Reader
      </a>{" "}
      instead.
    </>
  );
}
