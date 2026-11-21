import type { Metadata } from "next";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import {
  ROLE_LABELS,
  assignableRoles,
  canAdministerMember,
  isMembershipRole,
  parseGrants,
} from "@/domain/permissions";
import {
  GrantForm,
  InviteForm,
  RemoveForm,
  RevokeInviteButton,
  RoleForm,
} from "@/features/members/member-controls";
import { hasCapability, requireWorkspace } from "@/server/auth/workspace-guard";
import { listPendingInvites } from "@/server/members/queries";
import { createUserClient } from "@/server/supabase/server";

export const metadata: Metadata = { title: "People and access" };

export default async function MembersPage({ params }: { params: Promise<{ w: string }> }) {
  const access = await requireWorkspace((await params).w);
  const workspaceId = access.wedding.id;
  const { role: actorRole, grants: actorGrants } = access.membership;
  const canManage = hasCapability(access, "members.manage");
  const isOwner = hasCapability(access, "workspace.manage");

  const supabase = await createUserClient();
  const [membersRes, pending] = await Promise.all([
    supabase.rpc("list_members", { p_wedding: workspaceId }),
    canManage ? listPendingInvites(workspaceId) : Promise.resolve([]),
  ]);
  if (membersRes.error) throw new Error("Could not load members");

  const members = membersRes.data.flatMap((m) =>
    isMembershipRole(m.role) ? [{ ...m, role: m.role }] : [],
  );
  const roles = assignableRoles(actorRole, actorGrants);
  const label = (m: { display_name: string | null; email: string | null }) =>
    m.display_name ?? m.email ?? "this person";

  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <h1 className="font-serif text-headline-mobile md:text-headline-lg">People and access</h1>
        <p className="text-body-lg text-ink-muted">
          Everyone here can open this workspace. What they can do depends on their role.
        </p>
      </div>

      <section aria-labelledby="members-heading" className="space-y-3">
        <h2 id="members-heading" className="font-serif text-headline-sm">
          Members ({members.length})
        </h2>
        <ul className="space-y-3">
          {members.map((m) => {
            const self = m.user_id === access.user.id;
            const grants = parseGrants(m.permissions);
            const administrable =
              canManage && !self && canAdministerMember(actorRole, actorGrants, m.role);
            const name = label(m);
            return (
              <li key={m.membership_id}>
                <Card className="space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-body-lg font-semibold">
                        {name}
                        {self && <span className="font-normal text-ink-muted"> (you)</span>}
                      </p>
                      {m.email && m.email !== name && (
                        <p className="truncate text-body-sm text-ink-muted">{m.email}</p>
                      )}
                    </div>
                    <Badge tone={m.role === "owner" ? "ceremony" : "neutral"}>
                      {ROLE_LABELS[m.role]}
                    </Badge>
                  </div>
                  {administrable && (
                    <RoleForm
                      workspaceId={workspaceId}
                      membershipId={m.membership_id}
                      version={m.version}
                      current={m.role}
                      roles={roles}
                      memberLabel={name}
                    />
                  )}
                  {isOwner && m.role === "partner" && (
                    <GrantForm
                      workspaceId={workspaceId}
                      membershipId={m.membership_id}
                      version={m.version}
                      enabled={grants.manage_members === true}
                      memberLabel={name}
                    />
                  )}
                  {(administrable || self) && (
                    <RemoveForm
                      workspaceId={workspaceId}
                      membershipId={m.membership_id}
                      version={m.version}
                      self={self}
                      memberLabel={name}
                    />
                  )}
                </Card>
              </li>
            );
          })}
        </ul>
      </section>

      {canManage ? (
        <>
          <section aria-labelledby="invite-heading" className="space-y-3">
            <h2 id="invite-heading" className="font-serif text-headline-sm">
              Invite someone
            </h2>
            <Card>
              <InviteForm workspaceId={workspaceId} roles={roles} />
            </Card>
          </section>

          <section aria-labelledby="pending-heading" className="space-y-3">
            <h2 id="pending-heading" className="font-serif text-headline-sm">
              Waiting invitations ({pending.length})
            </h2>
            {pending.length === 0 ? (
              <p className="text-body-md text-ink-muted">No invitations are waiting.</p>
            ) : (
              <ul className="space-y-3">
                {pending.map((i) => (
                  <li key={i.id}>
                    <Card className="flex flex-wrap items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-body-md font-semibold">{i.email}</p>
                        <p className="text-body-sm text-ink-muted">
                          {ROLE_LABELS[i.role]} · expires {i.expiresAt.slice(0, 10)}
                        </p>
                      </div>
                      <RevokeInviteButton workspaceId={workspaceId} inviteId={i.id} />
                    </Card>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      ) : (
        <p className="text-body-md text-ink-muted">
          Only owners, and partners an owner has allowed, can invite people or change roles.
        </p>
      )}
    </div>
  );
}
