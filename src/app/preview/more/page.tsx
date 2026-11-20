import type { Metadata } from "next";
import { getNavGroup } from "@/components/shell/nav-groups";
import { SectionOverview } from "@/components/shell/section-overview";

const group = getNavGroup("more");

export const metadata: Metadata = { title: group.label };

export default function PreviewMorePage() {
  return <SectionOverview group={group} />;
}
