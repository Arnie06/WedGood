import "server-only";
import type { DateKind } from "@/domain/tasks/schedule";
import { createUserClient } from "@/server/supabase/server";

export type TaskRecord = {
  id: string;
  title: string;
  notes: string | null;
  status: "open" | "done";
  dueDate: string | null;
  dateKind: DateKind;
  offsetDays: number | null;
  templateKey: string | null;
  phase: string | null;
  sortOrder: number;
  assigneeUserId: string | null;
  version: number;
};

/** Non-archived tasks. RLS limits this to members; callers also use requireWorkspace. */
export async function loadTasks(workspaceId: string): Promise<TaskRecord[]> {
  const supabase = await createUserClient();
  const { data, error } = await supabase
    .from("tasks")
    .select(
      "id, title, notes, status, due_date, date_kind, offset_days, template_key, phase, sort_order, assignee_user_id, version",
    )
    .eq("wedding_id", workspaceId)
    .is("archived_at", null)
    .order("sort_order")
    .order("created_at")
    .limit(500);
  if (error) throw new Error("Could not load tasks");
  return data.map((t) => ({
    id: t.id,
    title: t.title,
    notes: t.notes,
    status: t.status === "done" ? "done" : "open",
    dueDate: t.due_date,
    dateKind: t.date_kind === "relative" ? "relative" : "fixed",
    offsetDays: t.offset_days,
    templateKey: t.template_key,
    phase: t.phase,
    sortOrder: t.sort_order,
    assigneeUserId: t.assignee_user_id,
    version: t.version,
  }));
}

export async function loadTask(workspaceId: string, taskId: string): Promise<TaskRecord | null> {
  return (await loadTasks(workspaceId)).find((t) => t.id === taskId) ?? null;
}

export type AssigneeOption = { userId: string; label: string };

/** Active members who can be assigned a task. Names come from profiles, never emails. */
export async function loadAssigneeOptions(workspaceId: string): Promise<AssigneeOption[]> {
  const supabase = await createUserClient();
  const { data, error } = await supabase.rpc("list_members", { p_wedding: workspaceId });
  if (error) throw new Error("Could not load members");
  return data.map((m, i) => ({
    userId: m.user_id,
    label: m.display_name?.trim() || `Member ${i + 1}`,
  }));
}
