# CAPABILITY_MATRIX.md

> **Provisional requirement set.** The kit's `requirements.json` (94 REQ-*), the 52 DEP-* rules and the 42 AT-* tests were **not available** to this audit; only the executive PDF was. The IDs below (`COL-01`…) are **derived by the auditor from the PDF's domains, invariants (§2), dependency table (§4), false equivalences (§6) and first tests (§8)**. They are not the kit's REQ-* IDs and priorities (P0/P1/P2) are the auditor's judgement. Re-map to the real REQ-* list when the kit is supplied (see OPEN_QUESTIONS.md Q1).

Status key: **F** Verified implemented · **P** Partially implemented · **U** UI-only/stub · **M** Missing (verified) · **K** Unknown · **N** Not applicable. Confidence: H code read and/or test read; M code skimmed or test not re-run; L inferred. Paths are relative to the repo root; `supabase/migrations/` is abbreviated to `mig/`.

Requirements: 89. Verified implemented: 53, Missing (verified): 16, Not applicable: 1, Partially implemented: 19.

## Collaboration & ownership (weight 10%) — 68% of domain, 6.8 pts

| ID | Pri | Requirement | Status | Evidence | Conf | Notes |
|---|---|---|---|---|---|---|
| COL-01 | P0 | Wedding is the canonical project; people gain access via grants, never by duplicating the wedding | F | mig/20261120044804_core_tenancy.sql:53-90 (weddings; memberships unique(wedding_id,user_id)) | H | One wedding row, membership rows per user. |
| COL-02 | P0 | Wedding-scoped permissions enforced by backend (RLS + RPC), not only UI filters | F | mig/20261120044804_core_tenancy.sql:135-160 (is_member/has_role); tests/integration/tenancy.test.ts | H | Tests exist; integration suite not re-run in this audit. |
| COL-03 | P1 | Planner/firm Workspace entity that can span many weddings | M | No workspace/organization table in mig/ (26 migrations); docs/01-PRODUCT.md:45 lists 'professional workspaces' as later | H | In this app 'workspace' = one wedding (route /app/[w]). |
| COL-04 | P1 | Role model with last-owner protection and concurrent-removal safety | F | docs/15-DECISIONS.md:63; tests/integration/membership.test.ts:437 | H |  |
| COL-05 | P0 | Planner/editor role can perform planner work (scoped write grants) | P | src/domain/permissions/index.ts:50 (EDITOR_DEFAULT = view only); docs/15-DECISIONS.md:79 ('no grant mechanism yet') | H | Role is persisted and invitable but functionally equals viewer; partner is the only non-owner writer. |
| COL-06 | P1 | Scoped access per module/event/vendor (e.g. caterer sees only meals) | M | src/domain/permissions/index.ts:21-34 (flat capabilities); docs/10-SECURITY.md:7 lists 'Scoped vendor' column, no implementation | H | Packages (immutable redacted PDFs) are the only recipient-scoped output. |
| COL-07 | P1 | Collaborator invitation and token redemption | F | tests/integration/membership.test.ts:123,151 | M |  |
| COL-08 | P2 | Owner-visible change history | P | mig/20261120044804_core_tenancy.sql:91-120 (append-only audit_events); docs/15-DECISIONS.md:229 (activity view is a follow-up) | M | Audited by field name/counts only; no UI. |
| COL-09 | P2 | Comments/decisions collaboration | F | mig/20261205090000_comments.sql; tests/integration/comments.test.ts:192 | M |  |

## Events & venues (weight 8%) — 41% of domain, 3.3 pts

| ID | Pri | Requirement | Status | Evidence | Conf | Notes |
|---|---|---|---|---|---|---|
| EVT-01 | P0 | Wedding -> many Events with kind, date, capacity | F | mig/20261130090000_events_rsvp.sql:18-31 | H | Max 12 events per wedding (line 300). |
| EVT-02 | P1 | Timed segments within an event | F | mig/20261202090000_timeline.sql:14-41 (timeline_items FK to events) | H |  |
| EVT-03 | P0 | Reusable Venue -> Spaces | M | mig/20261123090000_candidates.sql:62-72 (venues = two capacity ints on a candidate); no spaces table anywhere | H |  |
| EVT-04 | P0 | Event Location link (event -> venue/space) | M | No event_id/venue_id relation: candidates, venues, commitments, proposals have none; events table has no location columns (mig/20261130090000_events_rsvp.sql:18-31) | H | Timeline item has free-text location only (timeline.sql:25). |
| EVT-05 | P1 | Space capacity checked against event attendance / seating | P | src/domain/comparison/evaluate.ts (venue seated_capacity vs comparison guestCount); events.capacity mig/20261130090000_events_rsvp.sql:26 unused for seating limits | M | Capacity is a hard constraint only inside quote comparison. |
| EVT-06 | P1 | IANA time zones and date-only semantics; per-event zone | P | mig/20261120044804_core_tenancy.sql:57 (wedding timezone); timeline.sql:24 (per-item timezone, DST validation in src/domain/timeline); events.local_date is date-only | M | No per-event time zone. |
| EVT-07 | P1 | Venue change cascades to floor plan/vendors/transport | M | No venue-event link, so nothing to cascade (see DEPENDENCY_TRACE.md flow B) | H |  |

## Invitations & RSVPs (weight 16%) — 83% of domain, 13.2 pts

| ID | Pri | Requirement | Status | Evidence | Conf | Notes |
|---|---|---|---|---|---|---|
| INV-01 | P0 | Per-event RSVP with independent outcomes per guest | F | mig/20261130090000_events_rsvp.sql:81-110 (invitation_members, active-unique per event+guest line 106); tests/integration/rsvp.test.ts:269 (T09) | H |  |
| INV-02 | P0 | Invitation party (household/group) distinct from named person | F | mig/20261130090000_events_rsvp.sql:53-75, create_invitations :411-517 | H |  |
| INV-03 | P0 | Plus-one claim exactly once incl. concurrent submits; quota enforced | F | mig/20261130090000_events_rsvp.sql:695 (advisory lock), :739-776; tests/integration/rsvp.test.ts:314,343 | H | Name-based dedupe (lower(full_name)); a renamed retry would consume a second slot. |
| INV-04 | P0 | Unnamed allowance is potential attendance, not confirmed; surfaced as its own metric | P | mig/20261130090000_events_rsvp.sql:61-62 (quota/used); src/features/events/rsvp-form.tsx:66 (shown to guest); no 'potential' in src/domain/guests/rsvp.ts:13-20 | H | Correctly not counted as accepted, but no potential headcount anywhere. |
| INV-05 | P0 | RSVP deadline enforced server-side; audited owner override | F | mig/20261130090000_events_rsvp.sql:701, :605-636; tests/integration/rsvp.test.ts:368 | H |  |
| INV-06 | P0 | Retry-safe RSVP: idempotent submit + optimistic concurrency | F | mig/20261130090000_events_rsvp.sql:233-235 (no-op returns false), :704; tests/integration/rsvp.test.ts:303 | H |  |
| INV-07 | P1 | Event-specific responses keep history | P | mig/20261130090000_events_rsvp.sql:90-94 (current state only), :781-784 (audit counts only) | H | No per-response history rows; audit has counts not before/after. |
| INV-08 | P0 | Public token safety: hashed, narrow projection, revoke/expire, throttle, indistinguishable failures | F | mig/20261130090000_events_rsvp.sql:60,:248-277,:641-658; tests/integration/rsvp.test.ts:441-509 | H | Risk: throttle key trusts x-forwarded-for (src/server/rsvp/public.ts:51-55). |
| INV-09 | P1 | Guest-count taxonomy: invited/named/confirmed/pending/potential/seated/fed/checked-in | P | src/domain/guests/rsvp.ts:13-20 (invited/accepted/pending/declined), src/domain/seating/plan.ts:299-310 (seated); no potential/fed/checked-in | H |  |
| INV-10 | P1 | Check-in tracked separately from RSVP | M | grep check_in\|checkin\|checked_in over src/ and migrations: no matches | H |  |
| INV-11 | P1 | Guest/household CRUD and atomic idempotent CSV import | F | mig/20261129090000_guests.sql:57-110; tests/integration/guests.test.ts:287 | H |  |
| INV-12 | P1 | Guest website: explicit allowlisted publish, immutable published snapshot | F | mig/20261204090000_guest_website.sql:1-20 | M |  |
| INV-13 | P2 | Truthful invitation delivery status (nothing sent silently) | F | mig/20261207090000_invitation_delivery.sql:1-3; src/server/mail (unconfigured adapter) | M | Manual 'shared by me' only; by design. |

## Dependency engine (weight 20%) — 60% of domain, 12.0 pts

| ID | Pri | Requirement | Status | Evidence | Conf | Notes |
|---|---|---|---|---|---|---|
| DEP-01 | P0 | RSVP change -> seating release/confirm in the same transaction | F | mig/20261201090000_seating.sql:137-175 (hook at :172), :102-131; tests/integration/seating.test.ts:476 | H |  |
| DEP-02 | P0 | Seating occupancy/unseated derived from shared state (no manual copies) | F | src/domain/seating/plan.ts:285-310; src/server/seating/queries.ts:70-98 (reads members+assignments each render) | H |  |
| DEP-03 | P0 | RSVP change -> live meal-option demand | F | src/domain/guests/rsvp.ts:21-45 (accepted only); package sections src/domain/packages/sections.ts:440-460 | H |  |
| DEP-04 | P0 | RSVP change -> budget per-person forecast | M | src/app/app/[w]/plan/budget/page.tsx:41 (guests = settings.targetGuestCount); src/domain/budget/summary.ts:66-74; mig/20261120044804_core_tenancy.sql:60 | H | Per-guest costing exists but is fed by a manually typed number, not RSVP state. |
| DEP-05 | P0 | One canonical derived headcount feeding every consumer | M | Three independent manual numbers: weddings.target_guest_count (core_tenancy.sql:60), events.target_attendance (events_rsvp.sql:25), comparisons guestCount (src/app/app/[w]/discover/compare/new/page.tsx:32,60) | H |  |
| DEP-06 | P0 | Forecast vs signed commitments vs paid are separate states; booked cost counted once | F | src/domain/budget/summary.ts:10-12,:226-229; mig/20261127090000_ledger.sql:54-56 (one active allocation per item); tests/integration/ledger.test.ts:133 | H |  |
| DEP-07 | P0 | Locked catering guarantee persists when a guest cancels | M | grep 'guarantee' over src/ and migrations: no matches | H | No guarantee entity, so no lock to preserve. |
| DEP-08 | P1 | Finalized seating persists; stale indicator when guests/seats change | F | mig/20261201090000_seating.sql:93-97,:515-564; src/server/seating/queries.ts:21-30 | H | Frozen counts + revision comparison. |
| DEP-09 | P1 | Rentals/stationery reforecast with warning if ordered/printed | M | Only budget categories/vendor categories (src/domain/candidates/categories.ts); no quantity drivers linked to RSVP | H |  |
| DEP-10 | P1 | Transport/hotel demand updates from RSVP | M | No transport or lodging model (grep room_block\|lodging\|shuttle in migrations: none) | H |  |
| DEP-11 | P1 | Critical change creates review issue/notification and is logged | P | mig/20261201090000_seating.sql:125-130 (audit 'seating.guest_released'); no notification/issue table | M | Log + stale badges, no review queue. |
| DEP-12 | P1 | Approval-required ops never automatic (guarantee, orders, contract, messages, payment) | P | mig/20261127090000_ledger.sql:362 (explicit amend RPC); src/server/mail (no provider); AGENTS.md rules | M | Nothing automatic exists to gate; no approval workflow either. |
| DEP-13 | P1 | Cross-module change atomic, versioned, idempotent | F | mig/20261130090000_events_rsvp.sql:693-785 (one txn: RSVP + seating + audit + revision) | H | For the chain that exists. |
| DEP-14 | P1 | Task reschedule by reviewed preview, signed dates untouched | F | src/domain/tasks/schedule.ts:40 previewReschedule; src/domain/tasks/tasks.test.ts:60 | M |  |
| DEP-15 | P1 | Immutable snapshots/packages with stale detection | F | mig/20261206090000_packages.sql:70-76; src/server/packages/queries.ts:118-158 | H |  |
| DEP-16 | P1 | Decisions go stale when inputs change | F | src/domain/comparison/staleness.ts:29; tests/integration/comparisons.test.ts:447 | H |  |
| DEP-17 | P2 | Async side-effect infrastructure (outbox/jobs) for cross-module effects | M | No queue/job/outbox in src/ or migrations; all effects are synchronous in RPCs | M | Acceptable at current scale; becomes necessary for notifications/messages. |

## Meals & seating (weight 10%) — 95% of domain, 9.5 pts

| ID | Pri | Requirement | Status | Evidence | Conf | Notes |
|---|---|---|---|---|---|---|
| MST-01 | P0 | Event-specific meal options and selections; decline clears eligibility | F | mig/20261130090000_events_rsvp.sql:36-51,:226; tests/integration/rsvp.test.ts:412 | H |  |
| MST-02 | P0 | Dietary/accessibility kept in a separate private store | F | mig/20261129090000_guests.sql:109-125 | H | Free text, not structured. |
| MST-03 | P0 | One seat per guest per layout; numbered seat unique per table at DB level | F | mig/20261201090000_seating.sql:68-74 | H |  |
| MST-04 | P0 | Capacity safe under concurrent assignment | F | mig/20261201090000_seating.sql:447-476 (RPC under advisory lock; clients have no write grants :80-83); tests/integration/seating.test.ts:453,467 (T10) | H | Capacity is RPC-enforced, not a table constraint. |
| MST-05 | P1 | Tentative vs confirmed guests separated | F | mig/20261201090000_seating.sql:63-66,:114-123 | H |  |
| MST-06 | P1 | Deterministic meal totals frozen in finalized snapshot | F | mig/20261201090000_seating.sql:532-554 | H |  |
| MST-07 | P1 | Seating restricted to eligible event guests | F | mig/20261201090000_seating.sql:455-467; tests/integration/seating.test.ts:359 | H |  |
| MST-08 | P1 | Meal Service/menu model (courses, service times) separate from options | P | mig/20261130090000_events_rsvp.sql:36-51 (named options per event only) | H | No menu, course, or service entity. |
| MST-09 | P2 | Seating tools: floor plan, numbered seats, suggestions, printed cards | F | mig/20261209090000_seating_floor_plan.sql; 20261210090000_seating_seats.sql; 20261211090000_seating_suggestion.sql | M | Active uncommitted work in progress in working tree; audited committed state only. |

## Vendors & finances (weight 12%) — 72% of domain, 8.7 pts

| ID | Pri | Requirement | Status | Evidence | Conf | Notes |
|---|---|---|---|---|---|---|
| FIN-01 | P0 | Directory Vendor -> Wedding Booking -> Event Assignments | P | mig/20261123090000_candidates.sql:14-60; 20261127090000_ledger.sql:18-40 (one active commitment per candidate); no event assignment table | H | Booking exists; event assignment does not. |
| FIN-02 | P0 | Same vendor across events without duplicated booking/expense | P | mig/20261127090000_ledger.sql:37-38 (unique active commitment per candidate) | H | Duplication prevented, but cannot express which events it serves. |
| FIN-03 | P0 | Quote selection is not booking; booking atomic | F | tests/integration/ledger.test.ts:127,133; mig/20261127090000_ledger.sql:278 | H |  |
| FIN-04 | P0 | Integer minor units; unknown is never zero | F | mig/20261126090000_budget.sql:1-9,:41 | H |  |
| FIN-05 | P0 | Payments append-only facts; void not delete; refund cap | F | mig/20261127090000_ledger.sql:73-90; tests/integration/ledger.test.ts:319,744 | H |  |
| FIN-06 | P0 | Contract and Invoice as separate records from payments | P | mig/20261127090000_ledger.sql:18-72 (commitment ~ contract, installments ~ schedule); invoice only as a document 'kind' (src/domain/documents/validate.ts) | M | No invoice amount/status/due record. |
| FIN-07 | P1 | Contract amendment preserves signed history | F | mig/20261127090000_ledger.sql:362; tests/integration/ledger.test.ts:494 | H |  |
| FIN-08 | P1 | Named pricing drivers (guest count, hours, units) shared by line items | P | mig/20261126090000_budget.sql:36,43-44 (cost_mode + literal quantity) | H | No driver entity; quantity typed per item. |
| FIN-09 | P1 | Scenarios (alternate budget/pricing at common assumptions) | P | src/domain/comparison/evaluate.ts; mig/20261125090000_comparisons_decisions.sql:102-140 | M | Quote comparison scenarios only; no whole-budget scenario. |
| FIN-10 | P1 | Refunds/contributions modelled | P | mig/20261127090000_ledger.sql:76 (refund kind) | M | Refunds yes; contributions/contingency not separately modelled. |
| FIN-11 | P2 | Currency cannot be silently reinterpreted | F | mig/20261126090000_budget.sql:119-134; 20261127090000_ledger.sql:118-135 | H |  |

## Travel & operations (weight 5%) — 50% of domain, 2.5 pts

| ID | Pri | Requirement | Status | Evidence | Conf | Notes |
|---|---|---|---|---|---|---|
| OPS-01 | P1 | Transport demand/bookings | M | No model (grep transport\|shuttle: only a vendor category in candidates.sql:20-23) | H |  |
| OPS-02 | P1 | Lodging/room-block demand | M | No model (grep lodging\|room_block: none) | H |  |
| OPS-03 | P1 | Run-of-show with responsible people/vendors | F | mig/20261202090000_timeline.sql:14-41 | H |  |
| OPS-04 | P2 | Recipient-specific redacted exports with immutable snapshots | F | mig/20261206090000_packages.sql:1-14,:70-76 | H |  |
| OPS-05 | P2 | Day-of handoff views | F | src/app/app/[w]/plan/day-of/[eventId]/page.tsx; tests/e2e/day-of.spec.ts (not re-run) | L | Page exists; not read in depth. |

## Dropdown UX (weight 7%) — 63% of domain, 4.4 pts

| ID | Pri | Requirement | Status | Evidence | Conf | Notes |
|---|---|---|---|---|---|---|
| PCK-01 | P0 | Pickers persist stable record IDs validated by composite FKs | F | mig/20261202090000_timeline.sql:36-37; 20261130090000_events_rsvp.sql:99-103; tests/integration/design.test.ts:645 | H |  |
| PCK-02 | P0 | Event -> eligible guests only (server-validated) | F | mig/20261201090000_seating.sql:455-467 | H |  |
| PCK-03 | P1 | Venue -> valid Spaces | M | No space entity (EVT-03) | H |  |
| PCK-04 | P1 | Booking -> events from same wedding | M | No booking-event relation (EVT-04, FIN-01) | H |  |
| PCK-05 | P1 | Seating plan -> unoccupied seats | F | mig/20261201090000_seating.sql:73; src/features/seating/seat-chips.tsx | M | UI picker not exercised in this audit. |
| PCK-06 | P1 | Invalid legacy selections stay visible and are revalidated | P | mig/20261130090000_events_rsvp.sql:377 (deactivated meal keeps existing choices) | L | Only verified for meal options; other pickers unknown. |
| PCK-07 | P2 | Option sets are data, not hard-coded | P | mig/20261123090000_candidates.sql:20-23; 20261130090000_events_rsvp.sql:22-23 (CHECK-constrained enums) | M | Vendor categories/event kinds fixed in DDL. |

## Security & reliability (weight 12%) — 96% of domain, 11.5 pts

| ID | Pri | Requirement | Status | Evidence | Conf | Notes |
|---|---|---|---|---|---|---|
| SEC-01 | P0 | RLS on every tenant table; clients have no direct writes | F | 43 of 43 `create table public.*` statements have a matching `enable row level security` (grep, this audit) and revoke client writes; tests/integration/guests.test.ts:415, seating.test.ts:226 | H |  |
| SEC-02 | P0 | Cross-wedding ID injection blocked by composite FKs/RPC checks | F | mig/20261130090000_events_rsvp.sql:73-74,:99-103; tests/integration/tenancy.test.ts, ledger.test.ts:772 | H |  |
| SEC-03 | P0 | Sensitive guest data protected; audit and exports redacted | F | mig/20261129090000_guests.sql:1-15; src/server/seating/queries.ts:44-49 | H |  |
| SEC-04 | P0 | Public RSVP/site reachable only via service-role RPCs, narrow projection | F | mig/20261130090000_events_rsvp.sql:810-811; tests/integration/rsvp.test.ts:216 | H |  |
| SEC-05 | P0 | Idempotency + concurrency control (locks, versions) | F | tests/integration/*: 5-concurrent-submit replay tests across budget/ledger/guests/comments | H |  |
| SEC-06 | P1 | Append-only audit | F | mig/20261120044804_core_tenancy.sql:109-120 | H |  |
| SEC-07 | P1 | Private storage with authorized reads | F | mig/20261128090000_documents.sql:80-; tests/integration/documents.test.ts:177 | M |  |
| SEC-08 | P1 | RSVP webhook idempotency | N | No webhook endpoints exist (grep webhook: none); RSVP is a server action + RPC | H | Justified N/A until an inbound provider is added. |
| SEC-09 | P1 | Throttle not defeatable by header spoofing | P | src/server/rsvp/public.ts:51-55 (x-forwarded-for first hop) | M | Risk, not confirmed exploit: depends on edge proxy overwriting the header. |
| SEC-10 | P1 | Reproducible forward-only migrations | F | supabase/migrations (26 files, timestamp ordered); docs/13-DEVOPS.md | M |  |
| SEC-11 | P1 | Automated tests cover critical invariants | F | pnpm-equivalent `vitest run`: 48 files / 634 tests passed (this audit); integration (tests/integration, 20 files) and e2e (tests/e2e, 27 specs) exist but were NOT re-run | M |  |

## Cross-references

- PDF §8 first tests: per-event RSVP → INV-01/02; plus-one exactly once → INV-03; RSVP → seating/catering/budget → DEP-01/03/04/05; published seating & locked guarantee → DEP-07/08; forecast vs contract/invoice/paid → DEP-06/FIN-06; tenant/ID validation/webhook idempotency → SEC-02/SEC-08.
- Kit DEP-* and AT-* identifiers could not be cross-referenced (files unavailable). See AT mapping in COMPARISON_REPORT.md.
