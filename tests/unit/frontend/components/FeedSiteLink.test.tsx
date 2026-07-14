/**
 * @vitest-environment jsdom
 */

/**
 * Unit tests for FeedSiteLink component.
 *
 * Renders an external link to a feed's website (feeds.site_url), showing the
 * hostname as a compact label. Renders nothing when there is no site URL.
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { FeedSiteLink } from "@/components/feeds/FeedSiteLink";

describe("FeedSiteLink", () => {
  it("renders a link to the site URL labeled with the hostname", () => {
    render(<FeedSiteLink siteUrl="https://announcements.lionreader.com/" />);
    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("href", "https://announcements.lionreader.com/");
    expect(link).toHaveTextContent("announcements.lionreader.com");
  });

  it("opens in a new tab with a safe rel", () => {
    render(<FeedSiteLink siteUrl="https://example.com/blog" />);
    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("renders nothing when siteUrl is null", () => {
    const { container } = render(<FeedSiteLink siteUrl={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when siteUrl is undefined", () => {
    const { container } = render(<FeedSiteLink siteUrl={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when siteUrl is an empty string", () => {
    const { container } = render(<FeedSiteLink siteUrl="" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("falls back to the raw value when the URL is not parseable", () => {
    render(<FeedSiteLink siteUrl="not a url" />);
    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("href", "not a url");
    expect(link).toHaveTextContent("not a url");
  });

  it("applies extra classes passed via className", () => {
    render(<FeedSiteLink siteUrl="https://example.com" className="mt-0.5" />);
    expect(screen.getByRole("link").className).toContain("mt-0.5");
  });
});
