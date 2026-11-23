import "server-only";
import type { BlockTerms } from "@/domain/lodging/attrition";
import type { LodgingBlockRecord, LodgingHotelRecord } from "@/domain/lodging/publish";
import { isStayKind, type StayChoice, type StayRecord } from "@/domain/lodging/stays";
import { createUserClient } from "@/server/supabase/server";

export type LodgingHotel = LodgingHotelRecord & { candidateId: string | null; version: number };
export type LodgingBlock = LodgingBlockRecord &
  BlockTerms & { budgetCategoryId: string | null; version: number };
export type LodgingGuest = { id: string; name: string; household: string | null };

export type LodgingData = {
  hotels: LodgingHotel[];
  blocks: LodgingBlock[];
  stays: Map<string, StayRecord>;
  /** Guests attending at least one event (active, accepted, not archived). */
  attending: LodgingGuest[];
  categories: { id: string; name: string }[];
  vendors: { id: string; name: string }[];
  /** Latest change to any hotel or block, to tell the website editor its hotels are out of date. */
  lastChangedAt: string | null;
};

const choice = (kind: string | null, hotelId: string | null): StayChoice | null =>
  isStayKind(kind) ? { kind, hotelId: kind === "hotel" ? hotelId : null } : null;

const HOTEL_COLUMNS =
  "id, name, address, phone, website_url, guest_note, show_to_guests, show_rate, candidate_id, archived_at, version, created_at, updated_at";
const BLOCK_COLUMNS =
  "id, hotel_id, label, check_in, check_out, rooms_per_night, nightly_rate_minor, attrition_allowed_bp, attrition_charge_minor, cutoff_date, booking_url, booking_code, picked_up_room_nights, picked_up_as_of, budget_category_id, version, updated_at";

type HotelRow = {
  id: string;
  name: string;
  address: string | null;
  phone: string | null;
  website_url: string | null;
  guest_note: string | null;
  show_to_guests: boolean;
  show_rate: boolean;
  candidate_id: string | null;
  archived_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
};
type BlockRow = {
  id: string;
  hotel_id: string;
  label: string | null;
  check_in: string;
  check_out: string;
  rooms_per_night: number;
  nightly_rate_minor: number | null;
  attrition_allowed_bp: number | null;
  attrition_charge_minor: number | null;
  cutoff_date: string | null;
  booking_url: string | null;
  booking_code: string | null;
  picked_up_room_nights: number | null;
  picked_up_as_of: string | null;
  budget_category_id: string | null;
  version: number;
  updated_at: string;
};

export const toHotel = (h: HotelRow): LodgingHotel => ({
  id: h.id,
  name: h.name,
  address: h.address,
  phone: h.phone,
  websiteUrl: h.website_url,
  guestNote: h.guest_note,
  showToGuests: h.show_to_guests,
  showRate: h.show_rate,
  archived: h.archived_at !== null,
  createdAt: h.created_at,
  candidateId: h.candidate_id,
  version: h.version,
});

export const toBlock = (b: BlockRow): LodgingBlock => ({
  id: b.id,
  hotelId: b.hotel_id,
  label: b.label,
  checkIn: b.check_in,
  checkOut: b.check_out,
  roomsPerNight: b.rooms_per_night,
  nightlyRateMinor: b.nightly_rate_minor,
  attritionAllowedBp: b.attrition_allowed_bp,
  attritionChargeMinor: b.attrition_charge_minor,
  cutoffDate: b.cutoff_date,
  bookingUrl: b.booking_url,
  bookingCode: b.booking_code,
  pickedUpRoomNights: b.picked_up_room_nights,
  pickedUpAsOf: b.picked_up_as_of,
  budgetCategoryId: b.budget_category_id,
  version: b.version,
});

/** Hotels and blocks only (no guests), for the website editor and preview. */
export async function loadLodgingHotels(
  workspaceId: string,
): Promise<{ hotels: LodgingHotel[]; blocks: LodgingBlock[]; lastChangedAt: string | null }> {
  const supabase = await createUserClient();
  const [hotelRes, blockRes] = await Promise.all([
    supabase.from("lodging_hotels").select(HOTEL_COLUMNS).eq("wedding_id", workspaceId).limit(100),
    supabase.from("lodging_blocks").select(BLOCK_COLUMNS).eq("wedding_id", workspaceId).limit(500),
  ]);
  if (hotelRes.error || blockRes.error) throw new Error("Could not load lodging");
  const stamps = [...hotelRes.data, ...blockRes.data].map((r) => r.updated_at).sort();
  return {
    hotels: hotelRes.data.map(toHotel),
    blocks: blockRes.data.map(toBlock),
    lastChangedAt: stamps.at(-1) ?? null,
  };
}

/**
 * Everything the Lodging page needs. RLS limits lodging rows to people who manage guests. Names and
 * household names only: no contact, dietary or access details.
 */
export async function loadLodging(workspaceId: string): Promise<LodgingData> {
  const supabase = await createUserClient();
  const [base, stayRes, memberRes, catRes, vendorRes] = await Promise.all([
    loadLodgingHotels(workspaceId),
    supabase
      .from("lodging_stays")
      .select(
        "guest_id, planner_kind, planner_hotel_id, guest_kind, guest_hotel_id, guest_answered_at",
      )
      .eq("wedding_id", workspaceId)
      .limit(5000),
    supabase
      .from("invitation_members")
      .select("guest_id")
      .eq("wedding_id", workspaceId)
      .eq("active", true)
      .eq("rsvp_status", "accepted")
      .limit(10000),
    supabase
      .from("budget_categories")
      .select("id, name")
      .eq("wedding_id", workspaceId)
      .is("archived_at", null)
      .order("sort_order")
      .limit(100),
    supabase
      .from("candidates")
      .select("id, name")
      .eq("wedding_id", workspaceId)
      .order("name")
      .limit(500),
  ]);
  if (stayRes.error || memberRes.error || catRes.error || vendorRes.error) {
    throw new Error("Could not load lodging");
  }
  const ids = [...new Set(memberRes.data.map((m) => m.guest_id))];
  let attending: LodgingGuest[] = [];
  if (ids.length > 0) {
    const [guestRes, householdRes] = await Promise.all([
      supabase
        .from("guests")
        .select("id, full_name, household_id")
        .eq("wedding_id", workspaceId)
        .is("archived_at", null)
        .in("id", ids)
        .order("full_name")
        .limit(5000),
      supabase.from("households").select("id, name").eq("wedding_id", workspaceId).limit(5000),
    ]);
    if (guestRes.error || householdRes.error) throw new Error("Could not load lodging");
    const households = new Map(householdRes.data.map((h) => [h.id, h.name]));
    attending = guestRes.data.map((g) => ({
      id: g.id,
      name: g.full_name,
      household: g.household_id ? (households.get(g.household_id) ?? null) : null,
    }));
  }
  return {
    ...base,
    stays: new Map(
      stayRes.data.map((s) => [
        s.guest_id,
        {
          guestId: s.guest_id,
          planner: choice(s.planner_kind, s.planner_hotel_id),
          guest: choice(s.guest_kind, s.guest_hotel_id),
          guestAnsweredAt: s.guest_answered_at,
        },
      ]),
    ),
    attending,
    categories: catRes.data,
    vendors: vendorRes.data,
  };
}

export type PossibleCost = BlockTerms & {
  blockId: string;
  hotelName: string;
  hotelArchived: boolean;
  label: string | null;
  cutoffDate: string | null;
  budgetCategoryId: string | null;
};

/** Raw block numbers for the Budget page; any member may read them (no guest data). */
export async function loadPossibleCosts(workspaceId: string): Promise<PossibleCost[]> {
  const supabase = await createUserClient();
  const { data, error } = await supabase.rpc("lodging_possible_costs", { p_wedding: workspaceId });
  if (error) throw new Error("Could not load possible costs");
  return data.map((r) => ({
    blockId: r.block_id,
    hotelName: r.hotel_name,
    hotelArchived: r.hotel_archived,
    label: r.label,
    checkIn: r.check_in,
    checkOut: r.check_out,
    roomsPerNight: r.rooms_per_night,
    nightlyRateMinor: r.nightly_rate_minor,
    attritionAllowedBp: r.attrition_allowed_bp,
    attritionChargeMinor: r.attrition_charge_minor,
    cutoffDate: r.cutoff_date,
    pickedUpRoomNights: r.picked_up_room_nights,
    pickedUpAsOf: r.picked_up_as_of,
    budgetCategoryId: r.budget_category_id,
  }));
}
