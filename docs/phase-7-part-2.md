# Phase 7, Part 2 — delivery report

[PR #4](https://github.com/hasxir-khan/Whatsapp-Ai-Agent/pull/4) · [Deployment and recovery checklist](../README.md#deployment-and-recovery-checklist)

A tenant can now bring its own AI keys, link WhatsApp **without enabling replies**, test its assistant, and explicitly go live. The nine [Step 0 fixes](../README.md#hardening-from-the-step-0-review) remain in place. Part 3 is not included.

| Acceptance area | What was verified |
| --- | --- |
| Key source and fallback | Tenant credentials only; the future platform pool refuses explicitly. Rejected or rate-limited primaries fall back to a backup. Two customers during a chain outage received holding replies; the owner received one alert. |
| Encrypted BYOK | Up to three slots per provider for Groq, Gemini and OpenRouter. Randomized AES-256-GCM envelopes bind the tenant, key ID and rotation version. Ordinary reads, exports and audit records contain no key value. A running worker was replaced with a different PID on rotation, and its replacement was stopped on last-key revocation. Late usage from an older generation cannot set the health of a replacement with the same last four characters. |
| Model choice | Model selection is allowlisted. The compatibility check needs consent and uses at most eight calls across price, language, scope and confirmation. FAIL needs an explicit override. Provider failure is not a verdict and does not erase an earlier result. |
| Onboarding | The wizard resumes from its saved step. Readiness uses profile, key, link and sandbox evidence; typing a success flag into a draft does not satisfy it. The link-only worker cannot reply. Go-live, owner pause/resume, trial expiry and account deletion were exercised. A populated v1 DB kept its tenant and usage on upgrade; legacy active tenants returned to setup. |
| Behaviour settings | Plan-gated changes use the tenant profile/env writers and bot validators. Tests cover conditional intake, timing, voice mode, team and agents, private backups, rollback on write failure, and undo without overwriting unrelated edits. |
| Deployment security | Configured HTTPS issues `Secure`, `__Host-` session and CSRF cookies; the session is `HttpOnly`. Production refuses plain HTTP without `PLATFORM_ALLOW_HTTP=1`. Pinned proxy peers use only their designated XFF or Cloudflare header; unlisted peers cannot change their client-IP bucket. The HTTPS mail adapter does not silently fall back to the file outbox. Doctor warns about the HTTP override, production outbox and enabled dev-code setting (ignored in production). |

## Verification

| Check | Result |
| --- | --- |
| `npm test` | **1,266 passed**, 0 failed, 0 skipped. No private owner profile or live service credentials needed. |
| `npm run eval` | **110/110 passed**, 0 warnings, 0 failures; 212 recorded model turns, offline. |
| Chromium | Passed signup and password login, field validation, wizard resume, checklist fix action, rotate/revoke, FAIL override, settings save/undo, team/timing editors, linking, sandbox reply, go-live/pause/resume and discarding a delayed reply after switching assistants. |
| Staged content and tracked tree | `node scripts/scan-secrets.js --all --staged` clean. |
| `npm run scan` (includes history) | **Exit 1.** The scanner reports an owner-profile path (`config/owner.json`) and two key-shaped test values (`test/11-gemini.test.js`) at pre-existing commit `6d6116f`. These are not in the Part 2 changes. No scanner exemption was added. |

**Before production:** check whether any historical credential needs revocation. Verify the real ingress and TLS, email delivery with SPF/DKIM and bounce handling, provider/model access with a tenant key, and phone QR/pairing on staging. Browser and integration tests used simulated external connections; they are not evidence of real inbox delivery or a live WhatsApp session. The [known risks](../README.md#known-risks) include inline CSP allowances, the limits of DB encryption on a compromised host, and dependence on the email provider.
