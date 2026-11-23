import type { PublicHotel } from "@/domain/website/site";

/**
 * What the guest website shows about hotels. Mirrors `app_private.site_snapshot` so the editor's
 * preview matches what publishing copies: hotels marked for guests and not archived, in the order
 * they were added; no ids, no rooms held, pickup or attrition; a nightly rate only where the couple
 * ticked "Show the rate to guests".
 */
export type LodgingHotelRecord = {
  id: string;
  name: string;
  address: string | null;
  phone: string | null;
  websiteUrl: string | null;
  guestNote: string | null;
  showToGuests: boolean;
  showRate: boolean;
  archived: boolean;
  createdAt: string;
};

export type LodgingBlockRecord = {
  id: string;
  hotelId: string;
  label: string | null;
  checkIn: string;
  checkOut: string;
  nightlyRateMinor: number | null;
  cutoffDate: string | null;
  bookingUrl: string | null;
  bookingCode: string | null;
};

export function publicHotels(
  hotels: readonly LodgingHotelRecord[],
  blocks: readonly LodgingBlockRecord[],
  currency: string,
): PublicHotel[] {
  return [...hotels]
    .filter((h) => h.showToGuests && !h.archived)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    .map((h) => ({
      name: h.name,
      ...(h.address !== null && { address: h.address }),
      ...(h.phone !== null && { phone: h.phone }),
      ...(h.websiteUrl !== null && { websiteUrl: h.websiteUrl }),
      ...(h.guestNote !== null && { note: h.guestNote }),
      blocks: blocks
        .filter((b) => b.hotelId === h.id)
        .sort((a, b) => a.checkIn.localeCompare(b.checkIn) || a.id.localeCompare(b.id))
        .map((b) => ({
          checkIn: b.checkIn,
          checkOut: b.checkOut,
          ...(b.label !== null && { label: b.label }),
          ...(b.cutoffDate !== null && { bookBy: b.cutoffDate }),
          ...(b.bookingUrl !== null && { bookingUrl: b.bookingUrl }),
          ...(b.bookingCode !== null && { bookingCode: b.bookingCode }),
          ...(h.showRate &&
            b.nightlyRateMinor !== null && { nightlyRateMinor: b.nightlyRateMinor, currency }),
        })),
    }));
}
