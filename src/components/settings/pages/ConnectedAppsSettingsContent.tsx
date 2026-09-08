/**
 * Connected Apps Settings Page
 *
 * Lists the OAuth applications the user has authorized and lets them revoke
 * one. Revoking is what the consent screen promises: it drops the stored
 * consent (so the app has to ask again) and kills its live tokens.
 */

"use client";

import { toast } from "sonner";
import { trpc } from "@/lib/trpc/client";
import { Button } from "@/components/ui/button";
import { SettingsListContainer } from "@/components/settings/SettingsListContainer";
import { CheckIcon, ShieldCheckIcon } from "@/components/ui/icons";
import { formatRelativeTime } from "@/lib/format";

interface ConnectedApp {
  clientId: string;
  clientName: string | null;
  clientHost: string | null;
  scopes: { name: string; description: string }[];
  grantedAt: Date;
  lastUsedAt: Date | null;
}

export default function ConnectedAppsSettingsContent() {
  const appsQuery = trpc.oauthGrants.list.useQuery();
  const utils = trpc.useUtils();

  const revokeMutation = trpc.oauthGrants.revoke.useMutation({
    onSuccess: () => {
      utils.oauthGrants.list.invalidate();
      toast.success("Access revoked");
    },
    onError: (error) => {
      toast.error(error.message || "Failed to revoke access");
    },
  });

  const handleRevoke = (app: ConnectedApp) => {
    const label = appDisplayName(app);
    if (
      confirm(
        `Revoke access for ${label}? It will be signed out immediately and will have to ask for your permission again.`
      )
    ) {
      revokeMutation.mutate({ clientId: app.clientId });
    }
  };

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="ui-text-lg text-body font-semibold">Connected Apps</h2>
        <span className="ui-text-sm text-muted">{appsQuery.data?.length ?? 0} authorized</span>
      </div>

      <p className="ui-text-sm text-muted mb-6">
        These applications can access your account without asking again. Revoking signs an
        application out and makes it request your permission the next time it connects.
      </p>

      <SettingsListContainer
        items={appsQuery.data}
        isLoading={appsQuery.isLoading}
        error={appsQuery.error}
        errorMessage="Failed to load connected apps. Please try again."
        variant="card"
        emptyMessage="You haven't authorized any applications."
        renderItem={(app) => (
          <ConnectedAppCard
            key={app.clientId}
            app={app}
            onRevoke={handleRevoke}
            isRevoking={revokeMutation.isPending}
          />
        )}
      />
    </div>
  );
}

/**
 * The hostname leads for CIMD clients (their name is self-asserted in a
 * document we don't control), matching the consent screen.
 */
function appDisplayName(app: ConnectedApp): string {
  return app.clientHost ?? app.clientName ?? app.clientId;
}

function ConnectedAppCard({
  app,
  onRevoke,
  isRevoking,
}: {
  app: ConnectedApp;
  onRevoke: (app: ConnectedApp) => void;
  isRevoking: boolean;
}) {
  return (
    <div className="border-edge epaper:border-fill-muted bg-surface rounded-lg border p-3 sm:p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <div className="control-outline bg-surface-muted flex h-8 w-8 shrink-0 items-center justify-center rounded-full">
              <ShieldCheckIcon className="text-muted h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-body font-medium break-all">{appDisplayName(app)}</p>
              {app.clientHost && app.clientName && (
                <p className="ui-text-sm text-muted break-all">
                  identifies itself as &ldquo;{app.clientName}&rdquo;
                </p>
              )}
            </div>
          </div>

          <ul className="mt-2 space-y-1">
            {app.scopes.map((scope) => (
              <li key={scope.name} className="flex items-start gap-2">
                <CheckIcon className="text-success mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span className="ui-text-sm text-body">{scope.description}</span>
              </li>
            ))}
          </ul>

          <div className="ui-text-xs text-muted mt-2 flex flex-wrap gap-x-4 gap-y-1">
            <span>Authorized: {formatRelativeTime(new Date(app.grantedAt))}</span>
            {app.lastUsedAt && (
              <span>Last used: {formatRelativeTime(new Date(app.lastUsedAt))}</span>
            )}
          </div>
        </div>

        <Button
          variant="ghost"
          size="sm"
          onClick={() => onRevoke(app)}
          disabled={isRevoking}
          className="text-danger hover:bg-danger-subtle hover:text-danger-hover w-full sm:w-auto"
        >
          Revoke
        </Button>
      </div>
    </div>
  );
}
