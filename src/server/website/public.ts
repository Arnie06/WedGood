import "server-only";
import { z } from "zod";
import { TEMPLATES, validateSlug, type PublicSite } from "@/domain/website/site";
import { createAdminClient } from "@/server/supabase/admin";
import { clientKey, tokenDigest } from "@/server/rsvp/public";

const text = z.string().max(5000);
const publicSiteSchema = z.object({
  template: z.enum(TEMPLATES),
  title: text,
  tagline: text.optional(),
  date: text.optional(),
  location: text.optional(),
  story: text.optional(),
  travel: text.optional(),
  faq: z.array(z.object({ q: text, a: text })),
  registry: z.array(z.object({ label: text, url: z.string().regex(/^https:\/\//) })),
  events: z.array(
    z.object({
      name: text,
      kind: text,
      localDate: text.optional(),
      visibility: z.enum(["public", "invited"]),
      when: text.optional(),
      where: text.optional(),
      notes: text.optional(),
    }),
  ),
  hotels: z
    .array(
      z.object({
        name: text,
        address: text.optional(),
        phone: text.optional(),
        websiteUrl: z
          .string()
          .regex(/^https:\/\//)
          .optional(),
        note: text.optional(),
        blocks: z.array(
          z.object({
            label: text.optional(),
            checkIn: text,
            checkOut: text,
            bookBy: text.optional(),
            bookingUrl: z
              .string()
              .regex(/^https:\/\//)
              .optional(),
            bookingCode: text.optional(),
            nightlyRateMinor: z.number().int().positive().optional(),
            currency: z
              .string()
              .regex(/^[A-Z]{3}$/)
              .optional(),
          }),
        ),
      }),
    )
    .optional(),
  invitation: z.object({ label: text }).optional(),
});

/** Parses and re-projects so only allowlisted keys ever reach a page, whatever the RPC returned. */
export function toPublicSite(data: unknown): PublicSite | null {
  const parsed = publicSiteSchema.safeParse(data);
  if (!parsed.success) return null;
  const s = parsed.data;
  return {
    template: s.template,
    title: s.title,
    ...(s.tagline !== undefined && { tagline: s.tagline }),
    ...(s.date !== undefined && { date: s.date }),
    ...(s.location !== undefined && { location: s.location }),
    ...(s.story !== undefined && { story: s.story }),
    ...(s.travel !== undefined && { travel: s.travel }),
    faq: s.faq,
    registry: s.registry,
    events: s.events.map((e) => ({
      name: e.name,
      kind: e.kind,
      ...(e.localDate !== undefined && { localDate: e.localDate }),
      visibility: e.visibility,
      ...(e.when !== undefined && { when: e.when }),
      ...(e.where !== undefined && { where: e.where }),
      ...(e.notes !== undefined && { notes: e.notes }),
    })),
    ...(s.hotels !== undefined &&
      s.hotels.length > 0 && {
        hotels: s.hotels.map((h) => ({
          name: h.name,
          ...(h.address !== undefined && { address: h.address }),
          ...(h.phone !== undefined && { phone: h.phone }),
          ...(h.websiteUrl !== undefined && { websiteUrl: h.websiteUrl }),
          ...(h.note !== undefined && { note: h.note }),
          blocks: h.blocks.map((b) => ({
            checkIn: b.checkIn,
            checkOut: b.checkOut,
            ...(b.label !== undefined && { label: b.label }),
            ...(b.bookBy !== undefined && { bookBy: b.bookBy }),
            ...(b.bookingUrl !== undefined && { bookingUrl: b.bookingUrl }),
            ...(b.bookingCode !== undefined && { bookingCode: b.bookingCode }),
            // A rate is shown only together with its currency.
            ...(b.nightlyRateMinor !== undefined &&
              b.currency !== undefined && {
                nightlyRateMinor: b.nightlyRateMinor,
                currency: b.currency,
              }),
          })),
        })),
      }),
    ...(s.invitation !== undefined && { invitation: { label: s.invitation.label } }),
  };
}

export type SiteLookup =
  | { kind: "ok"; site: PublicSite }
  | { kind: "missing" }
  | { kind: "throttled" }
  | { kind: "unavailable" };

/** The published site for a slug, visible to everyone. Unpublished and unknown slugs look the same. */
export async function lookupPublishedSite(slug: string): Promise<SiteLookup> {
  const valid = validateSlug(slug);
  if (!valid.ok) return { kind: "missing" };
  const admin = createAdminClient();
  if (!admin) return { kind: "unavailable" };
  const { data, error } = await admin.rpc("public_site_view", { p_slug: valid.slug });
  if (error) return { kind: "unavailable" };
  if (data === null) return { kind: "missing" };
  const site = toPublicSite(data);
  return site ? { kind: "ok", site } : { kind: "unavailable" };
}

/** The same site plus the one event this invitation is for. Failures are indistinguishable. */
export async function lookupInvitedSite(slug: string, rawToken: string): Promise<SiteLookup> {
  const valid = validateSlug(slug);
  const admin = createAdminClient();
  const client = await clientKey();
  if (!admin || !client) return { kind: "unavailable" };
  const digest = tokenDigest(rawToken);
  // Malformed input still counts as a failed guess.
  const { data, error } = await admin.rpc("public_site_invite_view", {
    p_slug: valid.ok ? valid.slug : "x",
    p_token_hash: digest ?? "0".repeat(64),
    p_client: client,
  });
  if (error) return error.code === "RS429" ? { kind: "throttled" } : { kind: "unavailable" };
  if (data === null || !valid.ok || !digest) return { kind: "missing" };
  const site = toPublicSite(data);
  return site ? { kind: "ok", site } : { kind: "unavailable" };
}
