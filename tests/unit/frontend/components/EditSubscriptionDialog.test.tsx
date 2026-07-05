/**
 * @vitest-environment jsdom
 */

/**
 * Component integration tests for EditSubscriptionDialog.
 *
 * Exercises the real tRPC query/mutation wiring (via the mock-link harness in
 * component-test-helpers) rather than the presentational surface alone:
 *   - `tags.list` query populates the tag chips.
 *   - Saving a changed custom title fires `subscriptions.update`.
 *   - Toggling tags fires `subscriptions.setTags`.
 *   - Unchanged fields fire no mutation.
 *   - A failing mutation surfaces an error alert and keeps the dialog open.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { EditSubscriptionDialog } from "@/components/feeds/EditSubscriptionDialog";
import { renderWithTrpc, type ProcedureHandlers } from "../../../utils/component-test-helpers";

// sonner's toast is a side-effecting singleton (renders a portal); stub it so
// tests assert on component behavior, not the toast implementation.
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

const TAGS = [
  { id: "tag-1", name: "Tech", color: "#ff0000" },
  { id: "tag-2", name: "Science", color: "#00ff00" },
];

function baseHandlers(overrides: ProcedureHandlers = {}): ProcedureHandlers {
  return {
    "tags.list": () => ({
      items: TAGS.map((t) => ({
        ...t,
        feedCount: 1,
        unreadCount: 0,
        createdAt: new Date("2024-01-01"),
      })),
      uncategorized: { feedCount: 0, unreadCount: 0 },
    }),
    "subscriptions.update": (input) => ({ id: (input as { id: string }).id }),
    "subscriptions.setTags": (input) => ({ id: (input as { id: string }).id }),
    ...overrides,
  };
}

function defaultProps(
  overrides: Partial<React.ComponentProps<typeof EditSubscriptionDialog>> = {}
) {
  return {
    isOpen: true,
    subscriptionId: "sub-1",
    currentTitle: "Feed One",
    currentCustomTitle: null,
    currentTagIds: [] as string[],
    onClose: vi.fn(),
    ...overrides,
  };
}

describe("EditSubscriptionDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not render when closed", () => {
    renderWithTrpc(<EditSubscriptionDialog {...defaultProps({ isOpen: false })} />, {
      handlers: baseHandlers(),
    });
    expect(screen.queryByText("Edit Subscription")).not.toBeInTheDocument();
  });

  it("renders tag chips loaded from tags.list", async () => {
    renderWithTrpc(<EditSubscriptionDialog {...defaultProps()} />, {
      handlers: baseHandlers(),
    });

    expect(await screen.findByText("Tech")).toBeInTheDocument();
    expect(screen.getByText("Science")).toBeInTheDocument();
    // Feed title is shown for context.
    expect(screen.getByText("Feed One")).toBeInTheDocument();
  });

  it("shows the empty-state message when there are no tags", async () => {
    renderWithTrpc(<EditSubscriptionDialog {...defaultProps()} />, {
      handlers: baseHandlers({
        "tags.list": () => ({ items: [], uncategorized: { feedCount: 0, unreadCount: 0 } }),
      }),
    });

    expect(await screen.findByText(/No tags created yet/)).toBeInTheDocument();
  });

  it("saves a changed custom title via subscriptions.update", async () => {
    const onClose = vi.fn();
    const { callsFor } = renderWithTrpc(<EditSubscriptionDialog {...defaultProps({ onClose })} />, {
      handlers: baseHandlers(),
    });

    await screen.findByText("Tech");

    fireEvent.change(screen.getByLabelText(/Custom Title/), {
      target: { value: "My Custom Name" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));

    const updateCalls = callsFor("subscriptions.update");
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].input).toEqual({ id: "sub-1", customTitle: "My Custom Name" });
    // Tags were unchanged, so no setTags call.
    expect(callsFor("subscriptions.setTags")).toHaveLength(0);
  });

  it("clears the custom title when emptied (sends null)", async () => {
    const onClose = vi.fn();
    const { callsFor } = renderWithTrpc(
      <EditSubscriptionDialog
        {...defaultProps({ onClose, currentCustomTitle: "Existing Name" })}
      />,
      { handlers: baseHandlers() }
    );

    await screen.findByText("Tech");

    fireEvent.change(screen.getByLabelText(/Custom Title/), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(callsFor("subscriptions.update")[0].input).toEqual({ id: "sub-1", customTitle: null });
  });

  it("saves changed tags via subscriptions.setTags", async () => {
    const onClose = vi.fn();
    const { callsFor } = renderWithTrpc(<EditSubscriptionDialog {...defaultProps({ onClose })} />, {
      handlers: baseHandlers(),
    });

    await screen.findByText("Tech");
    fireEvent.click(screen.getByRole("button", { name: /Tech/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));

    const setTagsCalls = callsFor("subscriptions.setTags");
    expect(setTagsCalls).toHaveLength(1);
    expect(setTagsCalls[0].input).toEqual({ id: "sub-1", tagIds: ["tag-1"] });
    // Title unchanged, so no update call.
    expect(callsFor("subscriptions.update")).toHaveLength(0);
  });

  it("fires no mutations and closes when nothing changed", async () => {
    const onClose = vi.fn();
    const { callsFor } = renderWithTrpc(
      <EditSubscriptionDialog {...defaultProps({ onClose, currentTagIds: ["tag-1"] })} />,
      { handlers: baseHandlers() }
    );

    await screen.findByText("Tech");
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(callsFor("subscriptions.update")).toHaveLength(0);
    expect(callsFor("subscriptions.setTags")).toHaveLength(0);
  });

  it("shows an error alert and stays open when a mutation fails", async () => {
    const onClose = vi.fn();
    renderWithTrpc(<EditSubscriptionDialog {...defaultProps({ onClose })} />, {
      handlers: baseHandlers({
        "subscriptions.update": () => {
          throw new Error("Server exploded");
        },
      }),
    });

    await screen.findByText("Tech");
    fireEvent.change(screen.getByLabelText(/Custom Title/), { target: { value: "New Title" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    expect(await screen.findByText("Server exploded")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});
