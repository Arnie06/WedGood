# Connected Relationships — implementation plan

Status: **decisions accepted 2026-11-21 (ADR-031); tickets REL-01 to REL-12 added to `docs/14-BACKLOG.md`.** Nothing is implemented yet. When approved, copy the tickets into `docs/14-BACKLOG.md`, record the decisions in `docs/15-DECISIONS.md`, and track progress in `docs/16-IMPLEMENTATION-STATUS.md` (per `AGENTS.md`).

Source: `audit-output/COMPARISON_REPORT.md`, `GAP_BACKLOG.md`, `DATA_MODEL_COMPARISON.md`.

## 1. What "working how we want" means

When a guest replies, the change reaches every place that depends on the number of people. That includes the budget, quotes, the caterer count, capacity checks and seating. Signed amounts never change by themselves. The couple always sees **where a number came from** and **what needs their attention**.

### Five UX principles for this work

1. **Edit once, see everywhere.** Each fact has one home page. Other pages show it read-only with a link back ("From Reception replies →").
2. **Show the source of every number.** Any count or forecast that depends on another record has a small source label: *From replies*, *Typed by you*, *Locked 12 Dec*, *From contract*.
3. **Live numbers move; commitments don't.** Estimates update on their own. Contracts, locked caterer counts, invoices and payments only change when someone acts. When live and committed numbers drift apart, the app shows a calm warning. It never edits the commitment.
4. **Preview before consequences.** A change that affects other records shows what it will affect before saving, for example "Moving to the Terrace (110 seated) — your 12 tables seat 120." The preview is a warning, not a block.
5. **One "Needs attention" list.** Problems are collected on Home rather than scattered as banners. Each one links straight to the place where you fix it.

## 2. The key UX idea: an Event page that ties it together

Today an event's facts are split across Guests → Invitations, Seating, Day-of and Budget. Add an **Event page** at `/app/[w]/plan/events/[eventId]`, plus a list at `/plan/events`. It is the hub where the relationships become visible. It **summarizes and links**; it does not duplicate the editors.

Mobile layout (320–390px), stacked cards:

```
┌ Reception · Sat 12 Jun 2027 · 5:00 pm (America/New_York)   [Edit] ┐
│ ◂ Ceremony   Reception   Brunch ▸        (event switcher chips)    │
├ Who's coming ──────────────────────────────────────────────────────┤
│  96 yes · 14 waiting · 8 no · up to 6 more guests (plus-ones)       │
│  Planning number 110  ⓘ how we count                   [Guests →]   │
├ Where ─────────────────────────────────────────────────────────────┤
│  Rosewood Estate · Terrace   Fits 110 of 140 seated ✓   [Change]    │
├ Meals ─────────────────────────────────────────────────────────────┤
│  Chicken 51 · Fish 30 · Veg 15 · 4 yes without a choice  [Meals →]  │
│  Caterer count: Locked 118 on 12 May · now 96 yes   ⚠ 22 over       │
├ Seating ───────────────────────────────────────────────────────────┤
│  88 of 96 seated · Finalized, changed since          [Seating →]    │
├ Vendors at this event ─────────────────────────────────────────────┤
│  Caterer · Photographer · DJ                    [Assign vendors]    │
├ Agenda ────────────────────────────────────────────────────────────┤
│  5:00 Ceremony · 6:00 Cocktails · …                    [Day-of →]   │
└────────────────────────────────────────────────────────────────────┘
```

On desktop (1280px and up) the cards sit in two columns: who/where/meals on the left, seating/vendors/agenda on the right. The event switcher becomes a segmented control.

Navigation: add **Events** as a tool in the Plan group (`src/components/shell/nav-groups.ts`). Do not add a sixth bottom tab. Link to the Event page from the event cards on Guests → Invitations, the seating event picker, Day-of and Home. Event create/edit moves into the Event page tray; the Invitations page keeps a link.

## 3. Shared UI building blocks (built once, used by every ticket)

Put these in `src/components/ui/` using the existing tokens, `Tray` and `Badge`.

| Component | Purpose | Behaviour and accessibility |
|---|---|---|
| `SourceTag` | Small label for where a number came from: *From replies*, *Typed*, *Locked*, *From contract* | Text, not just colour; links to the source page when the person can view it |
| `CountStrip` | Headcount row: yes / waiting / no / potential plus-ones / planning number | An "ⓘ how we count" disclosure explains each word; numbers as text; wraps at 320px |
| `RecordPicker` | Linked-record dropdown (native `<select>` with option groups) | Saves the record ID. Groups like "At this venue" / "Other". **A saved value that is no longer valid stays visible** as "Garden Room (no longer at this venue)" with an inline fix prompt. The server re-validates every save |
| `ImpactPreview` | Confirmation that lists consequences before a linked change | Shown in a tray; plain list of effects; focus goes to the heading; Confirm (high-emphasis) and Cancel; Escape cancels and returns focus |
| `AttentionList` | "Needs attention" items on Home and the Event page | Each row has a sentence, a severity word ("Check", "Action needed"), a link and Dismiss; empty state "Nothing needs you right now" |
| `DriftNote` | Live number vs committed number ("Locked 118 · now 96 yes · 22 over") | Neutral wording, never alarming red for normal drift; pending tone when action is advised |

Copy follows `docs/18-UX-COPY-AND-DEMO.md`. Proposed fixed vocabulary, used everywhere:

| Word | Meaning |
|---|---|
| **Yes** | Accepted |
| **Waiting** | No reply yet |
| **No** | Declined |
| **Plus-ones not named yet** | Unused plus-one allowance |
| **Planning number** | The count you choose to plan with: *yes only*, *yes + waiting*, or *yes + waiting + plus-ones* |
| **Seated** | Has a seat at a table |
| **Caterer count** | The guarantee |

## 4. Decisions (accepted, recorded as ADR-031)

| # | Decision | Recommendation |
|---|---|---|
| D1 | Which number budgets and quotes use | **Accepted:** per item, a "count from" choice. New per-guest items default to the event's planning number; existing items keep "your guest target" |
| D2 | Who may see guest totals | **Accepted:** owner and partner only by default. An owner-only setting, "Let collaborators see guest totals", shows editors and viewers **totals only**, never names or private details. Without it, members see budget amounts but not the count behind reply-based items ("Based on replies"); help text notes the count can be worked out from price and amount |
| D3 | Default planning number | **Accepted:** *yes + waiting* until the event's RSVP deadline, then *yes only*; editable per event; unnamed plus-ones added only when an event opts in |
| D4 | What a vendor-to-event link points at | **Accepted:** the **vendor** (candidate), not the contract row. Amendments create a new contract row (`ledger.sql:362`), so linking to the contract would break the link |
| D5 | How a locked caterer count can change | Only by an explicit "Revise caterer count" with a reason. The old count is kept as superseded. Nothing is sent to the caterer |
| D6 | "Needs attention" items: stored or computed | **Computed on read** for conditions (drift, capacity, missing meals). **Stored** only for one-off events (e.g. "a seated guest declined after you finalized"), deduplicated |
| D7 | Planner/editor write access | **Accepted, in scope:** scoped grants per area (guests, guest private details, seating, budget, vendors, plan). A planner organization spanning many weddings stays **R4-02** |

## 5. Tickets

Effort: S 1–2 days · M 3–7 days · L 2–4 weeks. Every ticket follows the repo pattern:
- forward-only migration
- composite `(wedding_id, …)` foreign keys
- RLS for reads, RPC-only writes
- version checks, idempotency keys, field-name-only audit
- pure domain functions in `src/domain`
- unit, integration and e2e tests
- browser checks at 320/390/768/1280

### Phase 1 — The headcount spine (makes an RSVP flow to money)

**REL-01 · Event demand (M)**
- *Data:* SQL function `event_demand(p_wedding)` returning one row per event: invited, yes, waiting, no, plus-ones not named (`Σ quota − used` on active invitations), seated (confirmed/tentative), meal counts, yes without a meal. Add a `planning_basis` column on `events` (D3) and an owner-only wedding setting `share_guest_totals` (default off). The function returns counts to owner/partner, and to other members only when the setting is on (D2).
- *Domain/server:* `src/domain/events/demand.ts` (pure planning-number rule, deadline-aware); `loadEventDemand()` as the only reader. Refactor `summarizeResponses` callers to use it so counts match on every page.
- *UI:* `CountStrip` on the Guests page (per-event tabs) and Event cards. The "ⓘ how we count" text explains each word.
- *Tests:*
  - accept, decline, revoke, archive and plus-one cases; quota 0 and full quota
  - counts equal the seating totals
  - viewer gets nothing with the setting off, totals only with it on, never names (D2); only an owner can change the setting
  - cross-wedding call refused
  - concurrent `rsvp_submit` then read gives consistent numbers

**REL-02 · Event page and Events list (M)** — depends on REL-01
- Owner-only toggle "Let collaborators see guest totals" lives on Settings → Members, with help text: totals only, never names; the budget can still reveal a count from price and amount.
- `/plan/events` and `/plan/events/[eventId]` as in §2. Move the event edit tray here; add the switcher; empty states for each card ("No venue yet — choose where this happens").
- Cards for features not built yet are **absent**, not disabled (per `docs/04-UX-FLOWS.md`).
- *Tests:*
  - e2e: open from Guests, Seating and Home; switch events by keyboard
  - axe checks; no overflow at 320
  - a viewer sees only the cards their role allows

**REL-03 · Budget items count from replies (M)** — depends on REL-01 and D1
- *Data:* on `budget_items`, add `count_source` (`wedding_target` | `event_planning` | `event_yes` | `manual`), `count_event_id` (composite FK) and `per_guest_multiplier` (optional, e.g. 1 chair per guest). Backfill existing per-guest items to `wedding_target`. Quantity items may also use an event source, e.g. "1 favour per yes" for rentals and stationery.
- *Domain:* `summarizeBudget` takes a count per item instead of one `guestCount`. Committed items still count the commitment once (unchanged rule).
- *UI:*
  - Budget item tray: "Count guests from" `RecordPicker` with "Reception — planning number (110)", "Reception — yes only (96)", "Your guest target (120)" and "A number I type".
  - Each per-guest row shows `SourceTag` and the arithmetic in muted text: "110 × $95, min 120 → $11,400".
  - A booked per-guest item shows a `DriftNote` against its contract: "Booked for 120 · now 110 expected".
  - Replace the page banner "Per-guest costs use your guest target of N" with per-row sources.
- *Tests:*
  - decline lowers the forecast; booked amount unchanged
  - backfilled items give an identical forecast before and after the migration
  - unknown amounts still unknown
  - a member without totals access sees the amount but no count or arithmetic, and the server never sends them the raw count
  - counting from another wedding's event refused

**REL-04 · Quotes and comparisons offer the live count (S)** — depends on REL-01
- Compare setup defaults the guest count to the chosen event's planning number, with a `SourceTag` and an override field.
- Saved comparisons keep their stored count (they are a record of the decision). When the live number differs by 5% or more, show "Replies now suggest 104. Reprice?", which creates a repriced copy. The original is never changed.
- *Tests:* default value; override kept; reprice creates a new comparison; decision staleness unchanged.

**REL-05 · Change history for replies and seating (S)**
- *Data:* append-only `rsvp_changes` written inside `apply_member_response` (event, guest, from→to, actor or "guest", at), with no row on a no-op retry. Add a `seating_snapshots` table and move the current snapshot into it; finalizing adds a row.
- *UI:* the guest tray gets "Reply history" per event. Seating gets "Finalized versions" (date, who, counts) with view-only snapshots.
- *Tests:* a retry writes nothing; finalizing twice gives two immutable rows; staleness still works; history is not visible to viewers.

### Phase 2 — Places and vendors (makes a venue change make sense)

**REL-06 · Venue spaces and event location (L)**
- *Data:* `venue_spaces` (venue candidate, name, seated and standing capacity, notes) and `event_locations` (one per event: venue candidate plus optional space). Keep `events.capacity` as an override; space capacity is the default.
- *UI:*
  - Venue detail (`discover/[candidateId]`): a "Spaces" section with an add/edit tray.
  - Event page "Where" card with two linked `RecordPicker`s: Venue, then "Space at this venue". Changing the venue clears the space and says so.
  - A fit badge against the planning number: "Fits 110 of 140 ✓" or "Short by 12".
  - Changing the location opens an `ImpactPreview` listing: seat total of the current tables vs the new capacity, agenda items whose location text names the old venue (with an offer to update them), and the booking with the old venue still active (a reminder, not an action).
  - The seating header shows "Tables seat 120 · Terrace seats 110".
- *Tests:*
  - space from another venue or wedding refused
  - stale saved space shown as "(no longer at this venue)"
  - capacity fit at boundaries; impact preview lists the right items

**REL-07 · Vendors assigned to events (M)** — depends on D4
- *Data:* `event_vendors` (vendor candidate, event, role label), unique per pair; only booked or shortlisted vendors.
- *UI:*
  - Booking page: "Works at" event chips (multi-select, events of this wedding only).
  - Event page: "Vendors at this event" card.
  - The agenda item vendor picker groups "At this event" first, then "Other vendors".
  - Day-of handoff lists vendors and contacts per event.
- *Tests:*
  - assignment survives a contract amendment
  - no duplicate pair; cross-wedding refused
  - archived vendor shown as "(archived)" where still referenced

### Phase 3 — Commitments that hold (makes cancellations safe)

**REL-08 · Caterer count, the guarantee (L)** — depends on REL-01, REL-07 and D5
- *Data:* `catering_guarantees` (event, caterer vendor, guaranteed count, meal breakdown jsonb, due date, status draft/locked/superseded, locked_at/by, supersedes_id, reason).
- *RPCs:* `lock_guarantee` (version- and idempotency-checked; refused if the meal breakdown no longer matches what was previewed) and `revise_guarantee` (reason required; supersedes the old row).
- *UI:*
  - Event page "Caterer count" card with a due date. A task "Send final count to caterer" appears in Next actions 7 days before (uses the existing tasks).
  - Lock flow in a tray: the current planning number and meal breakdown, "You're telling the caterer 118", a high-emphasis **Lock count** button, then a success state offering a caterer package.
  - After locking: `DriftNote` on the Event, Seating and Budget pages ("Locked 118 · now 96 yes").
  - The caterer package includes the locked count and its date. Nothing is emailed.
- *Tests:*
  - PDF §8 test 4: a guest cancels after the lock, the guarantee is unchanged, a warning appears and seating is stale
  - revise keeps history; concurrent locks give one winner; viewer cannot lock

**REL-09 · Invoices (M)**
- *Data:* `invoices` (contract, number, amount, issued/due dates, void); `payments.invoice_id` optional; invoices move with an amendment like payments do.
- *UI:*
  - The booking page becomes a vertical ladder: **Contract $12,000 → Invoiced $6,000 → Paid $4,000 → Still to pay**, each step with its list.
  - The payment tray gets a "For which invoice?" picker limited to this booking.
  - The budget summary adds "Invoiced, not yet paid".
- *Tests:* PDF §8 test 5 (forecast changes; contract/invoice/paid don't); invoice larger than the contract flagged; foreign invoice refused.

### Phase 4 — Attention and access

**REL-10 · Needs attention (M)** — depends on REL-01, 06, 08
- *Computed conditions:* planning number over the space capacity; caterer count drift; yes without a meal after the deadline; seated count below yes on a finalized plan; venue booking active for a venue no event uses.
- *Stored one-off items:* "A seated guest declined after you finalized"; written in `seating_on_member_change`; deduplicated while open.
- *UI:* `AttentionList` on Home (top three, with "See all") and on the Event page filtered to that event; a count badge on the Plan nav item; Dismiss or "Mark handled".
- *Tests:* one item per real change, none on retry; dismissed items stay dismissed; viewers see only what their role allows.

**REL-11 · Planner/editor permissions (L)** — depends on D7; schedule deliberately
- *Data:* `membership_grants` (area: guests, guest private details, seating, budget, vendors, plan). Rewrite the `app_private.can_manage_*` helpers to check grants; owners and partners stay unchanged.
- *UI:* the members tray gets "What can they change?" with one plain sentence per area. Private guest details are a separate, clearly labelled toggle.
- *Tests:* a full role × area matrix in integration tests; last-owner rules unchanged; revoking a grant takes effect immediately.

**REL-12 · Per-event time zone (S, optional)** — `events.timezone` defaulting to the wedding's zone; reuse the timeline conversion; the Event page header shows the zone.

### Deliberately out of this plan (already roadmapped)

- **Transport and lodging (R3-03):** will consume `event_demand` and `event_vendors`.
- **Saved budget scenarios (R2-03):** will reuse per-item count sources.
- **Planner organizations spanning weddings (R4-02).**
- **Check-in (with R3-04).**

## 6. End-to-end check that proves it works

Add one Playwright golden path, `tests/e2e/connected.spec.ts`, plus an integration twin:

1. Guest replies **yes** with fish → Guests and the Event page show 1 more yes and 1 more fish; the per-guest catering forecast rises by one guest.
2. Owner seats them and finalizes seating; locks a caterer count of 118.
3. The same guest replies **no** → seat released; seating "changed since"; fish −1; forecast falls; **booked amount, locked count, invoices and payments unchanged**; the Event page shows "Locked 118 · now 117"; Home shows "A seated guest declined after you finalized".
4. Owner moves the event to a smaller space → the impact preview lists the table-seat shortfall; after confirming, the fit badge shows "Short by N" and it appears in Needs attention.
5. Accessibility and layout: axe passes and there is no horizontal scroll at 320/390/768/1280 on Home, the Event page, Budget, Seating and the booking page; every step is keyboard-only.

## 7. Order, effort and risks

| Order | Tickets | Rough effort |
|---|---|---|
| 0 | Settle the current uncommitted seating work (one writer per tree); record D1–D7 | S |
| 1 | REL-01 → REL-02 → REL-03 → REL-04 → REL-05 | ~3–4 weeks |
| 2 | REL-07 → REL-06 | ~3–4 weeks |
| 3 | REL-08 → REL-09 | ~3 weeks |
| 4 | REL-10, then REL-11 (and REL-12 if wanted) | ~3–4 weeks |

Risks and mitigations:

| Risk | Mitigation |
|---|---|
| **Silent forecast changes on upgrade** | REL-03 backfills to the current source; the summary is identical before and after the migration (tested) |
| **Permission widening** for aggregate counts (D2) | Aggregate-only function with no names; explicit tests that a viewer gets no guest names |
| **Lock contention** | New writes that touch guests or seating must take the existing per-wedding lock in the documented order (`guests_lock_order.sql`) |
| **`weddings.revision` is not bumped by budget/ledger** | Packages and any new snapshot keep digest-based staleness |
| **Scope creep** | The Event page links rather than embeds editors; each ticket is one vertical slice |
| **Release gate** | Phases 1–3 touch financial and RSVP rules, so get an independent Codex review (`prompts/04-REVIEW.md`) before each merge |
