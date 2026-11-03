/**
 * Verify Email Page
 *
 * Where the emailed verification link lands. The link only works for the
 * account that's signed in (`src/server/services/account-email.ts` says why),
 * so a signed-out visitor signs in first and comes back here.
 */

import { redirect } from "next/navigation";
import { TRPCProvider } from "@/lib/trpc/provider";
import { AuthErrorHandler } from "@/components/app/AuthErrorHandler";
import { AuthLayoutContent } from "@/components/auth/AuthLayoutContent";
import { VerifyEmail } from "@/components/auth/VerifyEmail";
import { getRequestSession } from "@/server/auth/request-session";

interface VerifyEmailPageProps {
  searchParams: Promise<{ token?: string }>;
}

export default async function VerifyEmailPage({ searchParams }: VerifyEmailPageProps) {
  const token = (await searchParams).token ?? "";
  if (!(await getRequestSession())) {
    const returnTo = `/verify-email?token=${encodeURIComponent(token)}`;
    redirect(`/login?redirect=${encodeURIComponent(returnTo)}`);
  }

  return (
    <TRPCProvider>
      <AuthErrorHandler />
      <AuthLayoutContent subtitle="Verify your email">
        <VerifyEmail token={token} />
      </AuthLayoutContent>
    </TRPCProvider>
  );
}
