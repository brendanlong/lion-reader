/**
 * Complete Signup Page
 *
 * Requires users to verify their email address and accept the Terms of Service
 * and Privacy Policy — and, on EU-restricted instances (EU_RESTRICTED=true,
 * surfaced via the `euRestricted` signup-config flag), to confirm they are not
 * in the EU — before they can use the app. Also provides a button to delete
 * their account if they don't want to proceed.
 */

"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { trpc } from "@/lib/trpc/client";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Alert } from "@/components/ui/alert";
import { PageLink } from "@/components/ui/page-link";
import { safeRedirectPath } from "@/lib/safe-redirect";
import { EuRestrictionReason } from "@/components/auth/EuRestrictionNotice";

/** How often to check whether the email was verified in another tab or browser. */
const VERIFICATION_POLL_MS = 5000;

export default function CompleteSignupPage() {
  const router = useRouter();
  const utils = trpc.useUtils();
  const { data: signupConfigData } = trpc.auth.signupConfig.useQuery();
  const euRestricted = signupConfigData?.euRestricted ?? false;
  const { data: meData } = trpc.auth.me.useQuery(undefined, {
    refetchInterval: (query) =>
      query.state.data && !query.state.data.user.emailVerifiedAt ? VERIFICATION_POLL_MS : false,
  });
  const user = meData?.user;
  const needsVerification = user ? !user.emailVerifiedAt : false;
  const needsConsent = user
    ? !user.tosAgreedAt || !user.privacyPolicyAgreedAt || (euRestricted && !user.notEuAgreedAt)
    : false;
  const isComplete =
    user !== undefined && signupConfigData !== undefined && !needsVerification && !needsConsent;

  const [acceptedTos, setAcceptedTos] = useState(false);
  const [acceptedPrivacy, setAcceptedPrivacy] = useState(false);
  const [confirmedNotInEu, setConfirmedNotInEu] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState("");

  useEffect(() => {
    if (!isComplete) return;
    // The OAuth callback passes on the login page's `?redirect=`.
    router.push(safeRedirectPath(new URLSearchParams(window.location.search).get("redirect")));
    router.refresh();
  }, [isComplete, router]);

  const confirmMutation = trpc.auth.confirmSignup.useMutation({
    onSuccess: () => utils.auth.me.invalidate(),
    onError: (err) => {
      setError(err.message);
    },
  });

  const resendMutation = trpc.auth.resendVerificationEmail.useMutation({
    onError: (err) => {
      setError(err.message);
    },
  });

  const deleteMutation = trpc.users["me.deleteAccount"].useMutation({
    onSuccess: () => {
      // The server cleared the httpOnly session cookie on the delete response.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- deliberate hard nav across an auth boundary (see src/CLAUDE.md)
      window.location.href = "/login";
    },
    onError: (err) => {
      setError(err.message);
    },
  });

  const allChecked = acceptedTos && acceptedPrivacy && (!euRestricted || confirmedNotInEu);
  const isDeleteConfirmed = deleteConfirmation === "delete";

  function handleConfirm() {
    setError(null);
    confirmMutation.mutate({
      acceptedTermsOfService: true,
      acceptedPrivacyPolicy: true,
      // Only sent when the instance requires it; the server ignores it otherwise.
      confirmedNotInEu: euRestricted ? true : undefined,
    });
  }

  function handleDelete() {
    setError(null);
    deleteMutation.mutate({ confirmation: deleteConfirmation });
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="ui-text-lg text-body font-semibold">Before you continue</h2>
        <p className="ui-text-sm text-muted mt-1">
          {needsConsent
            ? "Please review and accept the following to complete your account setup."
            : "One more step to complete your account setup."}
        </p>
      </div>

      {error && <Alert variant="error">{error}</Alert>}

      {needsVerification && user && (
        <div className="border-edge-input space-y-3 rounded-md border p-4">
          <h3 className="ui-text-base text-body font-semibold">Verify your email</h3>
          <p className="ui-text-sm text-muted">
            Open the verification link emailed to{" "}
            <span className="text-body font-medium">{user.email}</span> in this browser, while
            signed in. This page continues on its own once you&apos;re verified. Didn&apos;t get
            one?
          </p>
          {resendMutation.isSuccess && (
            <Alert variant="success">Sent. Check your inbox (and spam folder).</Alert>
          )}
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setError(null);
              resendMutation.mutate({});
            }}
            loading={resendMutation.isPending}
          >
            Send verification email
          </Button>
        </div>
      )}

      {needsConsent && (
        <>
          <div className="space-y-4">
            <ConsentCheckbox checked={acceptedTos} onChange={setAcceptedTos}>
              I have read and agree to the <PolicyLink href="/terms">Terms of Service</PolicyLink>
            </ConsentCheckbox>

            <ConsentCheckbox checked={acceptedPrivacy} onChange={setAcceptedPrivacy}>
              I have read and agree to the <PolicyLink href="/privacy">Privacy Policy</PolicyLink>
            </ConsentCheckbox>

            {euRestricted && (
              <ConsentCheckbox checked={confirmedNotInEu} onChange={setConfirmedNotInEu}>
                I confirm that I am not located in the European Union
              </ConsentCheckbox>
            )}

            {euRestricted && (
              <p className="ui-text-xs text-muted">
                <EuRestrictionReason />
              </p>
            )}
          </div>

          <Button
            onClick={handleConfirm}
            disabled={!allChecked || confirmMutation.isPending}
            loading={confirmMutation.isPending}
            className="w-full"
          >
            {needsVerification ? "Accept" : "Confirm and continue"}
          </Button>
        </>
      )}

      <div className="space-y-3">
        {!showDeleteConfirm ? (
          <button
            onClick={() => setShowDeleteConfirm(true)}
            className="ui-text-sm text-muted hover:text-body w-full text-center underline"
          >
            Delete my account instead
          </button>
        ) : (
          <div className="border-danger-border bg-danger-subtle rounded-md border p-4">
            <p className="ui-text-sm text-danger-subtle-foreground mb-3">
              This will permanently delete your account and all associated data. Type{" "}
              <span className="font-semibold">delete</span> to confirm.
            </p>
            <Input
              type="text"
              value={deleteConfirmation}
              onChange={(e) => setDeleteConfirmation(e.target.value)}
              placeholder="delete"
              autoComplete="off"
              disabled={deleteMutation.isPending}
              className="mb-3"
            />
            <div className="flex gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setShowDeleteConfirm(false);
                  setDeleteConfirmation("");
                }}
                disabled={deleteMutation.isPending}
              >
                Cancel
              </Button>
              <Button
                variant="danger"
                size="sm"
                onClick={handleDelete}
                loading={deleteMutation.isPending}
                disabled={!isDeleteConfirmed || deleteMutation.isPending}
              >
                Delete account
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ConsentCheckbox({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: ReactNode;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3">
      <Checkbox checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-1" />
      <span className="ui-text-sm text-body">{children}</span>
    </label>
  );
}

function PolicyLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <PageLink
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-body hover:text-body underline"
    >
      {children}
    </PageLink>
  );
}
