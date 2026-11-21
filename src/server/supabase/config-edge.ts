export type EdgeSupabaseConfig = { url: string; publishableKey: string };

/** Edge/proxy-safe reader (no `server-only`); validation lives in config.ts. */
export function readSupabaseConfig(
  env: Record<string, string | undefined> = process.env,
): EdgeSupabaseConfig | null {
  const url = env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const publishableKey = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();
  return url && publishableKey ? { url, publishableKey } : null;
}
