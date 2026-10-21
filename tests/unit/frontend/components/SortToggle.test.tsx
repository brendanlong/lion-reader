/**
 * @vitest-environment jsdom
 */

/**
 * SortToggle: the direction toggle of the sort in use, and the Date/Score/
 * Position picker shown when the list has values for more than Date (#2064).
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SortToggle, shownSortOrder } from "@/components/entries/SortToggle";

describe("SortToggle", () => {
  it.each([
    ["newest", "Newest", "Sort oldest first", "false", "oldest"],
    ["oldest", "Oldest", "Sort newest first", "true", "newest"],
    ["highest", "Highest", "Sort lowest first", "false", "lowest"],
    ["lowest", "Lowest", "Sort highest first", "true", "highest"],
    ["first", "First", "Sort last first", "false", "last"],
    ["last", "Last", "Sort first first", "true", "first"],
  ] as const)(
    "shows %s and toggles to its other direction",
    (order, label, aria, pressed, next) => {
      const onChange = vi.fn();
      render(
        <SortToggle
          sortOrder={order}
          sortable={{ score: true, position: true }}
          onChange={onChange}
        />
      );
      const button = screen.getByRole("button", { name: aria });
      expect(button).toHaveTextContent(label);
      expect(button).toHaveAttribute("aria-pressed", pressed);
      fireEvent.click(button);
      expect(onChange).toHaveBeenCalledWith(next);
    }
  );

  it("offers no sort picker when the list has only dates", () => {
    render(
      <SortToggle
        sortOrder="newest"
        sortable={{ score: false, position: false }}
        onChange={vi.fn()}
      />
    );
    expect(screen.queryByRole("combobox", { name: "Sort by" })).not.toBeInTheDocument();
  });

  it("offers the sorts the list has values for, each starting in its first direction", () => {
    const onChange = vi.fn();
    render(
      <SortToggle
        sortOrder="newest"
        sortable={{ score: true, position: false }}
        onChange={onChange}
      />
    );
    const picker = screen.getByRole("combobox", { name: "Sort by" });
    expect([...picker.querySelectorAll("option")].map((o) => o.textContent)).toEqual([
      "Date",
      "Score",
    ]);
    fireEvent.change(picker, { target: { value: "score" } });
    expect(onChange).toHaveBeenCalledWith("highest");
  });

  it("goes back to Date from a ranked sort", () => {
    const onChange = vi.fn();
    render(
      <SortToggle
        sortOrder="first"
        sortable={{ score: false, position: true }}
        onChange={onChange}
      />
    );
    fireEvent.change(screen.getByRole("combobox", { name: "Sort by" }), {
      target: { value: "published" },
    });
    expect(onChange).toHaveBeenCalledWith("newest");
  });
});

describe("shownSortOrder", () => {
  it("shows a sort whose values are gone by date, newest first", () => {
    expect(shownSortOrder("lowest", { score: false, position: true })).toBe("newest");
    expect(shownSortOrder("last", { score: true, position: false })).toBe("newest");
  });

  it("keeps a sort with values, and any sort while they're unknown", () => {
    expect(shownSortOrder("lowest", { score: true, position: false })).toBe("lowest");
    expect(shownSortOrder("first", undefined)).toBe("first");
    expect(shownSortOrder("oldest", { score: false, position: false })).toBe("oldest");
  });
});
