/**
 * @vitest-environment jsdom
 */

/**
 * Unit tests for Dialog component.
 *
 * Tests the dialog behavior including open/close, escape key, backdrop click, and accessibility.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import {
  Dialog,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogBody,
  DialogFooter,
} from "@/components/ui/dialog";

afterEach(() => {
  cleanup();
  // Reset body overflow after each test
  document.body.style.overflow = "";
});

describe("Dialog", () => {
  describe("open/close behavior", () => {
    it("renders when isOpen is true", () => {
      render(
        <Dialog isOpen={true} onClose={vi.fn()} title="Test Dialog">
          Dialog content
        </Dialog>
      );
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      expect(screen.getByText("Dialog content")).toBeInTheDocument();
    });

    it("does not render when isOpen is false", () => {
      render(
        <Dialog isOpen={false} onClose={vi.fn()} title="Test Dialog">
          Dialog content
        </Dialog>
      );
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("calls onClose when backdrop is clicked", () => {
      const onClose = vi.fn();
      render(
        <Dialog isOpen={true} onClose={onClose} title="Test Dialog">
          Content
        </Dialog>
      );

      // Find the backdrop (has aria-hidden="true")
      const backdrop = screen.getByRole("dialog").querySelector('[aria-hidden="true"]');
      fireEvent.click(backdrop!);

      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("calls onClose when Escape key is pressed", () => {
      const onClose = vi.fn();
      render(
        <Dialog isOpen={true} onClose={onClose} title="Test Dialog">
          Content
        </Dialog>
      );

      fireEvent.keyDown(document, { key: "Escape" });
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("does not call onClose when other keys are pressed", () => {
      const onClose = vi.fn();
      render(
        <Dialog isOpen={true} onClose={onClose} title="Test Dialog">
          Content
        </Dialog>
      );

      fireEvent.keyDown(document, { key: "Enter" });
      fireEvent.keyDown(document, { key: "Tab" });
      expect(onClose).not.toHaveBeenCalled();
    });
  });

  describe("scroll lock", () => {
    it("prevents body scroll when open", () => {
      render(
        <Dialog isOpen={true} onClose={vi.fn()} title="Test Dialog">
          Content
        </Dialog>
      );
      expect(document.body.style.overflow).toBe("hidden");
    });

    it("restores body scroll when closed", () => {
      const { rerender } = render(
        <Dialog isOpen={true} onClose={vi.fn()} title="Test Dialog">
          Content
        </Dialog>
      );

      rerender(
        <Dialog isOpen={false} onClose={vi.fn()} title="Test Dialog">
          Content
        </Dialog>
      );

      expect(document.body.style.overflow).toBe("");
    });

    it("restores body scroll on unmount", () => {
      const { unmount } = render(
        <Dialog isOpen={true} onClose={vi.fn()} title="Test Dialog">
          Content
        </Dialog>
      );

      unmount();
      expect(document.body.style.overflow).toBe("");
    });
  });

  describe("sizes", () => {
    it("applies sm size", () => {
      render(
        <Dialog isOpen={true} onClose={vi.fn()} title="Small Dialog" size="sm">
          Content
        </Dialog>
      );
      const dialog = screen.getByRole("dialog");
      const container = dialog.querySelector(".max-w-sm");
      expect(container).toBeInTheDocument();
    });

    it("applies md size (default)", () => {
      render(
        <Dialog isOpen={true} onClose={vi.fn()} title="Medium Dialog">
          Content
        </Dialog>
      );
      const dialog = screen.getByRole("dialog");
      const container = dialog.querySelector(".max-w-md");
      expect(container).toBeInTheDocument();
    });

    it("applies lg size", () => {
      render(
        <Dialog isOpen={true} onClose={vi.fn()} title="Large Dialog" size="lg">
          Content
        </Dialog>
      );
      const dialog = screen.getByRole("dialog");
      const container = dialog.querySelector(".max-w-lg");
      expect(container).toBeInTheDocument();
    });
  });

  describe("accessibility", () => {
    it("has role='dialog'", () => {
      render(
        <Dialog isOpen={true} onClose={vi.fn()} title="Accessible Dialog">
          Content
        </Dialog>
      );
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    it("has aria-modal='true'", () => {
      render(
        <Dialog isOpen={true} onClose={vi.fn()} title="Modal Dialog">
          Content
        </Dialog>
      );
      expect(screen.getByRole("dialog")).toHaveAttribute("aria-modal", "true");
    });

    it("generates aria-labelledby from title", () => {
      render(
        <Dialog isOpen={true} onClose={vi.fn()} title="My Dialog Title">
          Content
        </Dialog>
      );
      expect(screen.getByRole("dialog")).toHaveAttribute(
        "aria-labelledby",
        "dialog-title-my-dialog-title"
      );
    });

    it("uses custom titleId when provided", () => {
      render(
        <Dialog isOpen={true} onClose={vi.fn()} title="Dialog" titleId="custom-title-id">
          Content
        </Dialog>
      );
      expect(screen.getByRole("dialog")).toHaveAttribute("aria-labelledby", "custom-title-id");
    });
  });

  describe("custom className", () => {
    it("applies custom className to dialog container", () => {
      render(
        <Dialog isOpen={true} onClose={vi.fn()} title="Custom Dialog" className="custom-class">
          Content
        </Dialog>
      );
      const dialog = screen.getByRole("dialog");
      const container = dialog.querySelector(".custom-class");
      expect(container).toBeInTheDocument();
    });
  });
});

describe("DialogHeader", () => {
  it("renders children correctly", () => {
    render(<DialogHeader>Header content</DialogHeader>);
    expect(screen.getByText("Header content")).toBeInTheDocument();
  });

  it("applies margin bottom", () => {
    render(<DialogHeader>Header</DialogHeader>);
    const header = screen.getByText("Header").closest("div");
    expect(header).toHaveClass("mb-4");
  });

  it("applies custom className", () => {
    render(<DialogHeader className="custom-header">Header</DialogHeader>);
    const header = screen.getByText("Header").closest("div");
    expect(header).toHaveClass("custom-header");
  });
});

describe("DialogTitle", () => {
  it("renders as h2 element", () => {
    render(<DialogTitle>Title</DialogTitle>);
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Title");
  });

  it("applies title styles", () => {
    render(<DialogTitle>Styled Title</DialogTitle>);
    const title = screen.getByRole("heading");
    expect(title).toHaveClass("font-semibold", "text-zinc-900");
  });

  it("applies custom id", () => {
    render(<DialogTitle id="my-title-id">Title</DialogTitle>);
    expect(screen.getByRole("heading")).toHaveAttribute("id", "my-title-id");
  });

  it("applies custom className", () => {
    render(<DialogTitle className="custom-title">Title</DialogTitle>);
    expect(screen.getByRole("heading")).toHaveClass("custom-title");
  });
});

describe("DialogDescription", () => {
  it("renders as p element", () => {
    render(<DialogDescription>Description text</DialogDescription>);
    const description = screen.getByText("Description text");
    expect(description.tagName).toBe("P");
  });

  it("applies description styles", () => {
    render(<DialogDescription>Styled description</DialogDescription>);
    const description = screen.getByText("Styled description");
    expect(description).toHaveClass("text-zinc-600", "mt-2");
  });

  it("applies custom className", () => {
    render(<DialogDescription className="custom-desc">Description</DialogDescription>);
    expect(screen.getByText("Description")).toHaveClass("custom-desc");
  });
});

describe("DialogBody", () => {
  it("renders children correctly", () => {
    render(<DialogBody>Body content</DialogBody>);
    expect(screen.getByText("Body content")).toBeInTheDocument();
  });

  it("applies custom className", () => {
    render(<DialogBody className="custom-body">Body</DialogBody>);
    const body = screen.getByText("Body").closest("div");
    expect(body).toHaveClass("custom-body");
  });
});

describe("DialogFooter", () => {
  it("renders children correctly", () => {
    render(<DialogFooter>Footer content</DialogFooter>);
    expect(screen.getByText("Footer content")).toBeInTheDocument();
  });

  it("applies footer styles", () => {
    render(<DialogFooter>Footer</DialogFooter>);
    const footer = screen.getByText("Footer").closest("div");
    expect(footer).toHaveClass("mt-6", "flex", "justify-end", "gap-3");
  });

  it("applies custom className", () => {
    render(<DialogFooter className="custom-footer">Footer</DialogFooter>);
    const footer = screen.getByText("Footer").closest("div");
    expect(footer).toHaveClass("custom-footer");
  });
});

describe("Dialog composition", () => {
  it("renders a complete dialog with all subcomponents", () => {
    const onClose = vi.fn();
    render(
      <Dialog isOpen={true} onClose={onClose} title="Confirm Action">
        <DialogHeader>
          <DialogTitle>Confirm Action</DialogTitle>
          <DialogDescription>Are you sure you want to proceed?</DialogDescription>
        </DialogHeader>
        <DialogBody>This action cannot be undone.</DialogBody>
        <DialogFooter>
          <button onClick={onClose}>Cancel</button>
          <button>Confirm</button>
        </DialogFooter>
      </Dialog>
    );

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Confirm Action" })).toBeInTheDocument();
    expect(screen.getByText("Are you sure you want to proceed?")).toBeInTheDocument();
    expect(screen.getByText("This action cannot be undone.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirm" })).toBeInTheDocument();
  });
});
