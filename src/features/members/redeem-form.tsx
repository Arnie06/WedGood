"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { redeemInvite, type ActionState } from "@/server/members/actions";

export function RedeemForm({ token }: { token: string }) {
  const [state, action, pending] = useActionState(redeemInvite, { status: "idle" } as ActionState);
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="token" value={token} />
      <div aria-live="polite">
        {state.status === "error" && (
          <p role="alert" className="text-body-md text-danger">
            {state.message}
          </p>
        )}
      </div>
      <Button type="submit" variant="emphasis" disabled={pending} className="w-full">
        {pending ? "Joining…" : "Join this wedding"}
      </Button>
    </form>
  );
}
