# UX_AUDIT_SUMMARY.md

**Scope:** read-only UX + guest RSVP audit of the WedGood working tree (`main` @ `a8f8f41` + uncommitted REL-01…12), 2026-11-22.
**Inputs:** the 4-page executive brief and your prompt. The kit's detail files (`00_START_HERE.md`, `requirements.csv`, `acceptance_tests.csv`, output templates) were **not available**, so requirements are a derived set of 66 (UXR-01…66) and scoring uses the brief's five dimensions. Re-score against the kit's own 83 requirements when you supply it.

## Score

| Dimension | Points | Score |
|---|---|---|
| Navigation/context + planner/couple workflows | 24 | 11.0 |
| RSVP form builder + mobile guest portal | 30 | 12.4 |
| Canonical data mapping + reliability | 16 | 12.4 |
| Impact and exception UX | 16 | 10.0 |
| Security, privacy, accessibility + visual reuse | 14 | 11.3 |
| **Total** | **100** | **57 / 100** |

Status counts: Verified 31 · Partial 12 · Missing 19 · Unknown 2 · N/A 2. **Unknown: 3.0%** (throttle key behind the production proxy; manual assistive-technology and 200% zoom checks). Credit: Verified 1, Partial 0.5, Missing/Unknown 0; N/A excluded.

## The headline

The **backend already meets the brief's central principle**. A guest's answer writes the same canonical `invitation_members` row the planner edits, in one locked, version-checked transaction. Seating, meals and history update in that transaction, and headcounts, budget counts and issues are computed on read. Locked caterer counts, finalized seating versions, contracts, invoices and payments are never silently changed. 160 integration tests and 4 E2E tests on this path passed this session.

The gaps are mostly on the **experience** side:

1. **One link per event, not per party** (`events_rsvp.sql:56`). A household invited to three events manages three links. This is the largest guest-UX gap and the only P0/P1 item that needs a schema change.
2. **The guest form is fixed and flat.** There is no form builder, no conditional steps (the meal question shows for decliners), no review or confirmation summary, and no guest-entered dietary, accessibility, transport or children answers.
3. **The guest list shows no RSVP data.** Answers, meals and seats only appear on the invitations card stack, the Event page and in aggregate.
4. **Planner overrides have no impact preview.** Changing a seated guest's answer releases their seat with no warning. The `ImpactPreview` primitive exists but is used only for venue changes.
5. **Reply-by deadline uses UTC** for both end of day and display (`actions.ts:204-211`, `rsvp-form.tsx:115-120`). It is a small correctness issue, but it shows up in front of guests.

There are no S0 security or integrity findings. The one security item is hardening that depends on deployment: the throttle key comes from the first `X-Forwarded-For` value.

## Top risks (with evidence)

| # | Risk | Type | Evidence |
|---|---|---|---|
| R1 | Guests miss an event because each event has its own link | UX | `20261130090000_events_rsvp.sql:53-75`; trace §Structural finding |
| R2 | Planner override silently unseats a guest | UX/integrity of intent | `event-forms.tsx` OverrideForm; `needs_attention.sql:93-102` |
| R3 | Deadline closes at 23:59 UTC; date shown in UTC | Correctness | `src/server/events/actions.ts:204-211`; `rsvp-form.tsx:115-120` |
| R4 | Planner can't triage replies from the guest list | UX | `guest-filters.tsx:77-95` |
| R5 | Throttle key spoofable if proxy passes client XFF | Security (Unknown) | `src/server/rsvp/public.ts:51-56` |

## Staged decision recommendation

**Approve P0 (UX-01 to UX-05) as design-and-presentation work with no migrations.** It reuses existing RPCs, adds no new persistence, can roll back with a flag, and fixes R2–R4. Decide the two product questions below before P1 (party links + guest-entered details), which needs migrations and an independent review per `AGENTS.md`. Defer the Form Builder (UX-11) until the party link exists. A builder over one-event links would have to be reworked.

### Decisions needed from you

- **Q1. Party links:** should one link cover every event a household is invited to? (Recommended: yes. Existing per-event links keep working.)
- **Q2. Sensitive answers on a shared party link:** whoever opens a party link can see the whole party's answers. Should dietary and accessibility answers for other members be hidden after they are submitted? (Recommended: yes. Show "Saved" without the content.)
- **Q3. Seating on decline:** keep auto-release plus an issue (the current repo rule), or switch to "flag for review, keep the seat"? (Recommended: keep the current rule. It is tested, and the brief's outcome is met through the issue.)

## First five implementation tickets (not started; awaiting approval)

**UX-01 · Guest table with per-event replies**
- AC1: `/app/[w]/guests` has an Event selector. Each guest row shows Answer, Meal and Seat for that event, and "Not invited" when there is no active membership.
- AC2: The filters Waiting, Attending without meal and Attending not seated return exactly the guests counted by `event_demand` for the same event (integration test compares them).
- AC3: Only owner and partner (or holders of a guests grant) see answer columns. Other roles see the existing list unchanged (E2E with a viewer).
- AC4: The table reflows at 320px into cards, passes axe, and keeps 44px targets.

**UX-02 · Impact preview on planner answer changes**
- AC1: Choosing a new answer or meal in "Change an answer" shows, before saving, every effect that applies: seat released (table and seat), finalized plan out of date, caterer-count drift change, meal tally change.
- AC2: The preview comes from a read-only server query. Saving still uses `override_rsvp_response` unchanged.
- AC3: If replies changed between preview and save, the user sees the refreshed preview instead of a silent save. A test races a guest submit against the override.
- AC4: The preview is announced through the existing live region, and focus is not stolen.

**UX-03 · Guest RSVP stepper (single-event invitations)**
- AC1: Steps are Attendance → Meals (only for people marked attending, and only when the event has meal options) → Plus-one (only when places remain) → Review → Confirmation.
- AC2: The same server action and RPC are used, with exactly one RPC call per Send. A double click, a retry or the back button never creates a second plus-one (existing tests stay green, and a new E2E covers it).
- AC3: Returning before the deadline opens Review with the current answers. After the deadline, a read-only summary is shown.
- AC4: Each step heading takes focus. Skipped steps are announced. It passes axe at 320, 390 and 1280 px, and a manual VoiceOver pass is recorded in the ledger.

**UX-04 · Reply-by date in the event's time zone**
- AC1: A date picked as "1 May" closes the link at the end of 1 May in the event's effective zone (event zone, falling back to the wedding zone). Unit tests cover zones east and west of UTC and the DST edge.
- AC2: The guest page and the invitations page show the date in that zone, with the zone named when it differs from the guest's.
- AC3: Existing invitations are not rewritten. The ledger notes the behaviour change.

**UX-05 · Guest consequences panel**
- AC1: The guest detail page shows, for the latest change on each event, three lists: Updated automatically, Needs your review, and Not changed. They are built from `rsvp_changes`, `event_demand`, the catering guarantees and the seating revision.
- AC2: Nothing is stored and no write path is added.
- AC3: The panel shows no names or sensitive fields to roles without the matching capability (integration test per role).
- AC4: The late-cancellation scenario from the brief is an E2E test that asserts every line of the panel.

**Verification for all five:** `pnpm lint`, `typecheck`, `test:unit`, `test:integration`, `test:e2e`, `build`. Record the results in `docs/16-IMPLEMENTATION-STATUS.md`.

## Not verified

Anything listed under "Not run / not verified" in EVIDENCE_LOG.md. This audit did not update the shared status ledger, because the brief limits it to read-only work. Tell me if you want an entry added.
