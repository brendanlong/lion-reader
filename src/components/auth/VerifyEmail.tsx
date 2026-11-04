"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { trpc } from "@/lib/trpc/client";
import { Alert } from "@/components/ui/alert";
import { PageLink } from "@/components/ui/page-link";

/** Uses an emailed verification token as soon as the page opens. */
export function VerifyEmail({ token }: { token: string }) {
  const router = useRouter();
  const verifyMutation = trpc.auth.verifyEmail.useMutation({
    // `/` sends the user on to the app, or to whatever signup step is left.
    onSuccess: () => router.replace("/"),
  });

  // Once only: the token is single-use, so a second (Strict Mode) call would fail.
  const started = useRef(false);
  useEffect(() => {
    if (started.current || !token) return;
    started.current = true;
    verifyMutation.mutate({ token });
  }, [token, verifyMutation]);

  if (!token || verifyMutation.isError) {
    return (
      <Alert variant="error">
        {verifyMutation.error?.message ?? "This verification link is incomplete."}{" "}
        <PageLink href="/complete-signup" className="underline">
          Send a new link
        </PageLink>
      </Alert>
    );
  }

  return (
    <p className="ui-text-sm text-muted text-center">
      {verifyMutation.isSuccess ? "Email verified. Taking you to Lion Reader…" : "Verifying…"}
    </p>
  );
}
