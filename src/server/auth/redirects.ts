/**
 * Accepts only same-origin relative paths for post-sign-in redirects, so a
 * crafted `next` can never bounce a user to another site.
 */
export function safeNextPath(value: string | null | undefined, fallback = "/app"): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) {
    return fallback;
  }
  if (/[\u0000-\u001f]/.test(value)) return fallback;
  return value;
}
