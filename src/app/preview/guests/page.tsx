import type { Metadata } from "next";
import { getNavGroup } from "@/components/shell/nav-groups";
import { SectionOverview } from "@/components/shell/section-overview";

const group = getNavGroup("guests");

export const metadata: Metadata = { title: group.label };

export default function PreviewGuestsPage() {
  return <SectionOverview group={group} />;
}
