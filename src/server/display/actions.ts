"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { DENSITIES } from "@/domain/display/density";
import { requireWorkspace } from "@/server/auth/workspace-guard";
import { densityCookie } from "./density";

const input = z.object({ workspaceId: z.uuid(), density: z.enum(DENSITIES) });

/** Saves the list spacing for this browser and workspace. Any member may choose their own. */
export async function setDensity(form: FormData): Promise<void> {
  const parsed = input.safeParse({
    workspaceId: form.get("workspaceId"),
    density: form.get("density"),
  });
  if (!parsed.success) return;
  const { workspaceId, density } = parsed.data;
  await requireWorkspace(workspaceId);
  const { name, path } = densityCookie(workspaceId);
  const store = await cookies();
  store.set(name, density, {
    path,
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24 * 365,
  });
  revalidatePath(path, "layout");
}
