/**
 * Validates a link a member wants the app to read (ADR-029). Pure: no DNS here. The
 * server fetcher re-checks every resolved address and every redirect.
 */
export type LookupUrlResult =
  | { ok: true; url: URL }
  | {
      ok: false;
      reason: "empty" | "invalid" | "scheme" | "credentials" | "port" | "host" | "long";
    };

export const MAX_LOOKUP_URL_LENGTH = 2048;

const BLOCKED_SUFFIXES = [
  ".local",
  ".localhost",
  ".internal",
  ".lan",
  ".home",
  ".corp",
  ".intranet",
];

export function isBlockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (host === "" || host === "localhost") return true;
  // IP literals (v4 normalised by the URL parser, v6 in brackets) are never fetched by name.
  if (host.startsWith("[") || /^\d+(\.\d+){0,3}$/.test(host) || /^0x[0-9a-f]+$/i.test(host)) {
    return true;
  }
  if (!host.includes(".")) return true;
  return BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

export function parseLookupUrl(input: string): LookupUrlResult {
  const trimmed = input.trim();
  if (trimmed === "") return { ok: false, reason: "empty" };
  if (trimmed.length > MAX_LOOKUP_URL_LENGTH) return { ok: false, reason: "long" };
  // A bare "gardenhouse.com/venue" is what people paste; assume https.
  const withScheme =
    /^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !/^[^/]*:\d+(\/|$)/.test(trimmed)
      ? trimmed
      : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, reason: "scheme" };
  if (url.username !== "" || url.password !== "") return { ok: false, reason: "credentials" };
  const port = url.port === "" ? (url.protocol === "https:" ? "443" : "80") : url.port;
  if (port !== "80" && port !== "443") return { ok: false, reason: "port" };
  if (isBlockedHostname(url.hostname)) return { ok: false, reason: "host" };
  url.hash = "";
  return { ok: true, url };
}
