/**
 * OAuth Consent Form
 *
 * Client component for the OAuth consent screen.
 * Handles form submission for approve/deny actions.
 */

"use client";

import { CheckIcon, ShieldCheckIcon, WarningTriangleIcon } from "@/components/ui/icon-button";

interface ScopeInfo {
  name: string;
  description: string;
}

interface ConsentFormProps {
  clientName: string;
  clientId: string;
  redirectUri: string;
  scopes: ScopeInfo[];
  scopeString: string;
  codeChallenge: string;
  state?: string;
  resource?: string;
}

export function ConsentForm({
  clientName,
  clientId,
  redirectUri,
  scopes,
  scopeString,
  codeChallenge,
  state,
  resource,
}: ConsentFormProps) {
  return (
    <div>
      {/* Application info */}
      <div className="mb-6 text-center">
        <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-zinc-100 dark:bg-zinc-800">
          <ShieldCheckIcon className="h-8 w-8 text-zinc-600 dark:text-zinc-400" />
        </div>
        <h2 className="ui-text-lg font-semibold text-zinc-900 dark:text-zinc-50">
          Authorize {clientName}
        </h2>
        <p className="ui-text-sm mt-2 text-zinc-600 dark:text-zinc-400">
          This application wants to access your Lion Reader account
        </p>
      </div>

      {/* Requested permissions */}
      <div className="mb-6 rounded-lg border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-700 dark:bg-zinc-800/50">
        <h3 className="ui-text-sm mb-3 font-medium text-zinc-900 dark:text-zinc-100">
          This will allow {clientName} to:
        </h3>
        <ul className="space-y-2">
          {scopes.map((scope) => (
            <li key={scope.name} className="flex items-start gap-2">
              <CheckIcon className="mt-0.5 h-4 w-4 shrink-0 text-green-600 dark:text-green-400" />
              <span className="ui-text-sm text-zinc-700 dark:text-zinc-300">
                {scope.description}
              </span>
            </li>
          ))}
        </ul>
      </div>

      {/* Warning */}
      <div className="mb-6 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-900/50 dark:bg-amber-900/20">
        <WarningTriangleIcon className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <p className="ui-text-sm text-amber-800 dark:text-amber-200">
          Only authorize applications you trust. You can revoke access at any time in Settings.
        </p>
      </div>

      {/* Action buttons */}
      <form action="/oauth/authorize" method="POST">
        <input type="hidden" name="client_id" value={clientId} />
        <input type="hidden" name="redirect_uri" value={redirectUri} />
        <input type="hidden" name="scope" value={scopeString} />
        <input type="hidden" name="code_challenge" value={codeChallenge} />
        {state && <input type="hidden" name="state" value={state} />}
        {resource && <input type="hidden" name="resource" value={resource} />}

        <div className="flex gap-3">
          <button
            type="submit"
            name="user_action"
            value="deny"
            className="ui-text-sm flex-1 rounded-lg border border-zinc-300 bg-white px-4 py-2.5 font-medium text-zinc-700 transition-colors hover:bg-zinc-50 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
          >
            Deny
          </button>
          <button
            type="submit"
            name="user_action"
            value="approve"
            className="ui-text-sm flex-1 rounded-lg bg-zinc-900 px-4 py-2.5 font-medium text-white transition-colors hover:bg-zinc-800 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
          >
            Authorize
          </button>
        </div>
      </form>

      {/* Client ID info */}
      <p className="ui-text-xs mt-4 text-center text-zinc-500 dark:text-zinc-500">
        Client ID: {clientId.length > 50 ? `${clientId.slice(0, 50)}...` : clientId}
      </p>
    </div>
  );
}
