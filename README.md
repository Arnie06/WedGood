# Wedding Planning Platform — project starter

**Status:** Specification plus an R0-01 foundation scaffold (Next.js, TypeScript, pnpm). No product features yet; see [implementation status](docs/16-IMPLEMENTATION-STATUS.md).  
**Local development:** Node 26 + pnpm 12.21.0: `cp .env.example .env.local && pnpm install && pnpm dev`. Exact verified commands are in [DevOps](docs/13-DEVOPS.md).  
**Working product name:** Wedding Workspace (placeholder).  
**Product promise:** Plan beautifully. Celebrate fully.

One responsive, collaborative workspace to discover, compare, plan, track, share and package a wedding. Designed for couples first, with professional-grade outputs and a path to a wider vendor and planner ecosystem.

## Start here

1. Start from the repository root. Codex reads [AGENTS.md](AGENTS.md); [CLAUDE.md](CLAUDE.md) imports those shared rules for Claude Code. Read [Product requirements](docs/01-PRODUCT.md), [Scope and roadmap](docs/02-ROADMAP.md), and [Design system](docs/03-DESIGN.md).
2. Review [Architecture](docs/05-ARCHITECTURE.md), [Data model](docs/06-DATA-MODEL.md), [Domain rules](docs/07-DOMAIN-RULES.md), and [Security](docs/10-SECURITY.md) before implementing persistence.
3. Copy the contents of [Bootstrap prompt](prompts/01-BOOTSTRAP.md) into Claude Code or Codex from the repository root. It directs the agent to read these documents, inspect the repository, and implement only the initial foundation.
4. Use [Build a vertical slice](prompts/02-VERTICAL-SLICE.md) with a selected ticket in [Backlog](docs/14-BACKLOG.md). Use the review and handoff prompts between sessions or agents.
5. Keep [Decisions](docs/15-DECISIONS.md) and [Implementation status](docs/16-IMPLEMENTATION-STATUS.md) updated as work proceeds.

## Documentation map

| File | Purpose |
|---|---|
| [01-PRODUCT](docs/01-PRODUCT.md) | Product requirements, users, outcomes, module requirements |
| [02-ROADMAP](docs/02-ROADMAP.md) | Scope boundaries, release gates, priorities |
| [03-DESIGN](docs/03-DESIGN.md) | Visual identity, component rules, mobile and accessibility |
| [04-UX-FLOWS](docs/04-UX-FLOWS.md) | Routes, navigation, screen specifications and end-to-end journeys |
| [05-ARCHITECTURE](docs/05-ARCHITECTURE.md) | Stack, boundaries, directory layout, infrastructure |
| [06-DATA-MODEL](docs/06-DATA-MODEL.md) | Relational schema, constraints, ownership and indexes |
| [07-DOMAIN-RULES](docs/07-DOMAIN-RULES.md) | Deterministic budget, RSVP, seating, comparison and dependency rules |
| [08-API](docs/08-API.md) | HTTP contracts, schemas, error and concurrency conventions |
| [09-AI-AND-INTEGRATIONS](docs/09-AI-AND-INTEGRATIONS.md) | AI, provider adapters, consent and integration fallbacks |
| [10-SECURITY](docs/10-SECURITY.md) | Access control, privacy, security and retention |
| [11-EXPORTS-AND-OPERATIONS](docs/11-EXPORTS-AND-OPERATIONS.md) | Wedding packages, reporting, wedding-day and offline requirements |
| [12-TESTING](docs/12-TESTING.md) | Test plan, fixtures, release acceptance criteria |
| [13-DEVOPS](docs/13-DEVOPS.md) | Setup, environments, deployment, operations |
| [14-BACKLOG](docs/14-BACKLOG.md) | Ordered engineering tickets with acceptance criteria |
| [15-DECISIONS](docs/15-DECISIONS.md) | Proposed architecture decisions and open questions |
| [16-IMPLEMENTATION-STATUS](docs/16-IMPLEMENTATION-STATUS.md) | Shared progress ledger for coding agents |
| [17-COMPETITIVE-REFERENCE](docs/17-COMPETITIVE-REFERENCE.md) | Competitor-inspired capabilities and differentiation hypotheses |
| [18-UX-COPY-AND-DEMO](docs/18-UX-COPY-AND-DEMO.md) | Voice, onboarding copy and coherent synthetic demo scenario |
| [19-DISCOVERY-AND-COMMERCE](docs/19-DISCOVERY-AND-COMMERCE.md) | Marketplace strategy, provenance, monetization and operational limits |

## Master prompts

| Prompt | Use |
|---|---|
| [01 Bootstrap](prompts/01-BOOTSTRAP.md) | Start the project from an empty or existing repository |
| [02 Vertical slice](prompts/02-VERTICAL-SLICE.md) | Implement one backlog ticket or bounded feature |
| [03 UI polish](prompts/03-UI-POLISH.md) | Improve responsive design, accessibility and usability |
| [04 Architecture and security review](prompts/04-REVIEW.md) | Independent review of changes before merge |
| [05 Test and release](prompts/05-TEST-RELEASE.md) | Run quality gates and prepare a release |
| [06 Handoff](prompts/06-HANDOFF.md) | Switch between Claude Code and Codex safely |
| [07 Feature expansion](prompts/07-EXPANSION.md) | Plan and implement an approved post-MVP feature |
| [08 UX prototype](prompts/08-UX-PROTOTYPE.md) | Build a clearly marked, local synthetic design prototype |

## Working conventions

- `MUST` is a requirement; `SHOULD` is a preferred default; `MAY` is optional. R0 = foundation; R1 = core MVP; R2 = intelligence; R3 = operations; R4 = ecosystem.
- Product scope and release gates: 01/02. Visual and behavior rules: 03/04. Data invariants: 06/07. Security rules: 10. In a conflict, never weaken security, privacy or correctness to satisfy a UI or roadmap request; record the conflict and resolve it before shipping.
- `AGENTS.md` contains shared coding instructions; `CLAUDE.md` imports it and adds Claude-specific guidance. Read relevant specs on demand, not all documents for every task. Prompts are portable task briefs, not automatically loaded instructions.
- Treat the repository and the status ledger as shared truth; do not run two agents against the same working tree simultaneously. Use branches/worktrees and review their diffs.
- No package versions, provider accounts, real vendor catalog, legal terms or production deployment are represented as already configured. The selected stack is a proposed baseline; check official docs and lock compatible versions when bootstrapping.
- Examples and demo data are fictional. External integrations must remain off or clearly labeled as demo/unconfigured until credentials, permissions and live tests exist.
