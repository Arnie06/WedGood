"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/text-field";
import type { AuthState } from "@/server/auth/actions";

export function AuthForm({
  action,
  next,
  submitLabel,
  passwordAutoComplete,
  passwordHint,
}: {
  action: (state: AuthState, form: FormData) => Promise<AuthState>;
  next: string;
  submitLabel: string;
  passwordAutoComplete: "current-password" | "new-password";
  passwordHint?: string;
}) {
  const [state, formAction, pending] = useActionState(action, { status: "idle" } as AuthState);
  return (
    <form action={formAction} className="space-y-5" noValidate={false}>
      <input type="hidden" name="next" value={next} />
      <TextField label="Email" name="email" type="email" autoComplete="email" required />
      <TextField
        label="Password"
        name="password"
        type="password"
        autoComplete={passwordAutoComplete}
        minLength={12}
        required
        {...(passwordHint ? { hint: passwordHint } : {})}
      />
      <div aria-live="polite" className="min-h-6">
        {state.status !== "idle" && (
          <p
            role={state.status === "error" ? "alert" : "status"}
            className={
              state.status === "error" ? "text-body-sm text-danger" : "text-body-sm text-ink"
            }
          >
            {state.message}
          </p>
        )}
      </div>
      <Button type="submit" disabled={pending} className="w-full">
        {pending ? "One moment…" : submitLabel}
      </Button>
    </form>
  );
}
