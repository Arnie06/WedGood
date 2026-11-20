# Master prompt — independent architecture, security and correctness review

---

Review the current diff/branch for **[TICKET_OR_RANGE]** as an independent senior engineer. Read the specification, especially data model, domain rules, API, security, tests and release gates. Inspect actual changes, surrounding callers, migrations, permissions and tests. Do not assume the previous agent's claims are true. Default to review-only: do not edit files unless I ask.

Prioritize defects with concrete evidence: tenant isolation (RLS and storage, composite FK), role/scoped authorization, invite/share token abuse, overbroad DTO/export, XSS/CSRF/SSRF, secrets/client bundles, unsafe uploads, data loss, money rounding/double counting, booking transitions, RSVP event scope and plus-one replay, concurrent seating capacity, stale revisions and idempotency, external actions without confirmation, AI injection, unsupported statuses and fabricated provider success. Also check mobile reflow, keyboard/labels, error states, consistency with proposed stack and unnecessary complexity.

Run safe local tests if available; do not reset remote DB, send external messages, pay, deploy or use production secrets. Report tests actually run and missing coverage. Provide findings ordered by severity, each with file/line, scenario, impact and minimal fix. Distinguish confirmed defects from speculative risks. If no issues, state the reviewed scope and residual test gaps, not blanket approval. Suggest whether ticket is safe to merge; do not auto-merge. Keep review output free of secrets or personal data.
