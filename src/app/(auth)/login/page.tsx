/**
 * Login Page
 *
 * Allows users to sign in with their email and password.
 */

"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { trpc } from "@/lib/trpc/client";
import { Button, Input, Alert } from "@/components/ui";

export default function LoginPage() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<{
    email?: string;
    password?: string;
    form?: string;
  }>({});

  // Get success message from registration redirect
  const registered = searchParams.get("registered") === "true";

  const loginMutation = trpc.auth.login.useMutation({
    onSuccess: (data) => {
      // Store the session token in a cookie (must match context.ts "session" cookie name)
      document.cookie = `session=${data.sessionToken}; path=/; max-age=${30 * 24 * 60 * 60}; samesite=lax`;

      // Get the redirect URL from query params or default to /all
      const redirectTo = searchParams.get("redirect") ?? "/all";
      router.push(redirectTo);
      router.refresh();
    },
    onError: (error) => {
      // Handle specific error codes
      if (error.data?.code === "UNAUTHORIZED") {
        setErrors({ form: "Invalid email or password" });
      } else {
        setErrors({ form: error.message || "An error occurred. Please try again." });
      }
    },
  });

  const validateForm = (): boolean => {
    const newErrors: typeof errors = {};

    if (!email.trim()) {
      newErrors.email = "Email is required";
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      newErrors.email = "Please enter a valid email address";
    }

    if (!password) {
      newErrors.password = "Password is required";
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    if (!validateForm()) {
      return;
    }

    loginMutation.mutate({ email, password });
  };

  return (
    <div>
      <h2 className="mb-6 text-xl font-semibold text-zinc-900 dark:text-zinc-50">
        Sign in to your account
      </h2>

      {registered && (
        <Alert variant="success" className="mb-4">
          Account created successfully. Please sign in.
        </Alert>
      )}

      {errors.form && (
        <Alert variant="error" className="mb-4">
          {errors.form}
        </Alert>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        <Input
          id="email"
          type="email"
          label="Email"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={errors.email}
          autoComplete="email"
          disabled={loginMutation.isPending}
        />

        <Input
          id="password"
          type="password"
          label="Password"
          placeholder="Enter your password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={errors.password}
          autoComplete="current-password"
          disabled={loginMutation.isPending}
        />

        <Button type="submit" className="w-full" loading={loginMutation.isPending}>
          Sign in
        </Button>
      </form>

      <p className="mt-6 text-center text-sm text-zinc-600 dark:text-zinc-400">
        Don&apos;t have an account?{" "}
        <Link
          href="/register"
          className="font-medium text-zinc-900 hover:underline dark:text-zinc-50"
        >
          Create one
        </Link>
      </p>
    </div>
  );
}
