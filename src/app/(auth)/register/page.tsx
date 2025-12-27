/**
 * Registration Page
 *
 * Allows new users to create an account with email/password or OAuth.
 */

"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { trpc } from "@/lib/trpc/client";
import { Button, Input, Alert } from "@/components/ui";
import { GoogleSignInButton } from "@/components/auth";

export default function RegisterPage() {
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [errors, setErrors] = useState<{
    email?: string;
    password?: string;
    confirmPassword?: string;
    form?: string;
  }>({});

  const registerMutation = trpc.auth.register.useMutation({
    onSuccess: () => {
      // Redirect to login with success message
      router.push("/login?registered=true");
    },
    onError: (error) => {
      // Handle specific error codes
      if (error.data?.code === "CONFLICT") {
        setErrors({ email: "An account with this email already exists" });
      } else if (error.data?.code === "BAD_REQUEST") {
        // Parse validation errors from the message
        const message = error.message.toLowerCase();
        if (message.includes("email")) {
          setErrors({ email: error.message });
        } else if (message.includes("password")) {
          setErrors({ password: error.message });
        } else {
          setErrors({ form: error.message });
        }
      } else {
        setErrors({
          form: error.message || "An error occurred. Please try again.",
        });
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
    } else if (password.length < 8) {
      newErrors.password = "Password must be at least 8 characters";
    } else if (password.length > 128) {
      newErrors.password = "Password must be less than 128 characters";
    }

    if (!confirmPassword) {
      newErrors.confirmPassword = "Please confirm your password";
    } else if (password !== confirmPassword) {
      newErrors.confirmPassword = "Passwords do not match";
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    if (!validateForm()) {
      return;
    }

    registerMutation.mutate({ email, password });
  };

  return (
    <div>
      <h2 className="mb-6 text-xl font-semibold text-zinc-900 dark:text-zinc-50">
        Create your account
      </h2>

      {errors.form && (
        <Alert variant="error" className="mb-4">
          {errors.form}
        </Alert>
      )}

      {/* OAuth Sign-up Options */}
      <div className="space-y-3">
        <GoogleSignInButton
          label="Continue with Google"
          onError={(error) => setErrors({ form: error })}
        />
      </div>

      {/* Divider */}
      <div className="relative my-6">
        <div className="absolute inset-0 flex items-center">
          <div className="w-full border-t border-zinc-300 dark:border-zinc-700" />
        </div>
        <div className="relative flex justify-center text-sm">
          <span className="bg-white px-2 text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
            Or continue with email
          </span>
        </div>
      </div>

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
          disabled={registerMutation.isPending}
        />

        <Input
          id="password"
          type="password"
          label="Password"
          placeholder="At least 8 characters"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={errors.password}
          autoComplete="new-password"
          disabled={registerMutation.isPending}
        />

        <Input
          id="confirm-password"
          type="password"
          label="Confirm password"
          placeholder="Confirm your password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          error={errors.confirmPassword}
          autoComplete="new-password"
          disabled={registerMutation.isPending}
        />

        <Button type="submit" className="w-full" loading={registerMutation.isPending}>
          Create account
        </Button>
      </form>

      <p className="mt-6 text-center text-sm text-zinc-600 dark:text-zinc-400">
        Already have an account?{" "}
        <Link href="/login" className="font-medium text-zinc-900 hover:underline dark:text-zinc-50">
          Sign in
        </Link>
      </p>
    </div>
  );
}
