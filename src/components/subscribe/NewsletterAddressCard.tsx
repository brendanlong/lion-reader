"use client";

import { toast } from "sonner";
import { trpc } from "@/lib/trpc/client";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ClientLink } from "@/components/ui/client-link";
import { CopyButton } from "@/components/ui/copy-button";

/**
 * Shows the user's oldest newsletter address (it never changes as they add
 * more), so subscribing by email is visible alongside subscribing by URL.
 */
export function NewsletterAddressCard() {
  const utils = trpc.useUtils();
  const addressesQuery = trpc.ingestAddresses.list.useQuery();

  const createMutation = trpc.ingestAddresses.create.useMutation({
    // Stay pending until the list shows the new address, so the button can't
    // be clicked again in between.
    onSuccess: () => utils.ingestAddresses.list.invalidate(),
    onError: (error) => {
      toast.error("Failed to create email address", { description: error.message });
    },
  });

  const data = addressesQuery.data;
  if (!data?.enabled) return null;

  // The list is newest first.
  const address = data.items.at(-1);

  return (
    <Card className="mt-4">
      <h2 className="ui-text-lg text-body mb-2 font-semibold">Subscribe by email</h2>
      <p className="ui-text-sm text-muted mb-4">
        Sign up for newsletters with your Lion Reader address and each sender shows up as a feed.
      </p>

      {address ? (
        <div className="flex items-center gap-2">
          <code className="control-outline ui-text-sm bg-surface-muted text-body rounded px-2 py-1 break-all">
            {address.email}
          </code>
          <CopyButton
            value={address.email}
            className="shrink-0 px-2 py-1"
            title="Copy email address"
          />
        </div>
      ) : (
        <Button
          variant="secondary"
          onClick={() => createMutation.mutate({})}
          loading={createMutation.isPending}
        >
          Create an email address
        </Button>
      )}

      <p className="ui-text-sm text-muted mt-4">
        <ClientLink
          href="/settings/email"
          className="text-accent hover:text-accent-hover font-medium"
        >
          Manage email addresses
        </ClientLink>
      </p>
    </Card>
  );
}
