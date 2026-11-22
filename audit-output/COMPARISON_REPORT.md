# COMPARISON_REPORT.md — WedGood vs. Wedding Dependency Platform

Audit date 2026-11-21 · Repo `main` @ `f6e29a1` plus an uncommitted working tree (seating UI work from another writer; not audited) · **Read-only**: nothing in `src/`, `supabase/`, `docs/` or `tests/` was changed; only `audit-output/` was created.

## 0. Read this first: what this audit could and could not use

- **Only the executive PDF was available.** `requirements.json` (94 REQ-*), `audit_results_template.json`, the 52 DEP-* rules and 42 AT-* tests were not in the repository, `~/Downloads`, or anywhere else I could search. Everything scored below uses **89 provisional requirements the auditor derived from the PDF** (domains and weights §7, invariants §2, dependency table §4, false equivalences §6, first tests §8). Priorities are my judgement. The headline score is therefore **indicative, not the kit's official score**. See OPEN_QUESTIONS.md Q1.
- **Executed:** the unit suite (`vitest run`: 48 files, 634 tests passed, 4.28 s). **Not executed:** integration (20 files, needs the developer's local Supabase and writes rows) and Playwright e2e. Integration tests were *read* and are cited by file:line as code-based confidence, not as a pass.
- `pnpm` is not on PATH in this shell; I called `node_modules/.bin/vitest` directly.

## 1. The simple answer

**The app is about 72/100 of the way to a connected wedding operating system (provisional), and it is a *strong, partly connected core* rather than a collection of isolated modules.**

- **Connected and correct:** *guest ↔ per-event RSVP ↔ plus-ones ↔ meal choice ↔ seating ↔ frozen seating snapshot ↔ exported package.* One RSVP change updates all of these inside a single database transaction, with locks, versions, idempotency, audit and a stale indicator. This is better than most apps the PDF's checklist is written to catch.
- **Connected and correct on the money side, internally:** *quote → booking → commitment → allocation → installments → payments → budget forecast.* A booked cost is counted once, signed amounts are amended by supersession, payments are append-only.
- **Not connected (the main gap):** those two clusters **do not talk to each other, and neither talks to venues/vendors/events.** An RSVP change never reaches the budget, quotes, comparisons, catering or any vendor. Venues have no spaces and are not linked to events. Vendor bookings are not linked to events. There is no catering guarantee, no invoice record, and no transport or lodging.

In the PDF's own test (§ "The question"): **one RSVP change correctly flows into seating, meals and guest counts, but not into per-person budget, and there is nothing to reach for catering guarantees, rentals, transport or hotel.** The user must re-type a guest target in settings for the budget, and re-run comparisons with a new count.

## 2. Observed architecture (evidence)

| Aspect | Finding |
|---|---|
| Framework | Next.js 16.4.6 App Router, React 19.3, TypeScript 6 strict, Tailwind 4, Zod 4 (`package.json`) |
| Data / auth | Supabase Postgres + Auth + private Storage, **local only** (`package.json` scripts; remote not configured) |
| Tenancy | Tenant = one **wedding** (`weddings`, `memberships`); roles owner/partner/editor/viewer (`mig/20261120044804_core_tenancy.sql:20,73`) |
| Write path | Clients have **SELECT only**; every write is a `SECURITY DEFINER` RPC that re-authorizes, takes locks, checks `version`, writes an `audit_events` row |
| Domain logic | Pure TS in `src/domain/*` (budget, seating, guests, comparison, tasks) used for derived views; the invariants that must be atomic live in SQL |
| Derived views | Computed **on read** from shared tables (e.g. `src/server/seating/queries.ts:70-98`, `src/domain/guests/rsvp.ts:21`); mutations call `revalidatePath("/app/{id}","layout")` |
| Background work | **None.** No queue, jobs, outbox, webhooks, realtime (`db:start` excludes realtime). Everything is synchronous in RPCs |
| Integrations | Mail is an unconfigured adapter (`src/server/mail`); nothing is sent. AI per `docs/09` not wired |
| Public surface | `/rsvp/[token]`, `/invite/[token]`, `/w/[slug]`; service-role RPCs only, throttled, narrow projections |
| Tests | 48 unit files / 634 tests (ran, pass); 20 integration files (~11k lines, not run); 27 Playwright specs (not run) |
| Schema | 26 forward-only migrations, 43 tables, **43/43 with RLS enabled** (grep) |

## 3. What the app already does well

1. **Event-specific RSVP is real**, not a field on Guest: `invitation_members` with a partial unique index “one active response per event and person” (`events_rsvp.sql:106`); test `rsvp.test.ts:269`.
2. **RSVP → seating is atomic.** `apply_member_response` calls `seating_on_member_change` in the same transaction (`seating.sql:137-175`): decline/archive/revoke removes the seat, accept confirms a tentative seat, `layout.revision` bumps so a finalized plan is stale. Race-tested (`seating.test.ts:453,467,476`, T10).
3. **Plus-one claim exactly once under concurrency** via per-wedding advisory lock and quota check (`events_rsvp.sql:695,739-776`; `rsvp.test.ts:314,343`).
4. **Forecast vs. commitment vs. paid are separate states.** Active allocation is unique per budget item (`ledger.sql:54-56`), payments are append-only with void (not delete), refund cap, amendments supersede (`ledger.sql:73-90,362`).
5. **Defence in depth for tenancy:** composite `(wedding_id, id)` foreign keys on essentially every relation (e.g. `events_rsvp.sql:99-103`, `timeline.sql:36-37`) so a forged cross-wedding ID fails in the database, not only in a dropdown filter.
6. **Honest unknowns:** null price ≠ zero (`budget.sql:1-9`); nothing sent automatically; delivery status is “shared manually”.
7. **Snapshots and staleness** are first-class: finalized seating (`seating.sql:515-564`), immutable packages with digest staleness (`packages.sql:70-76`, `server/packages/queries.ts:118-158`), decisions that go stale (`comparison/staleness.ts:29`).

## 4. Scores (provisional; see §0)

| Domain | Weight | Domain % | Weighted pts |
|---|---:|---:|---:|
| Collaboration & ownership | 10 | 68 | 6.8 |
| Events & venues | 8 | 41 | 3.3 |
| Invitations & RSVPs | 16 | 83 | 13.2 |
| Dependency engine | 20 | 60 | 12.0 |
| Meals & seating | 10 | 95 | 9.5 |
| Vendors & finances | 12 | 72 | 8.7 |
| Travel & operations | 5 | 50 | 2.5 |
| Dropdown UX | 7 | 63 | 4.4 |
| Security & reliability | 12 | 96 | 11.5 |
| **Total** | **100** | | **72.0** |

Requirement outcomes (89 total): 53 verified implemented, 19 partial, 16 verified missing, 0 UI-only, 0 unknown, 1 N/A (webhook idempotency; no webhooks exist). Method: Full 100 / Partial 50 / UI-only 15 / Missing 0, weights P0=3, P1=2, P2=1 within a domain (`audit-output/AUDIT_RESULTS.json`).

**Confidence / unknown coverage.** Zero requirements are scored Unknown, but that reflects the *provisional* set, not full coverage of the kit; the kit's 94 REQ-* likely contain items I did not derive (e.g. lodging block details, vendor portals). Treat 72 as ±8. Evidence quality: 66 of 89 rows High, 21 Medium, 2 Low (see matrix). Scope vs. defect is flagged below.

## 5. Top ten mismatches (real examples)

| # | Mismatch | Evidence | Scope or defect? |
|---|---|---|---|
| 1 | **Budget per-guest costs ignore RSVPs.** They multiply by a typed `weddings.target_guest_count`. Accept/decline changes nothing in the forecast. | `src/app/app/[w]/plan/budget/page.tsx:41`; `summary.ts:66-74`; `core_tenancy.sql:60` | Documented decision (`docs/15-DECISIONS.md:90`) but it fails the kit's core dependency |
| 2 | **Three unlinked headcounts**: wedding target, event `target_attendance`, comparison `guestCount` | `core_tenancy.sql:60`; `events_rsvp.sql:25`; `discover/compare/new/page.tsx:32,60` | Defect vs. kit §6 (“guest count is not a single metric”) |
| 3 | **No Event ↔ Venue/Space link.** `venues` is two capacity integers on a candidate; no spaces; events have no location | `candidates.sql:62-72`; `events_rsvp.sql:18-31` | Modelling gap (not stated out-of-scope) |
| 4 | **No Booking ↔ Event assignment.** One active commitment per vendor; cannot say which events it covers | `ledger.sql:37-38` | Modelling gap |
| 5 | **No catering guarantee** (no entity, no lock, no warning when accepted < contractual minimum) | grep `guarantee`: no matches; `min_qty` used only in uncommitted estimate (`summary.ts:74`) | Not in product docs at all |
| 6 | **No invoice record.** Only a file “kind”; payments attach to a commitment or cost | `documents/validate.ts`; `ledger.sql:73-90` | Gap vs. kit §2 |
| 7 | **Planner/editor role cannot edit anything.** `EDITOR_DEFAULT` = view-only; no grant mechanism; no multi-wedding planner workspace | `permissions/index.ts:50`; `docs/15-DECISIONS.md:79`; no workspace table | Acknowledged follow-up, but central to “planners and couples” |
| 8 | **Unnamed plus-one allowance is not a “potential” metric** (shown to guest only) | `rsvp.ts:13-20`; `rsvp-form.tsx:66` | Partial |
| 9 | **Finalized seating keeps only the latest snapshot.** The migration comment says historical snapshots are never rewritten, but finalize overwrites the single `snapshot` column | `seating.sql:17-18` vs `:555-558`; one layout per event (`:36` `unique(event_id)`) | Doc/behaviour mismatch (minor) |
| 10 | **No transport, lodging, check-in, rentals/stationery drivers** | grep: none | R3 roadmap scope (`docs/02-ROADMAP.md:32-34`) |

## 6. Security and data-integrity concerns

No confirmed vulnerability. **No S0 data-integrity break found.** Risks to verify:

- **Throttle key spoofing (risk).** The public RSVP throttle hashes the first `x-forwarded-for` entry (`src/server/rsvp/public.ts:51-55`). If the deployment edge does not overwrite that header, an attacker can rotate it to evade the 20-failure/10-minute limit. Tokens are high-entropy and hashed, so exploitation is guesswork-bound; verify deployment config.
- **Per-wedding advisory lock** is shared by owner writes and public RSVP submissions (`events_rsvp.sql:695`, `guests_lock_order.sql`). It is correct and tested, but one wedding's burst of RSVPs serializes all guest/seating writes for that wedding. Performance risk at scale, not a correctness bug.
- **Seat capacity is RPC-enforced, not a table constraint** (`seating.sql:469-473`). Safe because clients have no write grants; a future service-role code path or bulk import that writes `seat_assignments` directly would bypass it.
- **Plus-one dedupe by name** (`lower(full_name)`, `events_rsvp.sql:752-754`): a retry with a re-typed name creates a second plus-one and consumes quota. Bounded by quota (≤5).
- **RLS coverage is strong**: 43/43 tables; guest private data gated to owner/partner; audit stores field names/counts only.

## 7. What makes it “connected” vs. “independent modules”

| Link | Mechanism | Verdict |
|---|---|---|
| RSVP → seating | same-transaction SQL call | **Working end-to-end** |
| RSVP → meal totals | shared query on read | **Working** (recompute) |
| RSVP → seating snapshot staleness | revision bump | **Working** |
| RSVP → packages/exports | digest recompute on read | **Working** |
| RSVP → budget | none (manual target count) | **Not connected** |
| RSVP → comparisons/quotes | none (manual `guestCount`) | **Not connected** |
| Event ↔ venue/space | none | **Not modelled** |
| Vendor booking ↔ event | none (timeline item can reference a vendor) | **Not modelled** |
| Commitment → guarantee/invoice | none | **Not modelled** |
| Anything → transport/lodging/rentals | none | **Not modelled** |

## 8. Recommendation: incrementally improve (do not rewrite)

**Selective extension on the existing relational core. No rewrite, no restructure.** The tenancy model, RPC-only writes, composite FKs, versioning, idempotency and audit are the hard parts and they are right. The missing pieces are **new tables and read models**, all addable with forward-only migrations. Reasons: (1) every gap is an absent entity or an absent link, not a broken foundation; (2) the PDF itself says a rewrite must be justified by architectural constraints, and I found none; (3) the RSVP→seating RPC pattern is a template to extend. Cautions: the `weddings.revision` counter is bumped only by guests/seating RPCs (budget, ledger and candidates do not bump it), so any new cross-module snapshot must keep digest-based staleness; the shared per-wedding advisory lock will become a contention point as more modules join it.

### Five high-leverage changes (largest downstream unlock)

1. **Derived “event demand” read model** (SQL view/RPC): per event, invited / named / accepted / pending / declined / potential-plus-ones / seated / meal counts, from `invitation_members`. Unlocks budget, comparisons, packages, guarantees, transport, rentals. (Fixes mismatches 1, 2, 8.)
2. **Event ↔ venue/space and booking ↔ event links** (`event_locations`, `venue_spaces`, `event_assignments`). Unlocks venue-change cascades, capacity checks, vendor-per-event pickers, day-of. (3, 4.)
3. **Catering guarantee + invoice entities** on a commitment, with lock/revision and a “live count vs guarantee” warning. Unlocks the PDF's central “guarantee persists when a guest cancels” rule. (5, 6.)
4. **Real planner access:** editor write grants (per module/event) and an organization that can hold many weddings. Unlocks the planner persona. (7.)
5. **A change-impact/review record** (notification-or-review-issue table plus a tiny outbox) written by the same RPCs that already audit. Unlocks the “create review issue” and “approval-required” rows of the PDF §4–5 table.

## 9. Recommended next steps

1. Supply the kit's `requirements.json`, DEP and AT files; I will re-map and re-score (OPEN_QUESTIONS Q1).
2. Run integration + e2e against a disposable local DB to upgrade code-confidence to executed-pass (Q2).
3. Implement high-leverage change 1, then wire budget `guestCount` to it (GAP_BACKLOG G-01, G-02); this is the smallest change that flips the PDF's headline test.
4. Decide scope for 2–4 with the product owner (some are R3 by the roadmap).

## 10. AT-test cross-reference (kit IDs unavailable)

I could not use AT-001…AT-042. The PDF §8 “first tests” map to the repo's own named tests: per-event RSVP → `rsvp.test.ts:269` (T09); plus-one once → `rsvp.test.ts:314,343` (T08); concurrent seat → `seating.test.ts:453,467` (T10); token lifecycle → `rsvp.test.ts:441-509` (T23); financial separation → `ledger.test.ts:133,494`. None were executed here. See AUDIT_RESULTS.json `first_tests_pdf_s8`.
