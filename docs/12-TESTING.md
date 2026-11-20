# Quality strategy and release acceptance

Test behavior, not implementation details. Use synthetic fixtures only. No production secrets in CI. Report actual executed commands and results; if dependencies/provider unavailable report blocker and do not mark passed.

## Layers

Unit (Vitest): pure money arithmetic, normalization, scoring, RSVP and seating eligibility, date offsets, export sanitization. Integration: real local Postgres/Supabase RLS, transactions/locking, data migrations, API services, token expiry/replay, storage grants, outbox and import idempotency. E2E (Playwright): browser workflows with seeded separate weddings/roles; mobile 320/390, tablet 768, desktop 1280/1440, chromium plus WebKit/Firefox smoke. Accessibility: axe automated plus manual keyboard/screen-reader checks and reduced motion. Visual: screenshots at representative breakpoints; manually inspect overflow, hierarchy, dialogs and PDFs. Provider contract tests mocked plus explicit sandbox live smoke when approved.

## Deterministic test cases

| ID | Input / action | Expected |
|---|---|---|
| T01 | $95×120 + $30×120 + $20k fixed, 10% reserve | $38,500 forecast; $41,250 at 140 |
| T02 | 100 guests, minimum catering 120 | $34,400 known subtotal before reserve |
| T03 | $10k selected quote only | no commitment until book confirmed |
| T04 | Book $10k, pay $2.5k, refund $500 | commitment $10k, net paid $2k, owed $8k, forecast no double count |
| T05 | Unknown mandatory charge + known $8k | incomplete total, known subtotal $8k, no zero substitution |
| T06 | Score zero weights or no criteria | no ranking, validation/empty state |
| T07 | Vendor capacity 120, target 150 | hard incompatibility; doesn't silently recommend as fit |
| T08 | Invite 2 named people, quota 1; repeat request | only one approved plus-one created; counts correct |
| T09 | Guest accepts reception, declines rehearsal | event-specific counts, no cross-event changes |
| T10 | Two transactions compete for last seat | at most one succeeds, capacity preserved |
| T11 | Decline confirmed seated guest | unassigned/removed, meal count reduced, finalized snapshot stale |
| T12 | Change meal choice | table and event meal summary update once |
| T13 | Change wedding date | preview relative tasks; contract installment fixed |
| T14 | Retry same idempotency key, different body | 409; no duplicate record |
| T15 | User A reads/writes wedding B via API/DB | denied; no data revealed |
| T16 | Guest token requests uninvited member/event | denied; no foreign fields |
| T17 | Caterer export manually adds budget/conflict notes | denied/redacted per preview; no leak |
| T18 | Export at revision N, edit plan N+1 | immutable old content, stale indicator |
| T19 | CSV guests row begins =,+,-,@ or leading whitespace | no execution as spreadsheet formula in exported text |
| T20 | Provider unconfigured/fails | actionable fallback; no fake success or lost core data |
| T21 | Owner unpublishes website | public view gone, no private cache content |
| T22 | R2 document contains malicious prompt | no unrestricted tool call, evidence checked, review required |
| T23 | Revoke scoped share/invite | future redemption/access denied |
| T24 | Offline packet R3 stale/reconnect | stale label, read-only/controlled replay, logout clears cache |

## E2E golden path

Create wedding and partner, add two venue candidates and proposals, compare true known totals, record booking/deposit, import guest households, issue invite link in configured dev sink or copy flow, submit RSVP on mobile without account, see count/meal, assign seat via keyboard-friendly UI, change response/meal, create timeline, preview/download recipient-specific PDF, verify stale snapshot behavior. Repeat as authorized collaborator, denied foreign workspace, expired public link. No mocked DB for critical persistence/access tests.

## Release gates

- Fresh clone setup and migrations work; no hidden manually altered DB. Seed safe and deterministic. Typecheck, lint, unit, integration, relevant E2E all pass, or release blocked with explicit rationale.
- Core journey R1 works desktop/mobile, 320px reflow, no essential hover/drag-only action, focus/readable contrast. Actual screenshot review and print preview. No invented benchmark.
- Negative authorization tests, secrets/dependency scan, safe storage and export checks, backup restore documented. No critical/high security bugs.
- Provider functionality accurately labeled; manual fallback verified; no credentials on client. Accessibility AA target with known gaps documented; do not claim certification.
- Performance baseline measured; proposed p75 LCP/INP/CLS targets tracked with real traffic when available; test slow network, loading/error states.
- Update status ledger: commands, pass/fail/not run, migrations, feature flags, open defects and release decision. Do not deploy production automatically without explicit approval.
