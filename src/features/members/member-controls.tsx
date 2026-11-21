"use client";

import { Check, Copy } from "lucide-react";
import { useActionState, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/text-field";
import { ROLE_LABELS, type MembershipRole } from "@/domain/permissions";
import {
  changeMemberRole,
  inviteCollaborator,
  removeMember,
  revokeInvite,
  setPartnerGrant,
  type ActionState,
} from "@/server/members/actions";

const idle: ActionState = { status: "idle" };

function Message({ state }: { state: ActionState }) {
  return (
    <div aria-live="polite">
      {state.status === "error" && (
        <p role="alert" className="text-body-sm text-danger">
          {state.message}
        </p>
      )}
      {state.status === "ok" && (
        <p role="status" className="text-body-sm text-ink">
          {state.message}
        </p>
      )}
    </div>
  );
}

const selectClass =
  "block min-h-12 w-full rounded-control border border-border-control bg-surface-sunken px-3 py-2 text-body-md text-ink focus-visible:border-focus";

export function InviteForm({
  workspaceId,
  roles,
}: {
  workspaceId: string;
  roles: readonly MembershipRole[];
}) {
  const [state, action, pending] = useActionState(inviteCollaborator, idle);
  const [copied, setCopied] = useState(false);
  const invitable = roles.filter((r) => r !== "owner");
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <TextField
        label="Their email address"
        name="email"
        type="email"
        autoComplete="off"
        hint="They must sign in with this exact email to accept."
        required
      />
      <div className="space-y-1.5">
        <label htmlFor="invite-role" className="block text-label-lg font-semibold text-ink">
          Role
        </label>
        <select
          id="invite-role"
          name="role"
          className={selectClass}
          defaultValue={invitable.includes("partner") ? "partner" : "viewer"}
        >
          {invitable.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABELS[r]}
            </option>
          ))}
        </select>
      </div>
      <Message state={state} />
      {state.status === "ok" && state.inviteUrl && (
        <div className="space-y-2 rounded-control border border-border-hairline bg-surface-muted p-3">
          <p className="text-body-sm text-ink">
            No email has been sent. Share this link yourself, privately:
          </p>
          <input
            readOnly
            aria-label="Invitation link"
            value={state.inviteUrl}
            onFocus={(e) => e.currentTarget.select()}
            className="block min-h-11 w-full rounded-control border border-border-control bg-surface px-3 text-body-sm text-ink"
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(state.inviteUrl ?? "");
                setCopied(true);
              } catch {
                setCopied(false);
              }
            }}
          >
            {copied ? (
              <Check aria-hidden className="size-4" />
            ) : (
              <Copy aria-hidden className="size-4" />
            )}
            {copied ? "Copied" : "Copy link"}
          </Button>
        </div>
      )}
      <Button type="submit" disabled={pending}>
        {pending ? "Creating…" : "Create invitation"}
      </Button>
    </form>
  );
}

function Hidden({ values }: { values: Record<string, string> }) {
  return Object.entries(values).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />);
}

function InlineForm({
  action,
  children,
  hidden,
}: {
  action: (s: ActionState, f: FormData) => Promise<ActionState>;
  children: (pending: boolean) => ReactNode;
  hidden: Record<string, string>;
}) {
  const [state, formAction, pending] = useActionState(action, idle);
  return (
    <form action={formAction} className="space-y-1">
      <Hidden values={hidden} />
      {children(pending)}
      <Message state={state} />
    </form>
  );
}

export function RevokeInviteButton({
  workspaceId,
  inviteId,
}: {
  workspaceId: string;
  inviteId: string;
}) {
  return (
    <InlineForm action={revokeInvite} hidden={{ workspaceId, inviteId }}>
      {(pending) => (
        <Button type="submit" variant="outline" size="sm" disabled={pending}>
          Revoke
        </Button>
      )}
    </InlineForm>
  );
}

export function RoleForm({
  workspaceId,
  membershipId,
  version,
  current,
  roles,
  memberLabel,
}: {
  workspaceId: string;
  membershipId: string;
  version: number;
  current: MembershipRole;
  roles: readonly MembershipRole[];
  memberLabel: string;
}) {
  return (
    <InlineForm
      action={changeMemberRole}
      hidden={{ workspaceId, membershipId, version: String(version) }}
    >
      {(pending) => (
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <label htmlFor={`role-${membershipId}`} className="sr-only">
              Role for {memberLabel}
            </label>
            <select
              id={`role-${membershipId}`}
              name="role"
              defaultValue={current}
              className={selectClass}
            >
              {roles.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r]}
                </option>
              ))}
            </select>
          </div>
          <Button type="submit" variant="secondary" size="sm" disabled={pending}>
            Save
          </Button>
        </div>
      )}
    </InlineForm>
  );
}

export function GrantForm({
  workspaceId,
  membershipId,
  version,
  enabled,
  memberLabel,
}: {
  workspaceId: string;
  membershipId: string;
  version: number;
  enabled: boolean;
  memberLabel: string;
}) {
  return (
    <InlineForm
      action={setPartnerGrant}
      hidden={{
        workspaceId,
        membershipId,
        version: String(version),
        manageMembers: String(!enabled),
      }}
    >
      {(pending) => (
        <Button type="submit" variant="outline" size="sm" disabled={pending}>
          {enabled
            ? `Stop letting ${memberLabel} manage people`
            : `Let ${memberLabel} invite editors and viewers`}
        </Button>
      )}
    </InlineForm>
  );
}

export function RemoveForm({
  workspaceId,
  membershipId,
  version,
  self,
  memberLabel,
}: {
  workspaceId: string;
  membershipId: string;
  version: number;
  self: boolean;
  memberLabel: string;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <InlineForm
      action={removeMember}
      hidden={{ workspaceId, membershipId, version: String(version), self: String(self) }}
    >
      {(pending) =>
        confirming ? (
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-body-sm text-ink">
              {self
                ? "Leave this wedding?"
                : `Remove ${memberLabel}? Their access ends immediately.`}
            </p>
            <Button type="submit" variant="emphasis" size="sm" disabled={pending}>
              {self ? "Yes, leave" : "Yes, remove"}
            </Button>
            <Button type="button" variant="quiet" size="sm" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        ) : (
          <Button type="button" variant="outline" size="sm" onClick={() => setConfirming(true)}>
            {self ? "Leave" : "Remove"}
          </Button>
        )
      }
    </InlineForm>
  );
}
