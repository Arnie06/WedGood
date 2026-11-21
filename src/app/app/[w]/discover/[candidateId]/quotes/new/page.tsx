import { notFound, redirect } from "next/navigation";
import { hasCapability, requireWorkspace } from "@/server/auth/workspace-guard";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Adding a quote now happens in a tray on the venue or vendor page; old links open it there. */
export default async function NewQuoteRedirect({
  params,
}: {
  params: Promise<{ w: string; candidateId: string }>;
}) {
  const { w, candidateId } = await params;
  const access = await requireWorkspace(w);
  if (!UUID.test(candidateId) || !hasCapability(access, "vendors.manage")) notFound();
  redirect(`/app/${access.wedding.id}/discover/${candidateId}?addQuote=1`);
}
