import "server-only";
import { isRights, type ItemKind, type Rights } from "@/domain/design/board";
import { createUserClient } from "@/server/supabase/server";

export type BoardSummary = {
  id: string;
  title: string;
  description: string | null;
  palette: string[];
  itemCount: number;
  imageIds: string[];
  version: number;
};
export type BoardItem = {
  id: string;
  kind: ItemKind;
  title: string;
  note: string | null;
  url: string | null;
  candidateId: string | null;
  favorite: boolean;
  position: number;
  rights: Rights | null;
  version: number;
};
export type BoardDetail = BoardSummary & { items: BoardItem[] };
export type VendorOption = { id: string; name: string; category: string };

const kind = (v: string): ItemKind => (v === "image" || v === "link" ? v : "note");

/** RLS limits rows to members; archived boards are not listed. Pages also call requireWorkspace. */
export async function loadBoards(workspaceId: string): Promise<BoardSummary[]> {
  const supabase = await createUserClient();
  const [boards, items] = await Promise.all([
    supabase
      .from("design_boards")
      .select("id, title, description, palette, version")
      .eq("wedding_id", workspaceId)
      .is("archived_at", null)
      .order("created_at")
      .limit(100),
    supabase
      .from("design_items")
      .select("id, board_id, kind, position")
      .eq("wedding_id", workspaceId)
      .order("position")
      .limit(5000),
  ]);
  if (boards.error || items.error) throw new Error("Could not load design boards");
  return boards.data.map((b) => {
    const mine = items.data.filter((i) => i.board_id === b.id);
    return {
      id: b.id,
      title: b.title,
      description: b.description,
      palette: b.palette,
      version: b.version,
      itemCount: mine.length,
      imageIds: mine
        .filter((i) => i.kind === "image")
        .slice(0, 4)
        .map((i) => i.id),
    };
  });
}

export async function loadBoard(workspaceId: string, boardId: string): Promise<BoardDetail | null> {
  const supabase = await createUserClient();
  const [board, items] = await Promise.all([
    supabase
      .from("design_boards")
      .select("id, title, description, palette, version")
      .eq("wedding_id", workspaceId)
      .eq("id", boardId)
      .is("archived_at", null)
      .maybeSingle(),
    supabase
      .from("design_items")
      .select(
        "id, kind, title, note, url, candidate_id, favorite, position, rights, version, created_at",
      )
      .eq("wedding_id", workspaceId)
      .eq("board_id", boardId)
      .order("position")
      .order("created_at")
      .limit(500),
  ]);
  if (board.error || items.error) throw new Error("Could not load the board");
  if (!board.data) return null;
  const mapped = items.data.map((i) => ({
    id: i.id,
    kind: kind(i.kind),
    title: i.title,
    note: i.note,
    url: i.url,
    candidateId: i.candidate_id,
    favorite: i.favorite,
    position: i.position,
    rights: isRights(i.rights) ? i.rights : null,
    version: i.version,
  }));
  return {
    id: board.data.id,
    title: board.data.title,
    description: board.data.description,
    palette: board.data.palette,
    version: board.data.version,
    itemCount: mapped.length,
    imageIds: mapped.filter((i) => i.kind === "image").map((i) => i.id),
    items: mapped,
  };
}

/** Saved venue and vendor candidates (readable by every member). */
export async function loadVendorOptions(workspaceId: string): Promise<VendorOption[]> {
  const supabase = await createUserClient();
  const { data, error } = await supabase
    .from("candidates")
    .select("id, name, category")
    .eq("wedding_id", workspaceId)
    .is("archived_at", null)
    .order("name")
    .limit(500);
  if (error) throw new Error("Could not load vendors");
  return data;
}
