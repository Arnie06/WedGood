# DEPENDENCY_TRACE.md

Traces are from reading code, not from running it (integration/e2e were not executed). `mig/` = `supabase/migrations/`. Mechanism vocabulary: **Auto-recompute** (derived on read from shared rows) · **Auto-transactional** (same DB transaction) · **Manual** (user re-enters) · **UI-only** · **Not implemented** · **Unknown**.

---

## Flow A — A guest RSVP changes → seating, meals, budget

### A.1 Request path (what actually executes)

| Step | Code | Notes |
|---|---|---|
| 1. Form | `src/features/events/rsvp-form.tsx` (route `src/app/rsvp/[token]`) | Per-member yes/no, meal select (`closed` disables, `:15,41,53`), optional plus-one name |
| 2. Server action | `submitRsvp` `src/server/rsvp/actions.ts:17-95` | Zod-validates uuids, caps 13 members, builds JSON; **only trust is the token digest** |
| 3. Privileged call | `admin.rpc("rsvp_submit", …)` `actions.ts:72-78` | Service role; `rsvp_submit` is granted to `service_role` only (`events_rsvp.sql:810-811`) |
| 4. Throttle + token | `rsvp_throttle` (`:185-202`), lookup by `token_hash`, revoked/expiry checked (`:687-692`) | Unknown/revoked/expired are indistinguishable; failures counted per client hash |
| 5. Serialize | `pg_advisory_xact_lock('guests:'||wedding)` then `FOR UPDATE` on the invitation (`:695-696`) | Same lock owners use for guest/seating writes |
| 6. Rules | deadline → `RS410` (`:701`); `version` → `55000` (`:704`); payload shape (`:707-711`) | Late RSVP refused for guests; owner override is audited (`:605-636`) |
| 7. Apply | per member `apply_member_response` (`:733`, redefined in `seating.sql:137-175`) | Validates meal belongs to this event and is active (`:158-163`); decline clears meal (`:157`); **no-op if unchanged** (`:164-166`) so retries are idempotent |
| 8. Seating | `seating_on_member_change(event, guest, status)` called at `seating.sql:172` | accepted → seat confirmed; pending → tentative if allowed else removed; **declined → seat deleted**; `layout.revision+1`; audit `seating.guest_released` (`:102-131`) |
| 9. Plus-one | `:739-776` | Same-name repeat finds existing (`:752-754`); else quota check `RS422`, guest cap, insert `guests`+`invitation_members`, `plus_ones_used+1` |
| 10. Version/audit | `:778-785` | invitation `version+1`, `weddings.revision+1`, `audit_events('rsvp.responded', counts only)` |
| 11. Return | `rsvp_projection` (`:248-277`) | Narrow projection; `workspaceId` stripped in `toPublicView` (`src/server/rsvp/public.ts:36-39`) |
| 12. Invalidate | `revalidatePath("/app/{id}","layout")` `actions.ts:94` | Server cache only; **no push** to an open owner tab (realtime excluded in `package.json` `db:start`) |

All of steps 5–10 are one SQL transaction. A concurrent owner seating call waits on the same advisory lock (`seating.sql:447`); test `seating.test.ts:476` “a guest declining while being seated cannot end up seated”.

### A.2 Downstream consumers

| Module | Status | Mechanism and evidence | What the user must do manually |
|---|---|---|---|
| Event guest counts (invited/accepted/pending/declined) | **Auto-recompute** | `summarizeResponses` `src/domain/guests/rsvp.ts:21-45`, fed by `src/server/events/queries.ts` reading `invitation_members` every render. Declines never count toward meals (`:37`) | nothing |
| Plus-one headcount, no double count | **Auto-transactional** (named) / **Partial** (unnamed) | Named claim becomes a guest in the same txn (`:762-767`). Unnamed allowance is never counted as accepted (correct) but there is **no “potential” figure** (`rsvp.ts:13-20`) | Read quota text per invitation (`guests/invitations/page.tsx:293`) |
| Seating eligibility / capacity / unseated list | **Auto-transactional + Auto-recompute** | Seat removed in txn (A.1 step 8); queue/occupancy derived in `src/domain/seating/plan.ts:285-310` from `loadSeating` (`server/seating/queries.ts:70-98`) | place newly accepted guests (by design: “never places a guest”) |
| Published/finalized seating | **Auto-transactional (stale flag)** | `layout.revision` differs from `finalized_revision` ⇒ stale; frozen counts shown (`queries.ts:21-30`); snapshot not rewritten until re-finalize (`seating.sql:515-564`) | re-finalize (single snapshot kept; history lost, see DATA_MODEL §3.4) |
| Meal selection / catering forecast | **Auto-recompute** | accepted-only meal counts `rsvp.ts:21-45`; seating totals `acceptedWithoutMeal` (`plan.ts:299-310`); package sections (`domain/packages/sections.ts:440-460`) | communicate counts to caterer (no guarantee entity, no sending) |
| Dietary/accessibility totals | **Auto-recompute** | `plan.ts` totals; details read only for managers (`queries.ts:44-49`) | nothing |
| **Budget per-person/per-meal** | **Manual (broken chain)** | `plan/budget/page.tsx:41` `guests = settings.targetGuestCount` → `summarizeBudget({guestCount})` (`summary.ts:66-74,234`). The value is `weddings.target_guest_count` (`core_tenancy.sql:60`), typed in settings. **Stops at: no code reads `invitation_members` for budget.** ADR `docs/15-DECISIONS.md:90` records this as intended | edit “guest target” in event settings after each RSVP wave; read “Per-guest costs use your guest target of N” (`budget/page.tsx:244-248`) |
| Quotes / comparisons | **Manual** | each comparison stores its own `guestCount` (`discover/compare/new/page.tsx:32,60`); staleness only when that stored number is edited (`comparison/staleness.ts:29-30`) | recreate/reprice comparisons |
| Event `target_attendance` | **Manual, display-only** | `events_rsvp.sql:25`; shown in `guests/invitations/page.tsx:160` | keep in sync by hand |
| Transport / hotel room-block demand | **Not implemented** | no model (grep `room_block|lodging|shuttle`) | track elsewhere |
| Rentals / stationery quantities | **Not implemented** | categories only (`domain/candidates/categories.ts`) | track elsewhere |
| Operational warnings / review queue | **Partial** | audit event + stale badges only; no review-item table | notice stale badges |
| Guest website | **Unaffected by design** | published snapshot only (`guest_website.sql:1-20`) | republish |
| Exports / packages | **Auto-recompute staleness** | digest re-derived and compared (`server/packages/queries.ts:118-158`) | regenerate package |
| Locked catering guarantee, contract, invoices, paid | **Unchanged (correct but vacuous)** | RSVP RPC never touches `commitments`/`payments` (grep in `events_rsvp.sql`, `seating.sql`: none). Guarantee/invoice entities do not exist | n/a |

**Verdict A:** RSVP → guest counts, plus-ones (named), seating, meals, snapshots, exports is **working end-to-end and race-tested**. RSVP → budget/quotes/transport/rentals is **broken at the first hop** and relies on manual re-entry.

---

## Flow B — A venue change → space, floor plan, vendors, transport

“Venue change” can mean (1) editing the venue candidate, (2) booking a different venue, (3) changing the event's venue. Only (1) and (2) exist.

| Step | Code | Result |
|---|---|---|
| Edit venue price/capacity | `update_candidate` RPC (`candidates.sql`, version-checked); fields `venues.seated_capacity/ceremony_capacity` (`:62-72`) | Writes the candidate and bumps `version` |
| Consumer 1: comparison decisions | `comparison_source_state` includes `candidateVersion`; `staleReasons` flags `vendor_changed` (`comparison/staleness.ts:29+`; test `comparisons.test.ts:447`) | **Auto-recompute:** a recorded decision shows “stale” |
| Consumer 2: quote capacity check | `evaluate.ts:43-44,107-109` compares venue seated capacity to the comparison's guest count | **Auto** on read, using the *typed* guest count |
| Book a different venue | `book_commitment` (`ledger.sql:278`): commitment + allocations + installments + stage `booked`, one txn; one active commitment per candidate (`:37-38`) | Works; **does not touch events, seating or timeline** |
| Event ↔ venue | **No link exists** (`events_rsvp.sql:18-31`; no `event_id` on candidates/commitments) | **Stops here** |
| Space | **Not modelled** (`venues` has no children) | n/a |
| Floor plan / seating tables | `seating_tables` belong to the event's layout (`seating.sql:43`), unrelated to any venue/space | No capacity or shape update |
| `events.capacity` | stored and editable (`event-forms.tsx:193`) but compared with nothing | UI-only value |
| Vendors tied to the venue | `timeline_items.vendor_id` FK exists (`timeline.sql:37`) but is per agenda item, not per event/venue | No cascade |
| Transport | **Not implemented** | n/a |

**Verdict B:** Broken at the first relationship. Changing the venue cannot update spaces, floor plan, vendor assignments or transport because the links do not exist. The user must hand-edit `events.capacity`, re-create seating tables, and re-check timeline locations (free text, `timeline.sql:25`). Only comparison decisions go stale.

---

## Flow C — Invoice / contract / guarantee → locked amounts vs. forecast

| Step | Code | Result |
|---|---|---|
| Quote selected | decision/stage only (`comparisons_decisions.sql`) | **No commitment created** (test `ledger.test.ts:127` T03) |
| Book | `book_commitment` `ledger.sql:278` | Atomic commitment + `commitment_allocations` (`unique active per item` `:54-56`) + `payment_installments` + stage; replay-safe (`ledger.test.ts:240`) |
| Forecast | `summarizeBudget` (`summary.ts:226-229`): an item covered by an active allocation counts **once, as the commitment**; uncommitted items use estimates (never below what was paid) | Forecast changes (e.g. guest target) **do not alter signed amounts** (correct) |
| Amend contract | `amend_commitment` (`ledger.sql:362`): old row `superseded`, new row supersedes, payments move with audit count; tests `ledger.test.ts:494,547,592` | Signed history preserved |
| Pay | `record_payment` (`:440`): append-only facts, refund ≤ net paid, external_ref unique; `void_payment` (`:526`) keeps the row | Payment ≠ proof money moved (manual record) |
| Currency | trigger refuses base-currency change once amounts exist (`budget.sql:119-134`, `ledger.sql:118-135`) | Safe |
| **Invoice** | **No record.** Only a file with `kind='invoice'` attachable to a payment/booking (`documents.sql:48`; `documents.test.ts:484`) | Not a financial state |
| **Catering guarantee** | **Does not exist** | n/a |
| Guest count falls below contractual minimum | `min_qty` appears only in the uncommitted estimate (`summary.ts:74`); a booked per-guest item is a fixed allocation | **No warning, no guarantee comparison** |

**Verdict C:** The *forecast ↔ signed ↔ paid* separation is **working** and tested. The *guarantee* and *invoice* links are **not modelled**, so “published seating and locked guarantee persist when a guest cancels” is true only vacuously (seating persists; there is no guarantee to lock or warn against). The chain stops at `commitments`: nothing connects a commitment to headcount or events.
