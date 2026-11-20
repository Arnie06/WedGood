# Domain rules and dependency engine

All rules are server authoritative, deterministic, and tested independently of AI. UI previews use the same pure functions where safe. Unknown is never zero. All critical changes atomic, idempotent and audited; transaction locks for concurrent constraints.

## Money definitions

R1 base currency only. Store integer minor units, positive amounts; payments use charge/refund type. Use decimal/rational math for rates and round per documented line/contract policy (default round half up to nearest minor unit). Never use binary floats for persisted totals. Distinguish tax-inclusive and tax-exclusive lines; unknown mandatory charges produce incomplete total. No implicit currency conversion. Reject mixed currencies in aggregates; report excluded items.

- Target = user-defined ceiling; null means unset.
- Allocated = sum category targets (may differ from target; warn).
- Net paid = actual charges minus actual refunds; scheduled installments are not paid. Refund must reference eligible paid amount, no arbitrary negative balances; approved credits/overpayments represented separately and surfaced.
- Committed = active signed/explicitly confirmed obligation amounts, not all quotes. Outstanding = sum max(commitment amount - net payments applied to that commitment, 0), separately flag overpayment.
- Forecast = active commitments + uncommitted expected costs (each at least known net paid for that cost) + separately modeled costs not represented by commitments + reserved contingency (if forecast view includes reserve). Avoid double counting covered budget items; recorded standalone expenses count once. Unknown estimate produces known subtotal and incomplete flag. Reserve is planned, not a payment or obligation.
- Remaining uncommitted against target = target - active commitments - net paid for costs without active commitment; not the same as forecast headroom (`target - forecast`). Return null when target unset.
- Contributions = pledged and received funding, separate from expenses. Never reduce cost by funding. Cash requirement and available funding can be shown independently.
- Booking transaction creates active commitment and covered budget allocations, not a second forecast line; quote selection alone does not book. Amendments preserve old commitment and supersede only after explicit review, reallocating applicable payments audibly. Cancellation retains non-refundable amounts/fees or unresolved liability; never silently zero owed.
- Installment reconciliation flags schedule mismatch. No direct money movement in R1; recorded payments are manual records. Deleting a linked financial record archives or reverses, not hard-delete historical facts.

### Cost mode and examples

Fixed = amount. Per person = unit × max(scenario quantity, contractual minimum); tiers or maximum beyond supported scope flagged. Quantity = unit × units. Included = no additive amount, points to parent fee. Percent = declared basis × rate, with explicit permitted dependencies (acyclic). Required unknown = completeness false. Optional selection recorded. Pricing must specify per-event/per-person/per-unit and basis. Apply service charge/tax only to identified taxable base; don't assume every line taxed.

Demo: catering $95 per guest × min 120, bar $30 × guest count, fixed venue $10,000, other $10,000. At 120, estimated subtotal $35,000; 10% contingency $3,500; forecast $38,500. At 140, $37,500 + $3,750 = $41,250. At 100, catering remains $11,400 minimum, bar $3,000, fixed $20,000 → $34,400 before reserve. Only estimates change; fixed signed obligations unchanged unless reviewed amendment.

## Discovery / comparison

Compare same event, currency, quantities and date; normalized cost rows preserve original proposal and evidence. Show known subtotal with missing mandatory fees. Unknown availability/capacity remains unknown; never imply a match is confirmed. Hard requirements (e.g. verified capacity below target, inaccessible facility if essential) flag incompatible, separate from weighted preference score. Scoring: weighted sum of known 0–100 criterion ratings / known weight sum; display rated weight coverage / total; no ranked score if no positive known weights, all zero, or critical unknowns not explicitly accepted. Never compare a low-coverage high score as definitive. Score inputs manually sourced/explained. Tie stable by user sort or name. Paid placements do not affect score. Decision captures snapshot of inputs, timestamp and chosen option; later proposal changes mark comparison stale, not silently change decision.

## Invitations and guests

Guest unique by ID, not name; household grouping not assumption of shared attendance. One active response per event/person. Distinguish invited, accepted, pending, declined, revoked; delivery status separate. RSVP counts use eligible active members, event-specific; pending = no final response. Invitation can contain existing people and quota-limited plus-ones; no arbitrary guest additions from token. Approved plus-one creates new guest and member atomically, consumes quota, audit. Edits respect deadline (owner may override with reason). Revoked/expired token cannot read/write. Retried response must not duplicate plus-one. Direct owner response uses same rules. Decline clears/archives active meal selection for counts; retain history appropriately. Hide sensitive notes from RSVP response. Guest changes never modify another event automatically.

## Seating

Only active current layout affects operational counts. A guest has at most one assignment per layout; same event invitation membership, no overcapacity (lock table/layout and validate count), unique numbered seats. Confirmed accepted guests are eligible for confirmed assignment; pending may be tentative only if couple enables. Declined removed from active layout by default, audit and stale final version warning. Accept moves guest to queue, not automatically arbitrary table. Meal choice updates table summaries; no double counting. Layout finalized means freeze versioned snapshot; subsequent RSVP/seat edits mark stale, require re-finalize, never alter historical export. Unassigned accepted count = accepted eligible minus confirmed assigned; tentative assignments separate. At capacity, suggest creating table or moving guest; transaction prevents two simultaneous final seats.

R2 auto-seating: hard constraints capacity + explicit must-link/must-separate + required access semantics; soft preferences weighted separately. Detect contradictory rules and report infeasible, allow user to modify preferences, no secret demographic judgments. AI may help express rules; deterministic solver or validated heuristic outputs proposals only. R3 scaled floor plan uses real units and calibration; geometry/clearance warnings advisory, not certified fire/access compliance.

## Tasks, dates and timeline

Templates use stable key and anchor date offset; date not set = unscheduled. Re-generating template does not duplicate or overwrite user customizations. Date changes preview relative tasks; fixed contractual due dates unchanged; explicit approved reschedule. Convert local time with IANA zone, validate ambiguous/nonexistent DST times. Cross-midnight supported via timestamp; durations nonnegative. Dependency cycle prohibited. Timeline may overlap where vendors act simultaneously; warn only for conflicting assigned resources. Concurrent writes use expected version.

## Dependency map

| Source event | Derived changes (same transaction or query) | Review / async (outbox) |
|---|---|---|
| Guest RSVP accepted/declined | Counts, active seating queue/removal, meal summary, current estimate if based on accepted | Final layout stale; catering cutoff warning; draft follow-up |
| Meal changed | Table/event totals | Existing caterer packet stale |
| Guest target changed | Scenario and per-person estimates; capacity warning | Preview table/rental/transport changes; no booking modifications |
| Proposal selected | Decision snapshot, vendor stage considering | Offer review of commitment creation |
| Booking confirmed/amended | Commitment + allocations, vendor stage, required payment tasks | Provider notifications only after approval |
| Payment/refund recorded | Net paid, outstanding, schedule status | Dashboard/export revision, reminder cancellation where applicable |
| Event date changed | Event revision, calendar display | Relative task preview; no contract date changes |
| Layout edited | Capacity/assignment checks, meal totals | Mark finalized snapshot stale |
| Package generated | Snapshot at consistent revision | Render asynchronously; stale flag on subsequent relevant changes |

Outbox event envelope: id, wedding_id, type, entity_id, revision, occurred_at, correlation_id; minimal IDs, not raw personal details. Keep source rows and revision commit atomic. Jobs use retry/idempotency; no arbitrary AI subscribers. Public site explicit published snapshot; do not update private draft automatically. RSVP portal reads live eligible event data from narrow projection, not entire site draft. Mark relevant packages stale conservatively by workspace revision in R1.
