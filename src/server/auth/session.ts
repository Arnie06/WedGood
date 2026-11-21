import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { readSupabaseConfig } from "@/server/supabase/config";
import { createUserClient } from "@/server/supabase/server";

export type SessionUser = { id: string; email: string | null };

/** Verified against the Auth server (not just the cookie). Null when signed out. */
export const getSessionUser = cache(async (): Promise<SessionUser | null> => {
  // Unconfigured auth means nobody can be signed in; callers show an honest state.
  if (readSupabaseConfig() === null) {
    await cookies();
    return null;
  }
  const supabase = await createUserClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  return { id: data.user.id, email: data.user.email ?? null };
});

export async function requireSessionUser(returnTo: string): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) redirect(`/sign-in?next=${encodeURIComponent(returnTo)}`);
  return user;
}
