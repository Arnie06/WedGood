"use server";

import { z } from "zod";
import { extractPageDetails, type PageDetails } from "@/domain/links/extract";
import { parseLookupUrl } from "@/domain/links/url";
import { ForbiddenError, requireCapability } from "@/server/auth/workspace-guard";
import { fetchPublicPage } from "./fetch-page";
import { lookupLimiter } from "./rate-limit";

export type LookupResult =
  { status: "ok"; details: PageDetails; finalUrl: string } | { status: "error"; message: string };

const input = z.object({ workspaceId: z.uuid(), url: z.string().max(4000) });

const COULD_NOT_READ =
  "We couldn't read details from that page. You can still save the link and fill in the details yourself.";

/**
 * Member-initiated lookup for one pasted link (ADR-029). Returns text to prefill the
 * form; saves nothing. Requires the same capability as adding a venue or vendor. All
 * network failures share one message so this cannot be used to probe the network.
 */
export async function lookupLink(workspaceId: string, url: string): Promise<LookupResult> {
  const parsed = input.safeParse({ workspaceId, url });
  if (!parsed.success) return { status: "error", message: "Reload the page and try again." };

  let access;
  try {
    access = await requireCapability(parsed.data.workspaceId, "vendors.manage");
  } catch (e) {
    if (e instanceof ForbiddenError) {
      return { status: "error", message: "You don't have permission to add to this list." };
    }
    throw e;
  }

  const target = parseLookupUrl(parsed.data.url);
  if (!target.ok) {
    return {
      status: "error",
      message:
        target.reason === "empty" || target.reason === "invalid" || target.reason === "long"
          ? "Paste a full web address, like https://example.com/venue."
          : "That address can't be read. Use the public web page for the venue or vendor.",
    };
  }

  if (!lookupLimiter.take(access.user.id)) {
    return {
      status: "error",
      message: "That's a lot of lookups. Please wait a minute and try again.",
    };
  }

  const page = await fetchPublicPage(target.url);
  if (!page.ok) {
    return {
      status: "error",
      message:
        page.reason === "blocked_site"
          ? "We can't read details from that site. Please enter them by hand."
          : page.reason === "invalid_url"
            ? "That address can't be read. Use the public web page for the venue or vendor."
            : COULD_NOT_READ,
    };
  }
  return {
    status: "ok",
    details: extractPageDetails(page.html, page.finalUrl),
    finalUrl: page.finalUrl.href,
  };
}
