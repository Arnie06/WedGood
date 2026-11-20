# AI and external integrations

AI is R2, core planning works without it. Model and provider choices are configuration, not hard-coded claims about current versions. Integrations are optional, opt-in, least scope, tested against official API contracts when implemented. Manual fallback for each.

## Assistant principles

One context-aware assistant, not 11 bots. Capabilities: planning suggestions, venue/vendor discovery and comparison, quote/contract/receipt extraction, budget scenario, draft messages, seating preferences, design ideas, cultural considerations, logistics and packaging. Context is authorized wedding data only; never expose other weddings or private fields beyond actor grant. Keep data minimal; no guest PII or full contract sent to model if not needed. Clearly label AI estimates and unverifiable claims.

### Execution contract

1. Authorize actor and requested data scope. Retrieve typed minimal projection; distinguish trusted application data and untrusted uploaded/emails/web content.
2. Model produces strict structured output. Never treat document content as instructions; tool allowlist, bounded parameters, no arbitrary SQL, network, code execution or filesystem access.
3. Validate schema, referenced IDs, source evidence, amounts, constraints and permissions. Use deterministic calculations via read-only tools.
4. Save proposed changes with source revision, confidence, evidence and impact. Present review and edit screen, identify missing information.
5. User explicitly approves; recheck actor/permissions, expected revision, constraints and idempotency; execute via normal application services atomically. Audit approval/rejection and actual outcome. If stale, regenerate/review.

External actions (send email/SMS, book, sign, pay, publish, share private data) require explicit action-specific approval. AI cannot bypass policy even if asked. No autonomous commitments. Provider outage/timeouts must leave core functions usable.

### Structured proposal example

```json
{"kind":"extract_contract","sourceDocumentId":"uuid","sourceRevision":18,"fields":[{"field":"deposit_minor","value":360000,"currency":"USD","evidence":{"page":2,"quote":"Deposit of $3,600 due at signing"},"confidence":"high"}],"warnings":[{"code":"UNFOUND_OVERTIME","message":"Overtime terms not located; verify manually."}],"proposedActions":[{"kind":"create_payment_installment","commitmentId":"uuid","amountMinor":360000,"dueDate":null}],"requiresApproval":true}
```
Schema version, max action count, allowed enum, typed union and validation required. Confidence is not probability or guarantee. Quote snippets verified against source text when possible; page evidence retained. Unknown dates remain null. Contract review identifies terms/missing clauses, not legal advice. Never infer absent text or assume a contract is signed.

## Provider matrix

| Integration | Stage / suggested adapter | Fallback |
|---|---|---|
| Auth, DB, object storage | R0 Supabase | local Supabase development, no fake production auth |
| Places/maps | R1 optional licensed data, R4 marketplace | manual vendor/venue, URL and source |
| Email | R1 transactional (Resend/Postmark or equivalent) | copy invite link; dev mail sink labeled |
| PDF/CSV | R1 server-side libraries | on-demand download with explicit failure |
| AI/LLM | R2 OpenAI API structured outputs through adapter | manual entry and deterministic rules |
| Extraction | R2 PDF text parser; OCR only scans | review uploaded document/manual inputs |
| Email inbox | R3 OAuth Gmail/Outlook with narrow scopes | forward/upload selected message or paste |
| Calendar | R1 ICS export; R3 OAuth sync Google/Outlook | downloadable calendar; Apple import |
| SMS/WhatsApp | R3 provider with opt-in and compliance | email/copy link |
| E-signature | R4 approved provider | upload signed contract |
| Payments | R4 Stripe or equivalent, provider hosted | record payments manually |
| Registry | R1 external links, R4 approved integrations | manual links, no payment claims |
| Visualization | R3/R4 generative/design adapters | user-owned images and basic mood boards |

## Integration interface

Define provider-independent interfaces: CatalogProvider.search, MailProvider.send, FileScanner.scan, DocumentExtractor.extract, ModelProvider.generateStructured, CalendarProvider.sync, ExportRenderer.render. Return typed outcomes (`configured`, `unconfigured`, `rate_limited`, `failed`, `succeeded`) and provider ID/receipt only on real confirmation. Secrets server-only. Retry idempotently, exponential backoff, timeouts, circuit limits. Validate webhooks before parsing, audit delivery. No broad inbox scans by default. Token revoke/disconnect stops jobs and deletes credentials; communicate downstream records retention.

## Evaluation and cost controls

Synthetic golden PDFs (clear text, scan, contradictory terms, missing values, injected instructions), quotes with inclusive/unknown fees, malicious email content, cross-tenant request, stale proposal, provider timeout. Evaluate field accuracy, evidence correctness, hallucination rate, human correction rate, latency and cost on approved fixture corpus. Track token usage, quotas per wedding, budget limits, and user opt-out. Never log prompts containing real private data by default. Start with a limited pilot, no claim of perfect reliability.
