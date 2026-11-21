import type { Metadata } from "next";
import Link from "next/link";
import { AuthFrame } from "@/components/auth/auth-frame";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ROLE_LABELS, isMembershipRole } from "@/domain/permissions";
import { requireSessionUser } from "@/server/auth/session";
import { signOut } from "@/server/auth/actions";
import { createUserClient } from "@/server/supabase/server";

export const metadata: Metadata = {
  title: "Your workspaces",
  robots: { index: false, follow: false },
};

export default async function AppHomePage() {
  const user = await requireSessionUser("/app");
  const supabase = await createUserClient();
  const { data, error } = await supabase
    .from("memberships")
    .select("id, role, weddings!inner(id, name)")
    .eq("user_id", user.id)
    .eq("status", "active")
    .order("created_at");
  if (error) throw new Error("Could not load workspaces");

  const rows = data.flatMap((m) => {
    const w = Array.isArray(m.weddings) ? m.weddings[0] : m.weddings;
    return w && isMembershipRole(m.role) ? [{ id: m.id, role: m.role, wedding: w }] : [];
  });

  return (
    <AuthFrame
      title="Your workspaces"
      intro={user.email ? `Signed in as ${user.email}.` : undefined}
    >
      {rows.length === 0 ? (
        <Card>
          <p className="text-body-md">
            You aren&apos;t part of a wedding workspace yet. If someone invited you, open the link
            they sent while signed in with the invited email, or start your own.
          </p>
        </Card>
      ) : (
        <ul className="space-y-3">
          {rows.map((r) => (
            <li key={r.id}>
              <Card className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <p className="truncate font-serif text-headline-sm">{r.wedding.name}</p>
                  <p className="text-body-sm text-ink-muted">{ROLE_LABELS[r.role]}</p>
                </div>
                <Link
                  href={`/app/${r.wedding.id}`}
                  className="font-semibold text-action-emphasis underline underline-offset-4"
                >
                  Open
                </Link>
              </Card>
            </li>
          ))}
        </ul>
      )}
      <ButtonLink href="/app/onboarding" variant="primary">
        Start a new wedding workspace
      </ButtonLink>
      <form action={signOut}>
        <Button type="submit" variant="outline" size="sm">
          Sign out
        </Button>
      </form>
    </AuthFrame>
  );
}
