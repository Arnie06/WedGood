import { notFound, redirect } from "next/navigation";
import { hasCapability, requireWorkspace } from "@/server/auth/workspace-guard";

/** Adding a venue or vendor now happens in a tray on the list; old links open it there. */
export default async function NewCandidateRedirect({
  params,
  searchParams,
}: {
  params: Promise<{ w: string }>;
  searchParams: Promise<{ kind?: string }>;
}) {
  const access = await requireWorkspace((await params).w);
  if (!hasCapability(access, "vendors.manage")) notFound();
  const { kind } = await searchParams;
  const param = kind === "vendor" ? "addVendor" : "addVenue";
  redirect(`/app/${access.wedding.id}/discover?${param}=1`);
}
