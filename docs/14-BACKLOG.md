# Engineering backlog

Order matters. Each ticket is a bounded vertical slice including migrations where needed, validated server actions/API, responsive UI, tests, documentation and ledger update. Acceptance criteria supplement the relevant domain/security requirements, not replace them. R0/R1 are the approved proposed baseline, not a commitment that all work is complete. No ticket is marked finished.

| ID | Scope / prerequisites | Acceptance criteria |
|---|---|---|
| R0-01 | Inspect repo; bootstrap Next/TS/pnpm; CI skeleton | Compatible locked deps; clean dev/build/typecheck/lint; document exact commands; no app-specific secrets |
| R0-02 | Design tokens, components, shell (R0-01) | Public landing + workspace shell; responsive 320–1440; keyboard navigation; synthetic/nonproduction fixtures labeled |
| R0-03 | Local DB/Auth, migrations, types (R0-01) | Auth session; create wedding atomically with owner; two-tenant RLS isolation tests; private storage defaults |
| R0-04 | Membership permissions + route guards (R0-03) | Invite partner securely; expiry/revoke; actor checks; no last-owner deletion; role tests |
| R0-05 | Testing and devops (R0-01–04) | Fresh DB reset, seed, test scripts, CI build/tests; env validation; no provider necessary for core |
| R1-01 | Onboarding + event settings (R0) | Nullable date/budget/guest target; defaults and edit; timezone; dashboard route; creation idempotency |
| R1-02 | Checklist and dashboard (R1-01) | Template no duplicates; manual tasks; next steps/unknown states; date-change preview no fixed deadline mutation |
| R1-03 | Candidates/discovery (R1-01) | Manual add/edit, source URL, category/capacity/price filters, save favorites, empty states; no fake live catalog |
| R1-04 | Vendor pipeline/proposals (R1-03) | Stages and transitions; proposal rows and manual evidence; links/notes; compare-ready normalized values |
| R1-05 | Comparison and decisions (R1-04) | 2–4 proposals same scenario; unknown fees, inclusive rows, fit warning, weights and coverage; decision snapshot |
| R1-06 | Budget model/summary (R1-01) | Allocations, cost modes, paid vs committed vs forecast, reserve, null budget target; unit tests T01–05 |
| R1-07 | Booking and payment ledger (R1-04,06) | Atomic commitment/allocation/installments; record/refund idempotently; no duplicate forecast; amendments and history |
| R1-08 | Private documents (R0-03,R1-04) | Upload intent, ownership, metadata, safe file validation/quarantine, links; release blocked for unscanned unsafe uploads |
| R1-09 | Guests/households/import (R1-01) | CSV mapping/preview, row error/dedupe, commit idempotent, guest privacy, mobile filter; CSV injection protections |
| R1-10 | Events/invitations/RSVP (R1-09) | Accountless capability flow, quota and event scope, replay and expired/revoked denial, meal options, live counts |
| R1-11 | Seating assignment + meal reports (R1-10) | Basic tables and accessible assignment, accepted/tentative, transactional capacity, concurrent T10, stale finalization |
| SEAT-1 | Seating details (R1-11) | Captains, table shape and notes, per-table RSVP/plus-one/dietary summary, guest and table trays, seat a household together; private notes never in exports |
| SEAT-2 | Floor-plan canvas (SEAT-1) | Positioned tables and venue elements, drag with touch/keyboard alternative, zoom, list-view fallback, schematic only |
| SEAT-3 | Numbered seats (SEAT-2) | Seat chips, atomic swap, seat numbers in tray and snapshot |
| SEAT-4 | Escort cards and table-list PDF (SEAT-1) | Names, tables, meals only; A4 and Letter; no private notes |
| SEAT-5 | Suggested seating (SEAT-1) | Deterministic proposal, households together, capacity, infeasible reported; apply refused if plan changed |
| R1-12 | Wedding agenda/day-of (R1-02,04,10) | Event timezone, ordered timeline, responsible party/vendor, no blanket overlap ban; coordinator view |
| R1-13 | Design board (R1-08) | Uploaded authorized assets or links, palette, editable board; no unsafe URL fetch; mobile gallery |
| R1-14 | Guest website (R1-10,13) | Template, draft/public preview, explicit publish/unpublish, sanitized projection, event-specific invite route, registry links |
| R1-15 | Sharing and comments (R0-04,R1-05) | Scoped collaborator view and comments; permissions enforced on data not only UI; audit changes |
| R1-16 | PDF/CSV package builder (R1-05–14) | Preset/custom sections, revision+preview digest, scoped renderer, fixed snapshot, safe download, stale flag, multi-page QA |
| R1-17 | Invitations/delivery fallback and ICS (R1-10,12) | Copy link without provider; transactional send only configured/approved; ledger status truthful; calendar export |
| REL-01 | Event demand (R1-10, R1-11; ADR-031) | One derived headcount per event (yes, waiting, no, plus-ones not named, seated, meal totals, planning number per D3) used by every page; owner/partner by default, owner-only "Let collaborators see guest totals" setting exposes totals only; counts equal seating totals; cross-wedding refused |
| REL-02 | Event page and events list (REL-01) | `/plan/events/[eventId]` hub summarizing who, where, meals, seating, vendors, agenda with links to editors; event switcher; event edit tray moves here; no disabled cards for unbuilt parts; 320–1280 and keyboard |
| REL-03 | Budget items count from replies (REL-01) | Per-item count source (event planning number, event yes, guest target, typed); existing items backfilled to guest target with identical forecast; source label and arithmetic per row, hidden from members without totals access; booked items unchanged with drift note |
| REL-04 | Live count in quotes and comparisons (REL-01) | Compare setup defaults to an event's planning number with override; saved comparisons never change; "reprice" creates a copy |
| REL-05 | Reply and seating history (REL-01) | Append-only reply changes (none on no-op retry); finalized seating versions kept; history views for owner/partner |
| REL-06 | Venue spaces and event location (REL-02) | Spaces under a venue; one location per event; venue then space picker, stale choice shown; capacity fit against planning number; impact preview on change |
| REL-07 | Vendors assigned to events (REL-02; ADR-031 D4) | Vendor-event links that survive amendments; booking "works at" chips; agenda vendor picker groups this event's vendors first; day-of lists per event |
| REL-08 | Caterer count (REL-01, REL-07) | Explicit lock with preview, revision with reason keeps history, drift note on event/seating/budget, reminder task, caterer package includes it; guest cancel after lock leaves it unchanged |
| REL-09 | Invoices (R1-07) | Contract, invoiced, paid, still to pay; payment links to an invoice of the same booking; invoices move with amendments; forecast changes leave them unchanged |
| REL-10 | Needs attention (REL-01, 06, 08) | Computed conditions plus stored one-off items, deduplicated; Home and Event page lists; dismiss/handled; role-aware |
| REL-11 | Planner/editor scoped grants (R0-04; ADR-031 D7) | Owner grants per area; database helpers enforce grants; role-by-area integration matrix; last-owner rules unchanged |
| REL-12 | Per-event time zone (optional, REL-02) | Event zone defaults to the wedding's; agenda and Event page use it |
| R1-18 | PWA/responsive/accessibility polish (R1-01–17) | Manifest, layout reflow, keyboard/axe, screenshot checks, no private service-worker cache, all core mobile workflows |
| R1-19 | Release qualification (all R1) | Golden path and negative access tests, restore, security review, documentation/feature flags, explicit release decision |
| R2-01 | AI adapter and controlled approvals | Structured typed actions, source revision, rejection, AI-off regression |
| R2-02 | Document extraction/review | Evidence page quotes, manual edit and approve, ambiguity, injection evaluation |
| R2-03 | Scenario and impact engine | Saved guest/budget scenarios; no actual commitments changed; explain forecast |
| R2-04 | Decision boards + smart compare | Votes scoped, weights explainable, quote normalization with evidence |
| R2-05 | Auto-seating + dependencies | Hard/soft constraints, infeasibility, preview and override; task graph acyclic |
| R2-06 | Contextual assistant and message drafts | Authorized minimal context, review and approved changes, no autonomous external actions |
| R3-01 | Scaled floor plan editor | Calibrate source, furniture geometry, touch+keyboard fallback, versions, printable layout |
| R3-02 | Vendor portal | Per-vendor grants, own timeline and scoped packets; check-in/acknowledge; no other vendor access |
| R3-03 | Transport/lodging/beauty/photo logistics | Capacity, schedule conflicts, per-person assignments and reports |
| R3-04 | Command center/offline | Coordinator controls, delayed status/issues, revisioned offline packet and clear stale status |
| R3-05 | Email/calendar integrations | Opt-in narrow scopes, revoke, retries, manual fallback |
| R3-06 | Multilingual site, photos, guestbook | Locale-aware forms, moderated/scoped uploads, guest privacy and accessibility |
| R4-01 | Licensed marketplace | Provenance, data rights, real availability confirmation, moderation, ranking independence |
| R4-02 | Professional multi-workspace | Tenant membership boundaries, reusable templates, branded packets |
| R4-03 | Monetization/registry/payment | Owner-approved terms/pricing, provider checkout, webhook and refund tests |
| R4-04 | Visualization/post-wedding | Concept labels, consent, return/refund/archive; validate demand before build |

## Definition of done for each ticket

- User flow and error/empty/loading states work; data persists and mutations validate; no placeholder success.
- Add unit + integration or E2E coverage appropriate to impact. Negative auth tests for data routes. Responsive behavior and accessible inputs.
- Run relevant lint/typecheck/tests/build; log actual results and blockers. Review migrations for safe upgrade; do not modify previously applied migration silently.
- Record scope, assumptions, changed paths, actual dependencies and follow-up in status/decisions. No unrelated refactors, secrets or production side effects.

## Suggested agent allocation

Use either agent for implementation. The other reviews independent diff against rules and runs tests. Alternate sequentially, using distinct worktrees if parallel. Avoid independently generating competing schemas or rewriting architecture. First task is R0-01 with bootstrap prompt; do not start a second slice until relevant foundation is reviewed.
