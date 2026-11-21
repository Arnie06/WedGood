"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { createUserClient } from "@/server/supabase/server";
import { safeNextPath } from "./redirects";

export type AuthState = { status: "idle" } | { status: "error" | "notice"; message: string };

const credentials = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
  password: z.string().min(12, "Use at least 12 characters.").max(200),
});

export async function signIn(_: AuthState, form: FormData): Promise<AuthState> {
  const parsed = credentials.safeParse({
    email: form.get("email"),
    password: form.get("password"),
  });
  const next = safeNextPath(String(form.get("next") ?? ""));
  if (!parsed.success) {
    return {
      status: "error",
      message: "Enter your email and a password of at least 12 characters.",
    };
  }
  const supabase = await createUserClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  // One message for unknown email and wrong password: no account enumeration.
  if (error) return { status: "error", message: "That email and password don't match." };
  redirect(next);
}

export async function signUp(_: AuthState, form: FormData): Promise<AuthState> {
  const parsed = credentials.safeParse({
    email: form.get("email"),
    password: form.get("password"),
  });
  const next = safeNextPath(String(form.get("next") ?? ""));
  if (!parsed.success) {
    const first = parsed.error.issues[0]?.message ?? "Check your email and password.";
    return { status: "error", message: first };
  }
  const supabase = await createUserClient();
  const { data, error } = await supabase.auth.signUp(parsed.data);
  if (error) {
    return { status: "error", message: "We couldn't create that account. Try signing in instead." };
  }
  if (!data.session) {
    return {
      status: "notice",
      message: "Check your email to confirm your address, then sign in.",
    };
  }
  redirect(next);
}

export async function signOut(): Promise<void> {
  const supabase = await createUserClient();
  await supabase.auth.signOut();
  redirect("/sign-in");
}
