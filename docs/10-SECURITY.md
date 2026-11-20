# Security, privacy and access control

Threat model: tenant crossover/IDOR, guessed public links, invite replay, overbroad collaborator permissions, exports leaking PII, malicious files, XSS/CSRF/SSRF, prompt injection, webhook spoofing, abuse, accidental data loss. Protect couples, guests and vendors, including information about family conflicts, allergies, addresses, accessibility, contracts and payments.

## Role matrix (default, deny unless explicitly granted)

| Capability | Owner | Partner | Planner/editor | Family/viewer | Scoped vendor | Guest |
|---|---|---|---|---|---|---|
| Manage ownership/delete workspace | yes | no | no | no | no | no |
| Wedding settings | yes | yes, except ownership | granted | no | no | no |
| Guest records | yes | yes | granted | no by default | narrow authorized projection | own eligible invite |
| Sensitive guest fields | yes | yes | only explicit grant | no | only minimum necessary (e.g. meal allergies) | own response inputs |
| Budget/contract | yes | yes | explicit grant | no | own authorized packet/document only | no |
| Plan/vendor/seating edit | yes | yes | explicit grant | no | own acknowledgments R3 | no |
| Design/decision view | yes | yes | granted | granted | granted projection | no |
| Create exports | yes | yes | only readable sections + export grant | no | no | no |
| Publish/invite/send external | yes | granted | explicit grant | no | no | no |
| Member administration | yes | explicit non-owner grants | no | no | no | no |

Owner transfer requires authenticated recent confirmation and must never leave no owner. Partner is trusted by default; explicitly expose grant set to owner before invite. Roles map to capabilities, not UI visibility. Scope checks on every server operation; database RLS policies on every tenant table and storage object. Deny direct access to restricted private fields even through joins or broad SELECT; split sensitive guest table or restricted server projections. RLS policy helpers avoid recursion and use fixed search_path and restricted grants for SECURITY DEFINER RPCs. Privileged service roles only in reviewed server functions, no catch-all bypass. Public endpoints use narrow RPCs that validate tokens and return allowlisted results rather than direct anonymous table access.

## Auth, tokens and web security

Use managed auth with secure HttpOnly/SameSite cookies and TLS as supported; rotate sessions, validate redirects; never log tokens. CSRF/origin checks for cookie writes. Random high-entropy (>=128-bit) opaque invitation/share tokens stored only hashed; expire, revoke, scope by event/household or package; no enumeration. Redeem token from URL into scoped session where practical and remove from path; no third-party analytics/scripts on token routes; noindex and Referrer-Policy no-referrer. Rate limit redemption, responses, invitations, uploads, exports, AI. Public website intentionally allowlisted, explicit publish; private site access via separate password/token with proper verification, not CSS hiding. Protect from clickjacking, XSS, unsafe HTML/URLs with CSP/sanitization; no user-supplied script. Server URL fetch only allowlisted/safe redirects and SSRF protections; R1 store URL only, don't fetch arbitrary links automatically.

## Storage and exports

Private buckets by default. Upload intent authorized, MIME and file signature validation, max sizes, randomized keys, checksums; quarantine until validated and scanned by configured malware scanner. If scanner absent, document deferral explicitly: allow only safe locally generated/demo files in dev or block untrusted production downloads; do not claim scanned. Treat PDF/office files untrusted; no executing macros; safe preview or sandbox. Signed downloads short TTL after permission check; enforce storage policy independently. No original file name as path. Public website images stored separately only after user approves publication and rights. Strip metadata when appropriate. Export preview and final renderer use same allowlist. Sensitive guest data only with explicit need-to-know grant; no relationship/conflict notes in standard exports. Avoid CSV formula injection (prefix risky text cells; keep trusted numeric fields numeric). Shared snapshots immutable, grants revoke future access, already downloaded copies cannot be recalled.

## Privacy, consent, retention

Minimize collected guest data. Explain what is shared with hosts and vendors, optional sensitive fields, consent where appropriate. Do not send invitations or marketing without host approval and required recipient compliance; unsubscribe/manage communication preferences for nonessential messaging. Privacy notice, terms, deletion/export process and provider DPA/regulatory review required before launch; jurisdiction-specific obligations require legal review. No claim of regulatory compliance solely from these specs.

Proposed policy subject to legal/business approval: retain active workspace while user needs it; owner can archive/export/delete; deletion revokes tokens and removes private files/records through queued erasure with documented backup expiry; operational logs 30 days by default without PII; idempotency logs 7 days where reasonable; delivery audit minimal; backups retention configured and disclosed. Legal hold/financial retention exceptions documented. Don't collect card PAN/CVV. Integrations OAuth encrypted at rest, narrow scopes, disconnect/revoke, no tokens in client. AI opt-in for processing sensitive docs, provider data retention reviewed.

## Verification requirements

Automated RLS and endpoint tests: user A cannot read/write wedding B even with UUID; role changes immediately restrict access; vendor cannot see unrelated guests/contracts; guest token cannot change uninvited person/event, reuse revoked token or exceed quota; no export escalation by adding section IDs; concurrent seating cannot overfill; signed URL access expires. Test website draft privacy, unpublish, cache invalidation. Scan dependencies/secrets, review CSP and headers, restore test, redacted error logging, incident runbook. Block release on critical/high unresolved security defects.
