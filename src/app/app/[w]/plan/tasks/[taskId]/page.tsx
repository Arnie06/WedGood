import { redirect } from "next/navigation";

/** Editing a task now happens in a tray on the checklist; old links land there. */
export default async function TaskRedirectPage({ params }: { params: Promise<{ w: string }> }) {
  const { w } = await params;
  redirect(`/app/${encodeURIComponent(w)}/plan`);
}
