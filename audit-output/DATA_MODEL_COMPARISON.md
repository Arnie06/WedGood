# DATA_MODEL_COMPARISON.md

Target entities are taken from the PDF (§1 relational foundation, §2 invariants, §3 pickers) and the audit request's entity list (the kit's `02_ENTITY_AND_RELATIONSHIP_SPEC.md` was not available). `mig/` = `supabase/migrations/`. Classification: **Record** (real persisted table) · **Computed** (projection from other rows) · **JSON** (blob in a column) · **Hard-coded** · **Missing** · **Unknown**.

## 1. Target → actual mapping

| Target entity | Actual | Class | Constraints / cardinality (evidence) | Difference from target |
|---|---|---|---|---|
| Wedding | `weddings` (`core_tenancy.sql:53`) | Record | `revision`, `version`; `target_budget_minor`, `target_guest_count` stored on the row | Matches. Targets are manual scalars |
| Workspace (planner firm) | — | **Missing** | “Workspace” in routes = one wedding (`/app/[w]`) | No organization that spans weddings (`docs/01-PRODUCT.md:45` defers) |
| Wedding Access | `memberships` (`:73`), `permissions jsonb` | Record + JSON | `unique(wedding_id,user_id)`; roles owner/partner/editor/viewer; partner grant `manage_members` in JSON | Per-user-per-wedding only; no org grants; editor has no write capability (`permissions/index.ts:50`) |
| Event | `events` (`events_rsvp.sql:18`) | Record | `unique(wedding_id,id)`, name unique per wedding, version; `local_date date`, `target_attendance`, `capacity` | No time zone, no start/end instant (agenda is separate); kind is a CHECK enum |
| Event segments | `timeline_items` (`timeline.sql:14`) | Record | FK to event, `timezone` per item, `starts_at timestamptz` | Good match |
| Event Location | — | **Missing** | No `event_id`/`venue_id` on candidates, venues, commitments or proposals | Events cannot reference a venue/space; timeline `location` is free text (`timeline.sql:25`) |
| Venue | `candidates` (kind='venue') + `venues` (`candidates.sql:14,62`) | Record | composite FK pins `kind='venue'` and tenant | A venue is a *shortlisted candidate*, not a reusable directory venue |
| Space | — | **Missing** | `venues.seated_capacity`, `ceremony_capacity` only | No Venue → Spaces |
| Wedding Guest | `guests` (`guests.sql:85`) + `guest_private_details` (`:109`) | Record | tenant composite FK; email/name not unique (by design) | Matches; private details in separate table (good) |
| Household / Invitation Party | `households` (`:57`); `invitations` (`events_rsvp.sql:53`) | Record | invitation is **per event** (`FK wedding_id,event_id`), optional `household_id`, unique `token_hash` | Target has one party → many event invitations. Here a household invited to 3 events = 3 invitations/tokens/links |
| Event Invitation / Event Guest-RSVP | `invitation_members` (`:81`) | Record | `unique(invitation_id,guest_id)`; **partial unique `(event_id,guest_id) where active`** (`:106`); status check; meal FK `(wedding_id,event_id,meal_option_id)` | One table is both the invitee link and the response (no separate Event Guest with history). Current state only |
| RSVP history | `audit_events.safe_changes` counts | JSON | counts only (`:781-784`) | No per-response before/after |
| Plus-one entitlement | `invitations.plus_one_quota`, `plus_ones_used` | Record (denormalized counter) | `quota 0..5`; counter maintained under advisory lock (`:695,:768`) | Counter, not derived; not a per-guest entitlement row |
| Plus-one claim | `guests` row tagged `'plus-one'` + `invitation_members.is_plus_one` | Record | created in `rsvp_submit` (`:762-767`) | Matches (named claim becomes a Guest) |
| Meal option | `meal_options` (`:36`) | Record | per event, unique active name, version | No Meal Service/menu/course/dietary mapping |
| Meal selection | `invitation_members.meal_option_id` | Record | `check (meal_option_id is null or rsvp_status='accepted')` (`:98`) | Matches |
| Dietary/accessibility | `guest_private_details` text | Record (free text) | `num_nonnulls>=1` | Not structured (no tags that map to menus) |
| Catering Guarantee | — | **Missing** | grep `guarantee`: none | Entire entity and lock absent |
| Seating Plan | `seating_layouts` (`seating.sql:21`) | Record | **`unique(event_id)`**; `revision`, `finalized_revision`, `snapshot jsonb`, check `(finalized_revision is null)=(snapshot is null)` | One layout/event, not many versioned plans; latest snapshot overwritten on re-finalize (`:555-558`) |
| Seating Table | `seating_tables` (`:43`) | Record | capacity 1..50; label unique per layout | Matches |
| Seat / Assignment | `seat_assignments` (`:59`) | Record | `unique(layout_id,guest_id)`; `unique(table_id,seat_number)` partial (`:73`); FK to guests | Seat identity is a number on the assignment, not a seat record; capacity enforced in RPC |
| Floor plan | `seating_elements` (`seating_floor_plan.sql:21`) | Record | — | Beyond target |
| Vendor Directory | `candidates` (kind='vendor') (`candidates.sql:14`) | Record | `stage`, category CHECK enum (hard-coded) | Per-wedding candidates, not a shared directory |
| Quote / proposal | `proposals`, `proposal_lines` (`vendor_pipeline_proposals.sql:20,58`) | Record | line cost modes fixed/per_guest/quantity | Good |
| Wedding Booking / Contract | `commitments` (`ledger.sql:18`) | Record | **`unique(candidate_id) where status='active'`** (`:37`); supersede chain `supersedes_id`; status check | Booking exists; **no Event Assignment table** |
| Booking → Event assignment | — | **Missing** | — | Cannot express which events a vendor serves |
| Budget | `budget_categories`, `budget_items`, `budget_settings` (`budget.sql:16,34,61`) | Record | items cost_mode fixed/per_guest/quantity; null=unknown | Good |
| Price Driver | `cost_mode` + literal `quantity`/`min_qty` | Hard-coded in item | `budget.sql:36,43-44` | No named driver entity |
| Scenario | `comparisons` + `comparison_options` (`comparisons_decisions.sql:102,123`) | Record | comparison has its own `guestCount`; decisions append-only guard (`:173`) | Quote-comparison scenario only; whole-budget scenarios are R2 |
| Allocation | `commitment_allocations` (`ledger.sql:45`) | Record | `unique active per budget_item` (`:54-56`) | Matches (no double counting) |
| Installments | `payment_installments` (`:61`) | Record | due_on, amount | Plan only |
| Payment | `payments` (`:73`) | Record | exactly one parent (`check`), void with reason, `unique(wedding_id,external_ref)` | Matches |
| Invoice | — (document kind only) | **Missing** as a record | `documents.kind='invoice'` in `validate.ts` | No amount-due/status/due-date entity |
| Transport / Lodging / Room block | — | **Missing** | none | R3 roadmap |
| Tasks | `tasks` (`tasks.sql:11`) | Record | — | OK |
| Files | `documents`, `document_links`, private bucket (`documents.sql:17,48`) | Record | storage key derived from ids; link to booking/payment/vendor | OK |
| Audit history | `audit_events` (`core_tenancy.sql:91`) | Record | append-only trigger; field names/counts only | No UI; not a change-data log |
| Snapshots | `packages`, `package_artifacts` (`packages.sql:25,51`); `wedding_sites.published` | Record + JSON | immutable triggers (`:70-76`) | Good |
| Idempotency | `idempotency_keys` (`core_tenancy.sql:121`) | Record | PK (scope, op, key) | Good |

## 2. True records vs. JSON/text

JSON blobs that carry data other modules might later need to query: `seating_layouts.snapshot` (frozen copy; correct as a snapshot), `packages.snapshot`, `wedding_sites.draft/published`, `weddings.preferences`, `memberships.permissions`, `audit_events.safe_changes`. None carries live relational state (that would be a defect). Free-text that *should* become structured: `guest_private_details.dietary/accessibility`, `timeline_items.location`, `candidates.location`.

## 3. Relationship and cardinality differences that matter

1. **Household/party → event** is 1:N invitations (one token per event) vs. target 1 party : N event invitations.
2. **Booking ↔ Event** is absent; **Event ↔ Venue/Space** is absent; therefore the picker rules “Venue → valid Spaces” and “Booking → Events from same wedding” cannot exist.
3. **Headcount** exists as three unlinked scalars plus the true count in `invitation_members`.
4. **Seating plans:** exactly one mutable layout per event with a revision counter, not versioned plans.
5. **RSVP state vs history:** one row, mutated; history only as audit counts.

## 4. Proposed relational changes (only where required)

All forward-only migrations with composite `(wedding_id, …)` FKs and RLS/RPC-only writes, following existing patterns.

| Change | Minimal shape | Needed for |
|---|---|---|
| `event_demand(p_wedding, p_event)` SQL function/view | counts from `invitation_members` + `invitations.plus_one_quota - plus_ones_used` as `potential` | headcount, budget, guarantee, packages |
| `venue_spaces(candidate_id, name, seated_capacity, ceremony_capacity)` | child of `venues` | spaces, capacity checks |
| `event_locations(event_id, candidate_id, space_id null)` | FK to event, venue candidate, space | venue change cascade, pickers |
| `event_assignments(commitment_id, event_id, role)` | FK to commitment and event | vendor per event, day-of |
| `catering_guarantees(commitment_id, event_id, guaranteed_count, status, locked_at, revision)` + audit | one open row per commitment/event | guarantee lock/warning |
| `invoices(commitment_id, amount_minor, due_on, status)` linked from payments | optional `payments.invoice_id` | contract/invoice/paid separation |
| `pricing_drivers(name, kind, event_id, source)` and `budget_items.driver_id` | driver kind `event_accepted|manual` | per-person costs from RSVP |
| `seating_snapshots(layout_id, revision, snapshot, finalized_at, finalized_by)` | move snapshot out of the layout | real snapshot history |
| `organizations`, `organization_memberships`, `wedding_grants` | org → many weddings | planner workspace |
| `membership_grants(membership_id, capability, scope)` | scope = module/event | editor/planner write access |
| `review_items(wedding_id, source, entity, status)` | written by the same RPCs that audit | review issue/notification |

Do **not** restructure `weddings`, `memberships`, `invitation_members` or the RPC write pattern; they match the target's intent.
