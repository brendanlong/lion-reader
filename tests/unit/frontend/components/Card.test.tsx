/**
 * @vitest-environment jsdom
 */

/**
 * Unit tests for Card components.
 *
 * Tests the Card, CardHeader, CardTitle, CardDescription, CardBody, CardFooter, and StatusCard components.
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardBody,
  CardFooter,
  StatusCard,
} from "@/components/ui/card";

describe("Card", () => {
  describe("rendering", () => {
    it("renders children correctly", () => {
      render(<Card>Card content</Card>);
      expect(screen.getByText("Card content")).toBeInTheDocument();
    });

    it("applies base styles", () => {
      render(<Card>Content</Card>);
      const card = screen.getByText("Content").closest("div");
      expect(card).toHaveClass("rounded-lg", "border", "bg-white");
    });
  });

  describe("padding sizes", () => {
    it("applies sm padding", () => {
      render(<Card padding="sm">Small padding</Card>);
      const card = screen.getByText("Small padding").closest("div");
      expect(card).toHaveClass("p-3");
    });

    it("applies md padding", () => {
      render(<Card padding="md">Medium padding</Card>);
      const card = screen.getByText("Medium padding").closest("div");
      expect(card).toHaveClass("p-4");
    });

    it("applies lg padding (default)", () => {
      render(<Card padding="lg">Large padding</Card>);
      const card = screen.getByText("Large padding").closest("div");
      expect(card).toHaveClass("p-6");
    });

    it("uses lg padding as default", () => {
      render(<Card>Default padding</Card>);
      const card = screen.getByText("Default padding").closest("div");
      expect(card).toHaveClass("p-6");
    });
  });

  describe("custom className", () => {
    it("applies custom className", () => {
      render(<Card className="custom-class">Custom</Card>);
      const card = screen.getByText("Custom").closest("div");
      expect(card).toHaveClass("custom-class");
    });
  });
});

describe("CardHeader", () => {
  it("renders children correctly", () => {
    render(<CardHeader>Header content</CardHeader>);
    expect(screen.getByText("Header content")).toBeInTheDocument();
  });

  it("applies margin bottom", () => {
    render(<CardHeader>Header</CardHeader>);
    const header = screen.getByText("Header").closest("div");
    expect(header).toHaveClass("mb-4");
  });

  it("applies custom className", () => {
    render(<CardHeader className="custom-header">Header</CardHeader>);
    const header = screen.getByText("Header").closest("div");
    expect(header).toHaveClass("custom-header");
  });
});

describe("CardTitle", () => {
  it("renders as h3 element", () => {
    render(<CardTitle>Title</CardTitle>);
    expect(screen.getByRole("heading", { level: 3 })).toHaveTextContent("Title");
  });

  it("applies title styles", () => {
    render(<CardTitle>Styled Title</CardTitle>);
    const title = screen.getByRole("heading");
    expect(title).toHaveClass("font-semibold", "text-zinc-900");
  });

  it("applies custom className", () => {
    render(<CardTitle className="custom-title">Title</CardTitle>);
    expect(screen.getByRole("heading")).toHaveClass("custom-title");
  });
});

describe("CardDescription", () => {
  it("renders as p element", () => {
    render(<CardDescription>Description text</CardDescription>);
    const description = screen.getByText("Description text");
    expect(description.tagName).toBe("P");
  });

  it("applies description styles", () => {
    render(<CardDescription>Styled description</CardDescription>);
    const description = screen.getByText("Styled description");
    expect(description).toHaveClass("text-zinc-500", "mt-1");
  });

  it("applies custom className", () => {
    render(<CardDescription className="custom-desc">Description</CardDescription>);
    expect(screen.getByText("Description")).toHaveClass("custom-desc");
  });
});

describe("CardBody", () => {
  it("renders children correctly", () => {
    render(<CardBody>Body content</CardBody>);
    expect(screen.getByText("Body content")).toBeInTheDocument();
  });

  it("applies custom className", () => {
    render(<CardBody className="custom-body">Body</CardBody>);
    const body = screen.getByText("Body").closest("div");
    expect(body).toHaveClass("custom-body");
  });
});

describe("CardFooter", () => {
  it("renders children correctly", () => {
    render(<CardFooter>Footer content</CardFooter>);
    expect(screen.getByText("Footer content")).toBeInTheDocument();
  });

  it("applies footer styles", () => {
    render(<CardFooter>Footer</CardFooter>);
    const footer = screen.getByText("Footer").closest("div");
    expect(footer).toHaveClass("mt-4", "flex", "items-center", "justify-end", "gap-3");
  });

  it("applies custom className", () => {
    render(<CardFooter className="custom-footer">Footer</CardFooter>);
    const footer = screen.getByText("Footer").closest("div");
    expect(footer).toHaveClass("custom-footer");
  });
});

describe("StatusCard", () => {
  describe("variants", () => {
    it("applies info variant styles", () => {
      render(<StatusCard variant="info">Info</StatusCard>);
      const card = screen.getByText("Info").closest("div");
      expect(card).toHaveClass("border-info-border", "bg-info-subtle");
    });

    it("applies success variant styles", () => {
      render(<StatusCard variant="success">Success</StatusCard>);
      const card = screen.getByText("Success").closest("div");
      expect(card).toHaveClass("border-green-200", "bg-green-50");
    });

    it("applies warning variant styles", () => {
      render(<StatusCard variant="warning">Warning</StatusCard>);
      const card = screen.getByText("Warning").closest("div");
      expect(card).toHaveClass("border-yellow-200", "bg-yellow-50");
    });

    it("applies error variant styles", () => {
      render(<StatusCard variant="error">Error</StatusCard>);
      const card = screen.getByText("Error").closest("div");
      expect(card).toHaveClass("border-red-200", "bg-red-50");
    });
  });

  describe("padding sizes", () => {
    it("applies sm padding", () => {
      render(
        <StatusCard variant="info" padding="sm">
          Small
        </StatusCard>
      );
      const card = screen.getByText("Small").closest("div");
      expect(card).toHaveClass("p-3");
    });

    it("applies md padding (default)", () => {
      render(<StatusCard variant="info">Medium</StatusCard>);
      const card = screen.getByText("Medium").closest("div");
      expect(card).toHaveClass("p-4");
    });

    it("applies lg padding", () => {
      render(
        <StatusCard variant="info" padding="lg">
          Large
        </StatusCard>
      );
      const card = screen.getByText("Large").closest("div");
      expect(card).toHaveClass("p-6");
    });
  });

  describe("styling", () => {
    it("applies base styles", () => {
      render(<StatusCard variant="info">Base</StatusCard>);
      const card = screen.getByText("Base").closest("div");
      expect(card).toHaveClass("rounded-lg", "border");
    });

    it("applies custom className", () => {
      render(
        <StatusCard variant="info" className="custom-status">
          Custom
        </StatusCard>
      );
      const card = screen.getByText("Custom").closest("div");
      expect(card).toHaveClass("custom-status");
    });
  });
});

describe("Card composition", () => {
  it("renders a complete card with all subcomponents", () => {
    render(
      <Card>
        <CardHeader>
          <CardTitle>Settings</CardTitle>
          <CardDescription>Manage your account settings</CardDescription>
        </CardHeader>
        <CardBody>Main content here</CardBody>
        <CardFooter>
          <button>Save</button>
        </CardFooter>
      </Card>
    );

    expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getByText("Manage your account settings")).toBeInTheDocument();
    expect(screen.getByText("Main content here")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
  });
});
