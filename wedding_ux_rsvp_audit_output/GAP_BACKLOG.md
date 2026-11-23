# GAP_BACKLOG.md

Ordered by value delivered per unit of risk. **Nothing here is implemented.** Type: **D** = design/presentation only (no schema), **I** = data-integrity or security, **F** = new capability. "Migration" = needs a new forward-only migration (deferred until you approve).

Baseline note: the earlier dependency audit (`audit-output/GAP_BACKLOG.md`, G-01…G-12) has largely been delivered by REL-01…REL-12 (event demand, reply-driven budget counts, venue spaces, event vendors, catering guarantees, invoices, reply/seating history, needs attention, scoped grants, per-event time zone). The gaps below are what remains for the **UX and guest RSVP** target.

## P0: smallest vertical slice (guest form → canonical state → planner view → impact)

| ID | Type | Gap | Change | Migration | Effort | Depends |
|---|---|---|---|---|---|---|
| UX-01 | D | Guest table has no RSVP data | Event selector + Answer/Meal/Seat columns + "waiting", "attending without meal", "attending not seated" filters on `/guests` (one server query over existing tables) | No | M | — |
| UX-02 | D+I | Planner override has no impact preview; seated guest loses seat silently | Wire `ImpactPreview` into OverrideForm with a read-only preview query (seat, plan staleness, caterer drift) | No | S | — |
| UX-03 | D | Guest form not conditional; no review/confirmation | Stepper on `/rsvp/[token]` for the **existing single-event** invitation: attendance → meals (only attending) → plus-one → review → confirmation. Same server action and RPC | No | M | — |
| UX-04 | I | Reply-by date stored as 23:59 **UTC** and shown in UTC | Compute end of day in the event's (or wedding's) zone; display in that zone; tests for zones east and west of UTC. Existing rows untouched | No (server/domain only) | S | — |
| UX-05 | D | Late-change consequences invisible on the guest | "Consequences" block on guest detail (W4) from `rsvp_changes` + `event_demand` + guarantee + seating revision | No | M | UX-01 helpful |

## P1: party link and guest-entered details

| ID | Type | Gap | Change | Migration | Effort | Depends |
|---|---|---|---|---|---|---|
| UX-06 | F+I | One link per event per party | `invitation_parties` (one token) grouping existing per-event `invitations`; `rsvp_party_view` / `rsvp_party_submit` locking all member invitations in one transaction; old per-event links keep working | **Yes** | L | UX-03, decision Q1 |
| UX-07 | F+I | No guest-entered dietary/accessibility | Optional per-person questions writing `guest_private_details` via the token RPC; never into audit/history text | **Yes** (RPC only) | M | decision Q2 |
| UX-08 | I | No whole-submission record | `rsvp_submissions` append-only (invitation/party, submitted_at, form_version, payload hash, accepted revision) for a Submission Inspector | **Yes** | S | — |
| UX-09 | D | Plus-one can't be removed by guest | RPC variant: decline + release place when added by guest | Yes (RPC replace) | S | — |
| UX-10 | D | Event Hub lacks budget section | Read existing per-guest items whose count source is the event | No | S | — |

## P2: form builder and operations

| ID | Type | Gap | Change | Migration | Effort |
|---|---|---|---|---|---|
| UX-11 | F | No RSVP Form Builder / versions / mappings | `rsvp_forms`, `rsvp_form_versions`, `rsvp_answers`; built-in questions locked; custom questions store answer-only unless a module mapping exists | Yes | XL |
| UX-12 | D | Issue center lacks detail/history | Item drawer reading existing audit events (W9) | No | S |
| UX-13 | D | Overview lacks deadline strip | W1 strip from `event_demand` | No | XS |
| UX-14 | F | Catering breakdown spread across pages | W8 card joining guarantee, booking, invoices | No | M |
| UX-15 | I | Throttle key trusts first `X-Forwarded-For` | Use the platform's trusted client-IP header once hosting is chosen; document | No | XS |
| UX-16 | F | Guest confirmation email, add-to-calendar, reminders | Behind the mail adapter, explicit approval per send (ADR deferral stands) | Maybe | L |
| UX-17 | F | Transport, lodging, check-in | Roadmap R3; consume `event_demand` | Yes | XL |
| UX-18 | D | Planner vs couple density | Compact table density toggle for editor role; same components | No | S |

## Release gates per slice

Feature flag (none exists yet; add a simple env/DB flag per slice), synthetic fixture via `pnpm db:seed`, unit + integration + E2E (axe, 320/390/1280) per slice, manual VoiceOver pass for UX-03, rollback = flag off (no schema in P0).
