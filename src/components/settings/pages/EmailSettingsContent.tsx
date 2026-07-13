/**
 * Email Settings Page
 *
 * Manages email ingest addresses for newsletter subscriptions.
 * Users can create, edit, copy, and delete ingest addresses.
 * Also includes spam visibility preference toggle.
 */

"use client";

import { useState } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert } from "@/components/ui/alert";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { SettingsListContainer } from "@/components/settings/SettingsListContainer";
import { PlusIcon, CheckIcon, CopyIcon, EditIcon } from "@/components/ui/icon-button";
import BlockedSendersSettingsContent from "./BlockedSendersSettingsContent";

// ============================================================================
// Types
// ============================================================================

interface IngestAddress {
  id: string;
  token: string;
  email: string;
  label: string | null;
  createdAt: Date;
}

// ============================================================================
// Main Component
// ============================================================================

export default function EmailSettingsContent() {
  return (
    <div className="space-y-8">
      {/* Page Header */}
      <div>
        <h2 className="ui-text-lg text-strong font-semibold">Email Subscriptions</h2>
        <p className="ui-text-sm text-muted mt-1">
          Create ingest addresses to subscribe to email newsletters. Emails sent to these addresses
          will appear as entries in your feeds.
        </p>
      </div>

      {/* Ingest Addresses Section */}
      <IngestAddressesSection />

      {/* Spam Preference Section */}
      <SpamPreferenceSection />

      {/* Blocked Senders Section */}
      <BlockedSendersSettingsContent />
    </div>
  );
}

// ============================================================================
// Ingest Addresses Section
// ============================================================================

function IngestAddressesSection() {
  const [isCreating, setIsCreating] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);

  const utils = trpc.useUtils();
  const addressesQuery = trpc.ingestAddresses.list.useQuery();

  const createMutation = trpc.ingestAddresses.create.useMutation({
    onSuccess: () => {
      setIsCreating(false);
      setNewLabel("");
      setCreateError(null);
      utils.ingestAddresses.list.invalidate();
      toast.success("Ingest address created");
    },
    onError: (error) => {
      setCreateError(error.message);
      toast.error("Failed to create ingest address");
    },
  });

  const handleCreate = () => {
    setCreateError(null);
    createMutation.mutate({ label: newLabel.trim() || undefined });
  };

  const handleCancelCreate = () => {
    setIsCreating(false);
    setNewLabel("");
    setCreateError(null);
  };

  const addresses = addressesQuery.data?.items ?? [];

  return (
    <section>
      <div className="mb-4 flex items-center justify-between">
        <h3 className="ui-text-sm text-strong font-medium">Ingest Addresses</h3>
        <span className="ui-text-sm text-muted">{addresses.length} / 5</span>
      </div>

      <SettingsListContainer
        items={addresses}
        isLoading={addressesQuery.isLoading}
        error={addressesQuery.error}
        errorMessage="Failed to load ingest addresses. Please try again."
        skeletonCount={2}
        skeletonHeight="h-16"
        emptyState={
          isCreating ? (
            <></>
          ) : (
            <div className="p-6 text-center">
              <p className="ui-text-sm text-muted">
                No ingest addresses yet. Create one to start receiving newsletter emails.
              </p>
            </div>
          )
        }
        renderItem={(address) => <IngestAddressRow key={address.id} address={address} />}
        footer={
          <>
            {/* Create Form */}
            {isCreating && (
              <div className="border-edge border-t p-4">
                {createError && (
                  <Alert variant="error" className="mb-4">
                    {createError}
                  </Alert>
                )}
                <div className="space-y-4">
                  <Input
                    id="new-address-label"
                    label="Label (optional)"
                    placeholder="e.g., Tech newsletters, Personal"
                    value={newLabel}
                    onChange={(e) => setNewLabel(e.target.value)}
                    disabled={createMutation.isPending}
                  />
                  <div className="flex gap-3">
                    <Button
                      variant="secondary"
                      onClick={handleCancelCreate}
                      disabled={createMutation.isPending}
                    >
                      Cancel
                    </Button>
                    <Button onClick={handleCreate} loading={createMutation.isPending}>
                      Create Address
                    </Button>
                  </div>
                </div>
              </div>
            )}

            {/* Create Button */}
            {!isCreating && addresses.length < 5 && (
              <div className="border-edge border-t p-4">
                <Button variant="secondary" onClick={() => setIsCreating(true)}>
                  <PlusIcon className="mr-2 h-4 w-4" />
                  Create New Address
                </Button>
              </div>
            )}
          </>
        }
      />
    </section>
  );
}

// ============================================================================
// Ingest Address Row
// ============================================================================

interface IngestAddressRowProps {
  address: IngestAddress;
}

function IngestAddressRow({ address }: IngestAddressRowProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editLabel, setEditLabel] = useState(address.label ?? "");
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [copied, setCopied] = useState(false);

  const utils = trpc.useUtils();

  const updateMutation = trpc.ingestAddresses.update.useMutation({
    onSuccess: () => {
      setIsEditing(false);
      utils.ingestAddresses.list.invalidate();
      toast.success("Address updated");
    },
    onError: (error) => {
      toast.error(error.message || "Failed to update address");
    },
  });

  const deleteMutation = trpc.ingestAddresses.delete.useMutation({
    onSuccess: () => {
      setShowDeleteConfirm(false);
      utils.ingestAddresses.list.invalidate();
      toast.success("Address deleted");
    },
    onError: (error) => {
      toast.error(error.message || "Failed to delete address");
    },
  });

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(address.email);
      setCopied(true);
      toast.success("Email address copied to clipboard");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Failed to copy to clipboard");
    }
  };

  const handleSaveLabel = () => {
    updateMutation.mutate({
      id: address.id,
      label: editLabel.trim() || null,
    });
  };

  const handleCancelEdit = () => {
    setIsEditing(false);
    setEditLabel(address.label ?? "");
  };

  const handleDelete = () => {
    deleteMutation.mutate({ id: address.id });
  };

  return (
    <div className="p-4">
      {/* Delete Confirmation Dialog */}
      <Dialog
        isOpen={showDeleteConfirm}
        onClose={() => setShowDeleteConfirm(false)}
        title="Delete Ingest Address"
        size="sm"
      >
        <DialogHeader>
          <DialogTitle>Delete Ingest Address</DialogTitle>
          <DialogDescription>
            Are you sure you want to delete this address? Future emails sent to{" "}
            <span className="font-medium">{address.email}</span> will be rejected. Existing feeds
            and entries will not be affected.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="secondary"
            onClick={() => setShowDeleteConfirm(false)}
            disabled={deleteMutation.isPending}
          >
            Cancel
          </Button>
          <Button
            onClick={handleDelete}
            loading={deleteMutation.isPending}
            className="bg-danger-solid hover:bg-danger-solid-hover"
          >
            Delete
          </Button>
        </DialogFooter>
      </Dialog>

      {/* Main Row Content */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          {/* Email Address */}
          <div className="flex items-center gap-2">
            <code className="ui-text-sm bg-surface-muted text-emphasis rounded px-2 py-1 break-all">
              {address.email}
            </code>
            <button
              type="button"
              onClick={handleCopy}
              className="text-muted hover:bg-surface-muted hover:text-body flex-shrink-0 rounded p-1 transition-colors"
              title="Copy email address"
            >
              {copied ? (
                <CheckIcon className="text-success h-4 w-4" />
              ) : (
                <CopyIcon className="h-4 w-4" />
              )}
            </button>
          </div>

          {/* Label */}
          {isEditing ? (
            <div className="mt-2 flex items-center gap-2">
              <Input
                id={`edit-label-${address.id}`}
                placeholder="Add a label"
                value={editLabel}
                onChange={(e) => setEditLabel(e.target.value)}
                disabled={updateMutation.isPending}
                className="max-w-xs"
              />
              <Button size="sm" onClick={handleSaveLabel} loading={updateMutation.isPending}>
                Save
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={handleCancelEdit}
                disabled={updateMutation.isPending}
              >
                Cancel
              </Button>
            </div>
          ) : (
            <div className="mt-1 flex items-center gap-2">
              {address.label ? (
                <span className="ui-text-sm text-muted">{address.label}</span>
              ) : (
                <span className="ui-text-sm text-faint">No label</span>
              )}
              <button
                type="button"
                onClick={() => setIsEditing(true)}
                className="text-faint hover:text-muted rounded p-0.5 transition-colors"
                title="Edit label"
              >
                <EditIcon className="h-3.5 w-3.5" />
              </button>
            </div>
          )}

          {/* Created Date */}
          <p className="ui-text-xs text-faint mt-1">
            Created{" "}
            {new Date(address.createdAt).toLocaleDateString("en-US", {
              month: "short",
              day: "numeric",
              year: "numeric",
            })}
          </p>
        </div>

        {/* Delete Button */}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setShowDeleteConfirm(true)}
          className="text-danger hover:bg-danger-subtle hover:text-danger-hover"
        >
          Delete
        </Button>
      </div>
    </div>
  );
}

// ============================================================================
// Spam Preference Section
// ============================================================================

function SpamPreferenceSection() {
  const preferencesQuery = trpc.users["me.preferences"].useQuery();
  const utils = trpc.useUtils();

  const updateMutation = trpc.users["me.updatePreferences"].useMutation({
    onMutate: async (newPrefs) => {
      // Cancel outgoing queries
      await utils.users["me.preferences"].cancel();

      // Snapshot previous value
      const previousPrefs = utils.users["me.preferences"].getData();

      // Optimistically update
      utils.users["me.preferences"].setData(undefined, (old) =>
        old ? { ...old, showSpam: newPrefs.showSpam ?? old.showSpam } : undefined
      );

      return { previousPrefs };
    },
    onError: (_error, _newPrefs, context) => {
      // Rollback on error
      if (context?.previousPrefs) {
        utils.users["me.preferences"].setData(undefined, context.previousPrefs);
      }
      toast.error("Failed to update preference");
    },
    onSuccess: () => {
      toast.success("Preference updated");
    },
    onSettled: (_data, error) => {
      // Only invalidate on error since optimistic update handles the success case
      if (error) {
        utils.users["me.preferences"].invalidate();
      }
    },
  });

  const showSpam = preferencesQuery.data?.showSpam ?? false;

  const handleToggle = () => {
    updateMutation.mutate({ showSpam: !showSpam });
  };

  return (
    <section>
      <h3 className="ui-text-sm text-strong mb-4 font-medium">Preferences</h3>
      <Card>
        <div className="flex items-center justify-between">
          <div>
            <h4 className="ui-text-sm text-strong font-medium">Show spam entries</h4>
            <p className="ui-text-sm text-muted mt-1">
              Display entries that were flagged as spam by our email provider.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={showSpam}
            onClick={handleToggle}
            disabled={preferencesQuery.isLoading || updateMutation.isPending}
            className={`focus:ring-focus focus:ring-offset-surface relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:ring-2 focus:ring-offset-2 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 ${
              showSpam ? "bg-primary-solid" : "bg-fill-muted"
            }`}
          >
            <span
              aria-hidden="true"
              className={`bg-surface pointer-events-none inline-block h-5 w-5 transform rounded-full shadow ring-0 transition duration-200 ease-in-out ${
                showSpam ? "translate-x-5" : "translate-x-0"
              }`}
            />
          </button>
        </div>
      </Card>
    </section>
  );
}
