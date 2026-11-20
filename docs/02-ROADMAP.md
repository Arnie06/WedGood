# Scope, priorities and release gates

The entire vision is not the first release. Each milestone is a coherent, testable increment; no dates or staffing estimates are assumed.

## R0 — Foundation

MUST: inspect existing repo, confirm compatible dependencies; strict TypeScript; app shell; tokenized design system; auth and tenant isolation; migrations; demo fixtures; responsive navigation; CI and test harness. One authenticated persisted wedding creation flow and negative cross-tenant tests. No external provider keys required to run local core flows.

## R1 — Connected core MVP

| Slice | Deliverable | Gate |
|---|---|---|
| R1a | Onboarding, dashboard, tasks | Reload persists plan; owner/partner role enforced |
| R1b | Manual discovery, vendor records, shortlist, comparisons | Unknown cost is not zero; comparison to selected vendor transition |
| R1c | Budget and commitments, documents | Payment and refund math deterministic; no duplicate commitment from proposal |
| R1d | Guests, event invitations, CSV import, public RSVP | Individual + household responses; plus-one policy; event scoping |
| R1e | Seating, meal reports, basic timeline | RSVP impacts queue; capacity constraints; mobile non-drag alternative |
| R1f | Guest website, collaboration, design boards, exports | Explicit publish; sanitized scoped PDFs/CSV; access and revocation verified |
| R1g | Reliability and launch polish | E2E walkthrough, mobile visual review, restore and security checks |

R1 discovery means user-entered and saved candidates with truthful source labels; licensed live catalog can follow or be wired when available. Basic guest website supports invite links and external registry links rather than commerce. Basic seating supports assignment to capacity-limited tables and visual display; full calibrated editor is R3. Core export is PDF/CSV snapshot; live links and multi-format bundling can follow. Basic drafts and simple invite/reminder delivery only via configured provider or dev sink; no fake delivery.

## R2 — Intelligent planning

- Structured quote/contract/receipt extraction with source references and approval; vendor comparison enhancements.
- Saved budget scenarios and change impact previews; draft emails; contextual assistant.
- Decision polls, task dependencies, constraint-based auto-seating; itinerary and calendar enhancements.
- No autonomous sending, signing, booking, payment or modification of confirmed agreements.

Gate: AI-off regression pass, extraction evaluation, injection tests, reviewed changes applied atomically, cost limits and provider failures handled.

## R3 — Wedding operations

Scaled floor plan editor, layout versions, ceremony plans, coordinator handoff, vendor portals, per-vendor call sheets, transportation, accommodations, hair/makeup schedules, shot lists, décor inventory, contingency plans, offline wedding-day mode, localized guest site and multilingual RSVPs, digital guestbook/photos. Add opt-in email/calendar integrations with narrow scopes.

Gate: scoped vendor authorization, accessible seating fallback, offline stale-state behavior, simulated delayed timeline and incident handling, per-recipient package test.

## R4 — Ecosystem

Licensed/verified marketplace growth, vendor business tools, planner multi-wedding accounts, branded portals, custom domains, registry and payment integrations, advanced visualization and post-wedding archive. Explore stationery, honeymoon, resale and sustainability tools as validated demand permits.

Gate: provider contracts/licensing, moderation, consent, billing and refund policy, privacy and cost review; no misleading availability, verified reviews or ranking claims.

## Explicit deferrals

No full marketplace crawl, native apps, complex microservices, unreviewed autonomous agent, direct payments, card storage, e-signing, 3D/AR, or paid subscriptions in R0/R1. Do not build fake implementations to satisfy a roadmap checkbox.

## Prioritization and decision rules

Correctness/security > connected core workflows > usability/accessibility > breadth > speculative automation. A later feature can move earlier only with a recorded decision and a demonstrable benefit. Requirements marked R2+ must not silently creep into baseline tickets.
