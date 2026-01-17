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
import { Button, Input, Alert } from "@/components/ui";

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

export default function EmailSettingsPage() {
  return (
    <div className="space-y-8">
      {/* Page Header */}
      <div>
        <h2 className="ui-text-lg font-semibold text-zinc-900 dark:text-zinc-50">
          Email Subscriptions
        </h2>
        <p className="ui-text-sm mt-1 text-zinc-600 dark:text-zinc-400">
          Create ingest addresses to subscribe to email newsletters. Emails sent to these addresses
          will appear as entries in your feeds.
        </p>
      </div>

      {/* Ingest Addresses Section */}
      <IngestAddressesSection />

      {/* Spam Preference Section */}
      <SpamPreferenceSection />
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
        <h3 className="ui-text-sm font-medium text-zinc-900 dark:text-zinc-50">Ingest Addresses</h3>
        <span className="ui-text-sm text-zinc-500 dark:text-zinc-400">{addresses.length} / 5</span>
      </div>

      <div className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        {/* Address List */}
        {addressesQuery.isLoading ? (
          <div className="p-6">
            {[1, 2].map((i) => (
              <div
                key={i}
                className="mb-4 h-16 animate-pulse rounded bg-zinc-100 last:mb-0 dark:bg-zinc-800"
              />
            ))}
          </div>
        ) : addressesQuery.error ? (
          <div className="p-6">
            <Alert variant="error">Failed to load ingest addresses. Please try again.</Alert>
          </div>
        ) : addresses.length === 0 && !isCreating ? (
          <div className="p-6 text-center">
            <p className="ui-text-sm text-zinc-500 dark:text-zinc-400">
              No ingest addresses yet. Create one to start receiving newsletter emails.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-zinc-200 dark:divide-zinc-800">
            {addresses.map((address) => (
              <IngestAddressRow key={address.id} address={address} />
            ))}
          </div>
        )}

        {/* Create Form */}
        {isCreating && (
          <div className="border-t border-zinc-200 p-4 dark:border-zinc-800">
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
          <div className="border-t border-zinc-200 p-4 dark:border-zinc-800">
            <Button variant="secondary" onClick={() => setIsCreating(true)}>
              <svg className="mr-2 h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 4v16m8-8H4"
                />
              </svg>
              Create New Address
            </Button>
          </div>
        )}
      </div>
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
      {showDeleteConfirm && (
        <>
          <div
            className="fixed inset-0 z-50 bg-black/50"
            onClick={() => setShowDeleteConfirm(false)}
          />
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="w-full max-w-sm rounded-lg border border-zinc-200 bg-white p-6 shadow-xl dark:border-zinc-700 dark:bg-zinc-900">
              <h3 className="ui-text-lg font-semibold text-zinc-900 dark:text-zinc-50">
                Delete Ingest Address
              </h3>
              <p className="ui-text-sm mt-2 text-zinc-600 dark:text-zinc-400">
                Are you sure you want to delete this address? Future emails sent to{" "}
                <span className="font-medium">{address.email}</span> will be rejected. Existing
                feeds and entries will not be affected.
              </p>
              <div className="mt-4 flex justify-end gap-3">
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
                  className="bg-red-600 hover:bg-red-700 dark:bg-red-600 dark:hover:bg-red-700"
                >
                  Delete
                </Button>
              </div>
            </div>
          </div>
        </>
      )}

      {/* Main Row Content */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          {/* Email Address */}
          <div className="flex items-center gap-2">
            <code className="ui-text-sm rounded bg-zinc-100 px-2 py-1 break-all text-zinc-800 dark:bg-zinc-800 dark:text-zinc-200">
              {address.email}
            </code>
            <button
              type="button"
              onClick={handleCopy}
              className="flex-shrink-0 rounded p-1 text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
              title="Copy email address"
            >
              {copied ? (
                <svg
                  className="h-4 w-4 text-green-600 dark:text-green-400"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M5 13l4 4L19 7"
                  />
                </svg>
              ) : (
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
                  />
                </svg>
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
                <span className="ui-text-sm text-zinc-600 dark:text-zinc-400">{address.label}</span>
              ) : (
                <span className="ui-text-sm text-zinc-400 dark:text-zinc-500">No label</span>
              )}
              <button
                type="button"
                onClick={() => setIsEditing(true)}
                className="rounded p-0.5 text-zinc-400 transition-colors hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300"
                title="Edit label"
              >
                <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"
                  />
                </svg>
              </button>
            </div>
          )}

          {/* Created Date */}
          <p className="ui-text-xs mt-1 text-zinc-400 dark:text-zinc-500">
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
          className="text-red-600 hover:bg-red-50 hover:text-red-700 dark:text-red-400 dark:hover:bg-red-950 dark:hover:text-red-300"
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
      utils.users["me.preferences"].setData(undefined, (old) => ({
        showSpam: newPrefs.showSpam ?? old?.showSpam ?? false,
      }));

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
      <h3 className="ui-text-sm mb-4 font-medium text-zinc-900 dark:text-zinc-50">Preferences</h3>
      <div className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex items-center justify-between">
          <div>
            <h4 className="ui-text-sm font-medium text-zinc-900 dark:text-zinc-50">
              Show spam entries
            </h4>
            <p className="ui-text-sm mt-1 text-zinc-500 dark:text-zinc-400">
              Display entries that were flagged as spam by our email provider.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={showSpam}
            onClick={handleToggle}
            disabled={preferencesQuery.isLoading || updateMutation.isPending}
            className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:ring-2 focus:ring-zinc-500 focus:ring-offset-2 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 dark:focus:ring-offset-zinc-900 ${
              showSpam ? "bg-zinc-900 dark:bg-zinc-50" : "bg-zinc-200 dark:bg-zinc-700"
            }`}
          >
            <span
              aria-hidden="true"
              className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out dark:bg-zinc-900 ${
                showSpam ? "translate-x-5" : "translate-x-0"
              }`}
            />
          </button>
        </div>
      </div>
    </section>
  );
}
