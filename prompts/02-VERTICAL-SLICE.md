# Master prompt — implement one vertical slice

Replace the bracketed ticket and scope with your selection. Paste below from repo root.

---

Implement backlog ticket **[TICKET_ID]** in this wedding planning application. Additional scope: **[OPTIONAL_SCOPE_OR_NONE]**. Do not expand to later milestones unless explicitly instructed. Read `README.md`, `docs/14-BACKLOG.md`, `docs/16-IMPLEMENTATION-STATUS.md`, `docs/15-DECISIONS.md` and all relevant specs (especially `03-DESIGN`, `04-UX-FLOWS`, `06-DATA-MODEL`, `07-DOMAIN-RULES`, `08-API`, `10-SECURITY`, `12-TESTING`). Inspect current code, tests, migrations and working tree. Do not overwrite unrelated changes.

1. Identify prerequisites and acceptance criteria, current implementation and risks. State a concise plan. If prerequisite missing, do only safe work and record blocker; never fake a feature.
2. Implement the full bounded slice: migrations and database constraints if needed, typed domain rules, server authorization/validation and transactions, responsive UI with actionable loading/empty/error/conflict states. Use the shared design system. Reuse existing patterns. Manual fallback for provider-dependent flows. No client-only trust, no unsafe multi-request transaction, no external sends/spending or deployment.
3. Preserve connected wedding data and deterministic calculations. Unknown costs stay unknown. Confirmed commitments are never changed by estimates. Guest/seat/meal rules and recipient scope enforced. Use expected version and idempotency where required. Add source/evidence and audit history as specified.
4. Add focused unit tests, integration tests (real local database for authorization/concurrency) and E2E coverage for the user journey. Test denied actions and provider failure. Validate 320px and desktop layouts, keyboard interaction and accessible names. Do not mock away critical persistence or permissions.
5. Run actual lint/typecheck/relevant tests/build. Fix attributable failures. Review diff for secrets, cross-tenant leaks, unrelated edits and misleading demo states. If any test cannot run, record blocker, not pass.
6. Update status and decision ledger. Return scope delivered, changed paths, commands/results, known limitations, run instructions and next recommended ticket. No automatic push or production deployment.

Definition of done: acceptance criteria met with evidence; no hidden placeholder behavior; complete error and permission handling; responsive/accessibility check; documentation updated. Stop at selected ticket boundary.
