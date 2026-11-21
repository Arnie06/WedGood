import type { Metadata } from "next";
import Link from "next/link";
import { AuthFrame } from "@/components/auth/auth-frame";
import { buttonClasses } from "@/components/ui/button";
import { RedeemForm } from "@/features/members/redeem-form";
import { getSessionUser } from "@/server/auth/session";
import { isWellFormedInviteToken } from "@/server/members/invite-token";

// The token is a bearer secret in the URL: keep it out of indexes and referrers.
export const metadata: Metadata = {
  title: "Join a wedding workspace",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  if (!isWellFormedInviteToken(token)) {
    return (
      <AuthFrame
        title="This invitation link isn't valid"
        intro="Ask the person who invited you to send a fresh link."
      >
        <Link href="/" className={buttonClasses({ variant: "outline" })}>
          Go to the home page
        </Link>
      </AuthFrame>
    );
  }

  const user = await getSessionUser();
  const returnTo = encodeURIComponent(`/invite/${token}`);

  if (!user) {
    return (
      <AuthFrame
        title="You've been invited"
        intro="Sign in or create an account using the email address the invitation was sent to. We'll bring you back here to join."
      >
        <div className="flex flex-col gap-3">
          <Link
            href={`/sign-in?next=${returnTo}`}
            className={buttonClasses({ variant: "emphasis" })}
          >
            Sign in
          </Link>
          <Link
            href={`/sign-up?next=${returnTo}`}
            className={buttonClasses({ variant: "outline" })}
          >
            Create an account
          </Link>
        </div>
      </AuthFrame>
    );
  }

  return (
    <AuthFrame
      title="Join this wedding workspace"
      intro={`You're signed in as ${user.email ?? "your account"}. Joining works only if the invitation was sent to this email.`}
    >
      <RedeemForm token={token} />
    </AuthFrame>
  );
}
