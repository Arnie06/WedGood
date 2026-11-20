@AGENTS.md

# Claude Code — project workflow

The imported `AGENTS.md` is the shared source of truth for this wedding planning project. Do not duplicate its rules here; Codex uses the same file.

- Use plan mode or an explicit plan for substantial cross-module work, migrations, auth/RLS, financial rules, public sharing and architectural changes. For a small well-defined fix, implement directly after inspection. Keep scope bounded by the requested ticket.
- Use targeted exploration (search, read and focused read-only subagents when available) before coding. Do not load every specification or dispatch multiple writers against the same files. Read the relevant documents listed in `AGENTS.md`.
- Use available browser tooling for UI changes, including mobile layouts and keyboard interactions. Inspect actual results and fix problems. If tooling or services are unavailable, identify what remains unverified; never simulate a successful integration.
- After context compaction or resuming a session, re-read `docs/16-IMPLEMENTATION-STATUS.md`, relevant decisions, current Git diff and the active ticket before continuing. Treat personal auto memory as optional context, not shared project truth.
- Before handing off to Codex, record changes, test evidence, unresolved issues and the next ticket in the shared ledger. Do not launch another agent in the same working tree or apply its findings without checking the current diff and scope.
- Keep persistent project instructions concise. Put lasting engineering rules in `AGENTS.md`, implementation specifics in the appropriate `docs/` file and observed progress in the shared status ledger. Do not automatically rewrite these instruction files without user direction.

For initial repository setup, use `prompts/01-BOOTSTRAP.md`. For a requested independent review, use `prompts/04-REVIEW.md` and remain read-only unless fixes are requested.
