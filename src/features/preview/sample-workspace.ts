import type { Commitment, PaymentRecord } from "@/domain/budget/commitments";
import { parseDateOnly, type DateOnly } from "@/domain/dates/date-only";
import type { EventResponse } from "@/domain/guests/rsvp";

/**
 * SYNTHETIC SAMPLE DATA. Fictional people and figures from
 * docs/18-UX-COPY-AND-DEMO.md, used only by the /preview route. It is never
 * stored, never mixed with account data, and every screen using it is
 * labelled as sample data.
 */
export const SAMPLE_DATA_LABEL = "Sample data";

export type SampleTask = {
  id: string;
  title: string;
  dueDate: DateOnly | null;
  done: boolean;
};

export type SampleEvent = {
  id: string;
  name: string;
  date: DateOnly;
  mealOptions: ReadonlyArray<{ id: string; name: string }>;
  responses: readonly EventResponse[];
};

export type SampleWorkspace = {
  synthetic: true;
  name: string;
  weddingDate: DateOnly;
  timezone: string;
  currency: string;
  targetBudgetMinor: number;
  targetGuestCount: number;
  /** Fixed "today" so the preview and its tests are deterministic. */
  referenceDate: DateOnly;
  guests: ReadonlyArray<{ id: string; name: string }>;
  events: readonly SampleEvent[];
  commitments: readonly Commitment[];
  payments: readonly PaymentRecord[];
  tasks: readonly SampleTask[];
};

const d = parseDateOnly;

export const sampleWorkspace: SampleWorkspace = {
  synthetic: true,
  name: "Alex & Morgan",
  weddingDate: d("2027-05-22"),
  timezone: "America/Los_Angeles",
  currency: "USD",
  targetBudgetMinor: 4_000_000,
  targetGuestCount: 120,
  referenceDate: d("2026-11-19"),
  guests: [
    { id: "g-avery", name: "Avery Example" },
    { id: "g-jordan", name: "Jordan Example" },
    { id: "g-riley", name: "Riley Example" },
    { id: "g-sam", name: "Sam Example" },
    { id: "g-casey", name: "Casey Example" },
    { id: "g-quinn", name: "Quinn Example" },
  ],
  events: [
    {
      id: "e-reception",
      name: "Ceremony & reception",
      date: d("2027-05-22"),
      mealOptions: [
        { id: "m-chicken", name: "Chicken" },
        { id: "m-vegetarian", name: "Vegetarian" },
        { id: "m-fish", name: "Fish" },
      ],
      responses: [
        { guestId: "g-avery", eligible: true, rsvpStatus: "accepted", mealOptionId: "m-chicken" },
        {
          guestId: "g-jordan",
          eligible: true,
          rsvpStatus: "accepted",
          mealOptionId: "m-vegetarian",
        },
        {
          guestId: "g-riley",
          eligible: true,
          rsvpStatus: "accepted",
          mealOptionId: "m-vegetarian",
        },
        { guestId: "g-sam", eligible: true, rsvpStatus: "accepted", mealOptionId: "m-fish" },
        { guestId: "g-casey", eligible: true, rsvpStatus: "pending", mealOptionId: null },
        { guestId: "g-quinn", eligible: true, rsvpStatus: "declined", mealOptionId: null },
      ],
    },
    {
      id: "e-rehearsal",
      name: "Rehearsal dinner",
      date: d("2027-05-21"),
      mealOptions: [],
      responses: [
        { guestId: "g-avery", eligible: true, rsvpStatus: "accepted", mealOptionId: null },
        { guestId: "g-jordan", eligible: true, rsvpStatus: "pending", mealOptionId: null },
      ],
    },
  ],
  commitments: [{ id: "c-venue", amountMinor: 1_000_000, status: "active" }],
  payments: [
    { id: "p-venue-deposit", commitmentId: "c-venue", kind: "charge", amountMinor: 250_000 },
  ],
  tasks: [
    { id: "t-budget", title: "Agree on an overall budget", dueDate: d("2026-11-01"), done: true },
    { id: "t-venue", title: "Book the venue", dueDate: d("2026-11-15"), done: true },
    { id: "t-guests", title: "Draft the guest list", dueDate: d("2026-12-01"), done: false },
    { id: "t-photo", title: "Shortlist photographers", dueDate: d("2026-12-15"), done: false },
    { id: "t-save", title: "Send save-the-dates", dueDate: d("2027-01-10"), done: false },
    { id: "t-attire", title: "Start attire appointments", dueDate: d("2027-02-01"), done: false },
    { id: "t-music", title: "Choose ceremony music", dueDate: null, done: false },
  ],
};
