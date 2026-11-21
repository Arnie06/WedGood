import type { Metadata } from "next";
import Link from "next/link";
import { AuthForm } from "@/components/auth/auth-form";
import { AuthFrame, UnconfiguredNotice } from "@/components/auth/auth-frame";
import { signIn } from "@/server/auth/actions";
import { safeNextPath } from "@/server/auth/redirects";
import { readSupabaseConfig } from "@/server/supabase/config";

export const metadata: Metadata = { title: "Sign in", robots: { index: false, follow: false } };

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const next = safeNextPath((await searchParams).next);
  const configured = readSupabaseConfig() !== null;
  return (
    <AuthFrame title="Welcome back" intro="Sign in to your wedding workspace.">
      {configured ? (
        <AuthForm
          action={signIn}
          next={next}
          submitLabel="Sign in"
          passwordAutoComplete="current-password"
        />
      ) : (
        <UnconfiguredNotice />
      )}
      <p className="text-body-md text-ink-muted">
        New here?{" "}
        <Link
          className="font-semibold text-action-emphasis underline underline-offset-4"
          href={`/sign-up?next=${encodeURIComponent(next)}`}
        >
          Create an account
        </Link>
      </p>
    </AuthFrame>
  );
}
