/**
 * @vitest-environment jsdom
 */

/**
 * Unit tests for EntryListItem component.
 *
 * Tests the presentational component with mock data and callbacks.
 * No tRPC or React Query mocking needed - this is a pure component.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { EntryListItem, type EntryListItemData } from "@/components/entries/EntryListItem";

// Fix time for consistent relative time formatting
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2024-06-15T12:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * Creates a mock entry with sensible defaults.
 */
function createMockEntry(overrides: Partial<EntryListItemData> = {}): EntryListItemData {
  return {
    id: "entry-1",
    feedId: "feed-1",
    subscriptionId: "sub-1",
    type: "web",
    url: "https://example.com/article",
    title: "Test Article Title",
    author: "Test Author",
    summary: "This is a summary of the article content.",
    publishedAt: new Date("2024-06-15T10:00:00Z"),
    fetchedAt: new Date("2024-06-15T11:00:00Z"),
    read: false,
    starred: false,
    feedTitle: "Example Feed",
    ...overrides,
  };
}

describe("EntryListItem", () => {
  describe("rendering", () => {
    it("renders the entry title", () => {
      const entry = createMockEntry({ title: "My Article Title" });
      render(<EntryListItem entry={entry} />);

      expect(screen.getByText("My Article Title")).toBeInTheDocument();
    });

    it('renders "Untitled" when title is null', () => {
      const entry = createMockEntry({ title: null });
      render(<EntryListItem entry={entry} />);

      expect(screen.getByText("Untitled")).toBeInTheDocument();
    });

    it("renders the feed title as source", () => {
      const entry = createMockEntry({ feedTitle: "Tech News" });
      render(<EntryListItem entry={entry} />);

      expect(screen.getByText("Tech News")).toBeInTheDocument();
    });

    it('renders "Unknown Feed" when feedTitle is null', () => {
      const entry = createMockEntry({ feedTitle: null });
      render(<EntryListItem entry={entry} />);

      expect(screen.getByText("Unknown Feed")).toBeInTheDocument();
    });

    it("renders the summary when provided", () => {
      const entry = createMockEntry({ summary: "Article summary text" });
      render(<EntryListItem entry={entry} />);

      expect(screen.getByText("Article summary text")).toBeInTheDocument();
    });

    it("does not render summary section when summary is null", () => {
      const entry = createMockEntry({ summary: null });
      render(<EntryListItem entry={entry} />);

      // Should only have one paragraph (meta row), not two
      const article = screen.getByRole("button");
      expect(article.querySelectorAll("p")).toHaveLength(0);
    });

    it("renders relative time for publishedAt", () => {
      const entry = createMockEntry({
        publishedAt: new Date("2024-06-15T10:00:00Z"), // 2 hours ago
      });
      render(<EntryListItem entry={entry} />);

      expect(screen.getByText("2 hours ago")).toBeInTheDocument();
    });

    it("falls back to fetchedAt when publishedAt is null", () => {
      const entry = createMockEntry({
        publishedAt: null,
        fetchedAt: new Date("2024-06-15T11:00:00Z"), // 1 hour ago
      });
      render(<EntryListItem entry={entry} />);

      expect(screen.getByText("1 hour ago")).toBeInTheDocument();
    });
  });

  describe("read/unread state", () => {
    it("shows filled indicator for unread entries", () => {
      const entry = createMockEntry({ read: false });
      render(<EntryListItem entry={entry} onToggleRead={vi.fn()} />);

      const button = screen.getByRole("button", { name: "Mark as read" });
      expect(button).toBeInTheDocument();
      expect(button).toHaveClass("bg-blue-500");
    });

    it("shows empty indicator for read entries", () => {
      const entry = createMockEntry({ read: true });
      render(<EntryListItem entry={entry} onToggleRead={vi.fn()} />);

      const button = screen.getByRole("button", { name: "Mark as unread" });
      expect(button).toBeInTheDocument();
      expect(button).toHaveClass("bg-transparent");
    });

    it("applies different title styling for read vs unread", () => {
      const unreadEntry = createMockEntry({ read: false, title: "Unread" });
      const readEntry = createMockEntry({ read: true, title: "Read" });

      const { rerender } = render(<EntryListItem entry={unreadEntry} />);
      const unreadTitle = screen.getByText("Unread");
      expect(unreadTitle).toHaveClass("font-medium");

      rerender(<EntryListItem entry={readEntry} />);
      const readTitle = screen.getByText("Read");
      expect(readTitle).toHaveClass("font-normal");
    });
  });

  describe("starred state", () => {
    it("shows filled star for starred entries", () => {
      const entry = createMockEntry({ starred: true });
      render(<EntryListItem entry={entry} onToggleStar={vi.fn()} />);

      const button = screen.getByRole("button", { name: "Remove from starred" });
      expect(button).toBeInTheDocument();
    });

    it("shows empty star for unstarred entries when hovered", () => {
      const entry = createMockEntry({ starred: false });
      render(<EntryListItem entry={entry} onToggleStar={vi.fn()} />);

      const button = screen.getByRole("button", { name: "Add to starred" });
      expect(button).toBeInTheDocument();
    });

    it("shows star icon without button when no onToggleStar callback", () => {
      const entry = createMockEntry({ starred: true });
      render(<EntryListItem entry={entry} />);

      // Should have a span with aria-label, not a button
      expect(screen.getByLabelText("Starred")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /starred/i })).not.toBeInTheDocument();
    });

    it("does not show star for unstarred entry without callback", () => {
      const entry = createMockEntry({ starred: false });
      render(<EntryListItem entry={entry} />);

      expect(screen.queryByLabelText("Starred")).not.toBeInTheDocument();
    });
  });

  describe("selected state", () => {
    it("applies selection ring when selected", () => {
      const entry = createMockEntry();
      render(<EntryListItem entry={entry} selected={true} />);

      const article = screen.getByRole("button");
      expect(article).toHaveClass("ring-2", "ring-blue-500");
    });

    it("does not apply selection ring when not selected", () => {
      const entry = createMockEntry();
      render(<EntryListItem entry={entry} selected={false} />);

      const article = screen.getByRole("button");
      expect(article).not.toHaveClass("ring-2");
    });
  });

  describe("callbacks", () => {
    it("calls onClick with entry id when clicked", () => {
      const entry = createMockEntry({ id: "entry-123" });
      const onClick = vi.fn();
      render(<EntryListItem entry={entry} onClick={onClick} />);

      fireEvent.click(screen.getByRole("button"));
      expect(onClick).toHaveBeenCalledWith("entry-123");
    });

    it("calls onClick when Enter key is pressed", () => {
      const entry = createMockEntry({ id: "entry-123" });
      const onClick = vi.fn();
      render(<EntryListItem entry={entry} onClick={onClick} />);

      fireEvent.keyDown(screen.getByRole("button"), { key: "Enter" });
      expect(onClick).toHaveBeenCalledWith("entry-123");
    });

    it("calls onClick when Space key is pressed", () => {
      const entry = createMockEntry({ id: "entry-123" });
      const onClick = vi.fn();
      render(<EntryListItem entry={entry} onClick={onClick} />);

      fireEvent.keyDown(screen.getByRole("button"), { key: " " });
      expect(onClick).toHaveBeenCalledWith("entry-123");
    });

    it("calls onToggleRead with correct parameters when read indicator clicked", () => {
      const entry = createMockEntry({
        id: "entry-123",
        read: false,
        type: "web",
        subscriptionId: "sub-456",
      });
      const onToggleRead = vi.fn();
      render(<EntryListItem entry={entry} onToggleRead={onToggleRead} />);

      fireEvent.click(screen.getByRole("button", { name: "Mark as read" }));
      expect(onToggleRead).toHaveBeenCalledWith("entry-123", false, "web", "sub-456");
    });

    it("calls onToggleStar with correct parameters when star clicked", () => {
      const entry = createMockEntry({ id: "entry-123", starred: false });
      const onToggleStar = vi.fn();
      render(<EntryListItem entry={entry} onToggleStar={onToggleStar} />);

      fireEvent.click(screen.getByRole("button", { name: "Add to starred" }));
      expect(onToggleStar).toHaveBeenCalledWith("entry-123", false);
    });

    it("stops propagation when read indicator is clicked", () => {
      const entry = createMockEntry();
      const onClick = vi.fn();
      const onToggleRead = vi.fn();
      render(<EntryListItem entry={entry} onClick={onClick} onToggleRead={onToggleRead} />);

      fireEvent.click(screen.getByRole("button", { name: "Mark as read" }));
      expect(onToggleRead).toHaveBeenCalled();
      expect(onClick).not.toHaveBeenCalled();
    });

    it("stops propagation when star is clicked", () => {
      const entry = createMockEntry();
      const onClick = vi.fn();
      const onToggleStar = vi.fn();
      render(<EntryListItem entry={entry} onClick={onClick} onToggleStar={onToggleStar} />);

      fireEvent.click(screen.getByRole("button", { name: "Add to starred" }));
      expect(onToggleStar).toHaveBeenCalled();
      expect(onClick).not.toHaveBeenCalled();
    });
  });

  describe("accessibility", () => {
    it("has correct aria-label for unread entry", () => {
      const entry = createMockEntry({
        read: false,
        title: "Article Title",
        feedTitle: "Feed Name",
      });
      render(<EntryListItem entry={entry} />);

      expect(screen.getByRole("button")).toHaveAttribute(
        "aria-label",
        "Unread article: Article Title from Feed Name"
      );
    });

    it("has correct aria-label for read entry", () => {
      const entry = createMockEntry({
        read: true,
        title: "Article Title",
        feedTitle: "Feed Name",
      });
      render(<EntryListItem entry={entry} />);

      expect(screen.getByRole("button")).toHaveAttribute(
        "aria-label",
        "Read article: Article Title from Feed Name"
      );
    });

    it("includes selected state in aria-label", () => {
      const entry = createMockEntry({
        read: false,
        title: "Article Title",
        feedTitle: "Feed Name",
      });
      render(<EntryListItem entry={entry} selected={true} />);

      expect(screen.getByRole("button")).toHaveAttribute(
        "aria-label",
        "Unread, selected article: Article Title from Feed Name"
      );
    });

    it("has data-entry-id attribute for testing/scripting", () => {
      const entry = createMockEntry({ id: "entry-123" });
      render(<EntryListItem entry={entry} />);

      expect(screen.getByRole("button")).toHaveAttribute("data-entry-id", "entry-123");
    });

    it("is focusable via tabIndex", () => {
      const entry = createMockEntry();
      render(<EntryListItem entry={entry} />);

      expect(screen.getByRole("button")).toHaveAttribute("tabIndex", "0");
    });
  });
});
