import type { Metadata } from "next";
import Link from "next/link";
import { AuthForm } from "@/components/auth/auth-form";
import { AuthFrame, UnconfiguredNotice } from "@/components/auth/auth-frame";
import { signUp } from "@/server/auth/actions";
import { safeNextPath } from "@/server/auth/redirects";
import { readSupabaseConfig } from "@/server/supabase/config";

export const metadata: Metadata = {
  title: "Create your account",
  robots: { index: false, follow: false },
};

export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const next = safeNextPath((await searchParams).next);
  const configured = readSupabaseConfig() !== null;
  return (
    <AuthFrame
      title="Create your account"
      intro="One account keeps your plans private to you and the people you invite."
    >
      {configured ? (
        <AuthForm
          action={signUp}
          next={next}
          submitLabel="Create account"
          passwordAutoComplete="new-password"
          passwordHint="At least 12 characters."
        />
      ) : (
        <UnconfiguredNotice />
      )}
      <p className="text-body-md text-ink-muted">
        Already have an account?{" "}
        <Link
          className="font-semibold text-action-emphasis underline underline-offset-4"
          href={`/sign-in?next=${encodeURIComponent(next)}`}
        >
          Sign in
        </Link>
      </p>
    </AuthFrame>
  );
}
