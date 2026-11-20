# Master prompt — handoff between Claude Code and Codex

---

Prepare a factual handoff for the next coding agent. Inspect git status/diff/branch, recent commits, docs and tests. Read `docs/16-IMPLEMENTATION-STATUS.md` and use its session template. Append a concise ledger entry: ticket and scope, changed files/symbols, decisions, migration order and status, exact commands and actual results, unfinished work, integration flags, known defects, next bounded ticket and any uncommitted changes. Record no secrets or real guest data. Do not modify application behavior, overwrite other work, commit/push or deploy unless explicitly authorized. Clearly separate completed verified work from proposed work. If there are conflicting edits, flag them rather than resolve silently.

For the receiving agent: inspect this ledger and actual repo; verify observed state and tests before continuing; do not re-scaffold or repeat completed work. Use a separate worktree if another agent is active, and obtain review before merging.
