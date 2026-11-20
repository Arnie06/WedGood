# Master prompt — verification and release readiness

---

Evaluate release readiness for **[R0/R1/R2/R3/R4]** against `docs/02-ROADMAP.md`, `10-SECURITY.md`, `12-TESTING.md`, `13-DEVOPS.md`, `14-BACKLOG.md` and the status ledger. Review actual code and environment setup. Run safe local/staging (synthetic data only) lint, typecheck, unit, integration, E2E and build commands as available. Verify migrations in isolated database, fresh setup, negative authorization tests, core golden path, mobile breakpoints, accessible controls, screenshot/print checks, provider unconfigured behavior, secrets/dependency scans and backup/restore process. For R2+ test approvals/injection; R3 offline and vendor isolation.

Do not deploy, push, reset remote data, send messages, or perform paid/external operations. Do not label skipped tests pass. If a failure attributable to the requested scope has a small safe fix, implement only if authorized; otherwise report it. Record results in status ledger: table of commands, pass/fail/not run, evidence, defects, severity, feature flags, rollback/restore notes, unresolved blockers. Give GO or NO-GO recommendation with reasons. Production release requires human approval, configured legal/privacy/provider policies, and no unresolved critical/high security issues.
