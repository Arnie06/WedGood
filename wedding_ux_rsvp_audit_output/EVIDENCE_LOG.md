# EVIDENCE_LOG.md

All runs on the local synthetic stack (local Supabase on 127.0.0.1:54321, app on localhost; test users are generated `@example.test` accounts). No reset, no seed change, no external sends, no production access. No app source, migration, doc or config was modified.

| ID | Date | Kind | What | Result |
|---|---|---|---|---|
| E-01 | 2026-11-22 | Repo state | `git status --short` (149 modified/untracked, REL-01…REL-12 uncommitted), HEAD `a8f8f41` | Audited working tree as-is |
| E-02 | 2026-11-22 | Kit inputs | Searched repo and `~/Downloads` for `00_START_HERE.md`, `requirements.csv`, `acceptance_tests.csv`, `11_AUDIT_OUTPUT_TEMPLATES.md` | **Not found.** Only `Wedding_UX_RSVP_Executive_Brief.pdf` (4 pages) available. Requirement IDs UXR-01…66 are derived from the brief and prompt, not the kit's 83/60/20 |
| E-03 | 2026-11-22 | Baseline | Earlier dependency audit at `audit-output/*` (2026-11-21) | Used as canonical-relationship baseline |
| E-10 | 2026-11-22 | Code read | RSVP pages, server actions, projection, SQL `rsvp_view`/`rsvp_submit`/`apply_member_response`/`seating_on_member_change`, demand, guarantees, attention | Cited inline in trace and matrix |
| E-11 | 2026-11-22 | Code read | Planner pages: invitations, guests, guest detail, event hub, attention, home, nav | Cited in inventory |
| E-12 | 2026-11-22 | Code search | `grep -rliE` over `src` and `supabase/migrations` for transport/shuttle, rsvp_form/form_version/questions, allerg, check_in, consent/unsubscribe, realtime | No RSVP form builder, versions, transport, check-in, consent or realtime. `allerg` only in planner guest forms/import. `questions` only in guest website FAQ |
| E-13 | 2026-11-22 | Code search | feature flags | None found |
| E-20 | 2026-11-22 | Integration tests | `vitest --config vitest.integration.config.ts` on `rsvp`, `event-demand`, `attention`, `catering-guarantee`, `seating` | **160 passed, 0 failed** (35.9s). First attempt failed before any test ran because Docker was not on PATH; re-run with the OrbStack PATH from `docs/13-DEVOPS.md` |
| E-21 | 2026-11-22 | E2E (Chromium) | `playwright test tests/e2e/rsvp.spec.ts --project=chromium` | **4 passed**: owner→guest→counts→revoke; generic invalid-link message; viewers/outsiders blocked; axe + 320/1280 reflow |
| E-22 | 2026-11-22 | Screenshot | `test-results/screenshots/320/rsvp.png` inspected | Single-event single-page form; meal select visible per person regardless of answer; plus-one fieldset |
| E-23 | 2026-11-22 | Screenshot | `test-results/screenshots/320/invitations.png` inspected | Card stack per event; sticky header/bottom bar overlaying content in full-page capture (likely artifact, unverified) |
| E-24 | 2026-11-22 | Scoring | `score.py` over `TARGET_TO_ACTUAL_UX_MATRIX.csv` | 57.2/100; Unknown 2 of 66 (3.0%) |

## Not run / not verified

- Unit tests and the full integration/E2E suites (only the RSVP-path subset above).
- REL-03 budget-count integration tests (`budget-counts.test.ts`) not re-run; matrix UXR-48 relies on code + prior ledger evidence.
- WebKit/Firefox, 390/768/1440 widths, 200% zoom, manual keyboard and screen reader passes.
- Production proxy behaviour for the throttle key; host log handling of token URLs.
- Real email/SMS delivery (not configured, by design).

## Redaction

Reports contain no tokens, real names, contacts, dietary details or payments. Screenshot content is synthetic ("Ada Example", "Bo Example").
