import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { Database } from "@/server/db/database.types";
import { requireSupabaseConfig } from "./config";

/**
 * Request-scoped Supabase client acting as the signed-in user (RLS applies).
 * Never use a service-role key for request handling.
 */
export async function createUserClient() {
  // Reading cookies first keeps every page that touches auth dynamic, so builds
  // never prerender a signed-out snapshot (and succeed without Supabase configured).
  const store = await cookies();
  const { url, publishableKey } = requireSupabaseConfig();
  return createServerClient<Database>(url, publishableKey, {
    cookies: {
      getAll: () => store.getAll(),
      setAll(list) {
        try {
          for (const { name, value, options } of list) store.set(name, value, options);
        } catch {
          // Server Components cannot set cookies; proxy.ts refreshes the session instead.
        }
      },
    },
  });
}
