# Phase 7, Part 3 — customer dashboard

Built on the Part 2 tenant lifecycle, sessions, entitlements, journal importer and customer app. The eight report pages are opt-in. Payment decisions still happen in WhatsApp. **No billing, new package dependencies or workflow changes.** All evidence below uses synthetic tenants and synthetic activity.

[What customers see](customer-dashboard.md) · [Dashboard metrics and deployment settings](../README.md#dashboard-metrics)

## Where the numbers live

| Measurement | Definition and source |
|---|---|
| Conversations / owner / automation | Reduce by participant across the **entire** date range. An inbound chat with no owner turn is counted as automated; this is not proof that a bot answered. `impactRelation` and `impactTotals` feed the command and report. |
| First response / after-hours | First assistant reply after a contact’s first inbound; only waits under 24 hours enter the mean. After-hours measures first replies outside configured opening hours. Missing pairs or unknown hours are not a measured zero. |
| Attributed bookings, orders and revenue | Records created in range, attributed where there was no owner turn. Paid value includes paid/delivered/completed orders. Attribution and time saved are estimates, not causal impact or settlement. |
| Growth, goals and change | `.growth`’s sent count and daily cap, current opt-outs; active `goalProgress` values; trailing seven local dates compared with the preceding seven. An incomplete baseline has no percentage change. |
| Agents, activity and analyst | Distinct routed contacts, handoffs/escalations, order/booking resolutions, observed first-reply latency and provider failures. Activity groups repeats by local hour, type, agent, masked contact and outcome. Weekly archive contains the numerical facts saved at send time, not generated prose. |
| Pipeline / collected brief | Current stage of leads created in range, score, first-touch attribution, tags, next-action code/reason and assignee. Unknown free-form labels are aliased or omitted. Only the separately authenticated tenant inbox can return collected field values. |
| Payments / decisions | `paymentsSummary`: current pending/escalated, overdue, recheck, outstanding balances, accepted/partial or rejected today, mean resolution time over 30 dates. The register uses request creation date; transitions use event date. Per-order history omits proof, actor number, free text and payment references. |
| Usage and quotas | Attempts, input/output/total tokens, estimated calls and errors by day/month, provider/model, key generation, calling agent and kind. Monthly allowance counts distinct metered chats, **not** inbound conversations. The existing worker daily budget counts successful LLM calls and resets at UTC midnight. STT duration is in minutes, not tokens. |
| Funnel and acquisition | Distinct inbound contacts → leads → quote events → non-cancelled orders → paid/delivered orders → rated reviews. Independent stages, not a cohort: rates may exceed 100%; zero denominator = unavailable. Source also shows paid value. |
| Quality and gaps | `.accuracy` guard detections, including price (red above zero), wrong language, cuts and blocked duplicates. Topic counts for questions and retrieval misses, repeated objection categories, experiment samples and review queues; never transcripts. Uninstrumented owner edits are labelled as such. |
| Health / operator | Last recorded link, active key state, incidents, last message, worker-lifetime decrypt/delivery counters. Fleet view adds plan/status, last activity, quota, key errors, incidents, trial end, active-tenant and provider totals; no contact identifiers. |
| Data quality | Business-date ranges use independent IANA-zone boundaries. Fewer than 20 conversations triggers a thin-data warning. Publication coverage, raw-event history coverage and worker/ledger freshness are separate. No invented prices: BYOK estimation uses an optional owner-entered rate only in the browser. |

The [complete per-metric table](../README.md#dashboard-metrics) is generated from the same definitions as each **?** link. Check for drift with `node scripts/dashboard-definitions.js --check`.

## Storage, roles and recovery

- The worker publishes an atomic versioned batch after startup and every five minutes. The single platform writer reconciles every minute. Daily/hourly facts, distinct-participant projections, masked cards, the current snapshot, usage rollups and high-water marks are separate from core platform schema v2. A page never triggers a tenant DB read or an import.
- Each changed date is replaced transactionally. Import timestamps/digests and tenant-scoped call UIDs handle replay. Late calls advance by insertion ID but count on their original business date. A timezone change rebuilds the local buckets. Free/starter/growth permit 31/60/90 dates; range checks apply before the periodic physical purge. A pre-install raw-event gap is a lower bound, not an observed absence.
- Owner: eight pages, collected-brief grant and audited CSV/JSON downloads. Staff: read-only, no tenant report export, payments page or brief grant. Existing personal account portability is separate. Operator: separate route and credential, optional; neither an owner cookie nor a tenant bearer token authorises fleet access.
- The upgrade blinds old business and trial numbers, removes redundant wizard values/filenames, moves undo values to the tenant’s private backup directory and compacts legacy pages. A missing volume with a needed undo patch blocks the migration rather than destroying the patch. Ordinary account deletion clears report rows through the existing cleanup. A tenant contact forget removes its brief lookup immediately; masked projections are reconciled on publication. Unlinked aggregate counters can remain until expiry.

## Verification

| Check | Result |
|---|---|
| `npm test` | **1,282 passed**, 0 failed/skipped, 167.9 s. The 1,266 existing tests were not edited. |
| `npm run eval` | **110/110**, no warnings or failures; 212 recorded model turns, 22.557 s, no network. |
| Same seeded data, actual WhatsApp handlers | `.impact`, `.accuracy`, `.growth` and `.payments` compared with their dashboard counterparts. Across the seeded seven dates: two inbound conversations, one without an owner turn, attributed paid value 50, two-minute first response; one proactive send, one price guard detection, pending balance 15, mean decision time five minutes. |
| Worker and ingest | An isolated child received the supervisor’s live-worker environment and ran its actual reporting timer, with a stubbed provider and no WhatsApp transport. One rejected key and one successful fallback consumed **one** worker budget unit. An additional media observation produced **three** reported attempts, 21 tokens, one estimate, one error, one metered chat. Also exercised first backfill, `.importing` replay, late delivery, stale/unknown-version refusal, runtime zone change, 23/25-hour dates and downgrade purge. |
| Privacy and access | HTML and JSON checked per section for owner, staff, unrelated account, anonymous session and wrong tenant; separate export/brief/operator gates tested. Scanned seeded text/phone/key/proof markers in report responses, journals, downloads and persisted fixtures. Upgraded an old-format SQLite file (including a multi-page draft) and exercised a migrated undo; checked DB bytes after save/reopen. |
| Doctor and phone | `node scripts/doctor.js platform` on a disposable DB: rejects reused operator secret, warns about a stale active worker and leaves file bytes unchanged. Offline **390 × 844 Chromium**: all eight pages, navigation, filters, glossary links, pagination, downloads, read-only order history, cost calculator, staff denials and operator login. A separate synthetic inbox origin showed a sign-in challenge, then the actual collected brief after tenant authentication. |
| Secret scanning | Staged content and tracked tree clean. **`npm run scan` exits 1** because history includes three existing findings at `6d6116f`: the `config/owner.json` path and two key-shaped test strings in `test/11-gemini.test.js` (lines 56–57). Same as Part 2; no exemption, history rewrite or credential value in this report. |

### Measured page budget

`test/75-dashboard-performance.test.js` inserted **50,000 observations over 90 business dates** (messages, agent activity, leads, payment requests and model usage). Seed, materialisation, import and count verification took **8.824 s** in the final full-suite run. It then renamed the raw platform call table so a raw-table page query would fail. Each request included loopback HTTP, session or operator authentication, SQL and server-rendered HTML. Customer selections covered all 90 dates. One warm-up, seven timed requests per page; nearest-rank p95 is the slowest of those seven.

| Page | Measured warm p95 | Enforced budget |
|---|---:|---:|
| Overview | 34.5 ms | <350 ms |
| Agents & activity | 16.7 ms | <350 ms |
| Leads | 11.2 ms | <350 ms |
| Payments & decisions | 6.5 ms | <350 ms |
| Usage | 13.9 ms | <350 ms |
| Analytics | 14.6 ms | <350 ms |
| Health | 6.7 ms | <350 ms |
| Export & data | 4.5 ms | <350 ms |
| Operator | 2.4 ms | <350 ms |

The data-page number is for opening the page, **not** transferring a whole export. Reproduce with `node --test test/75-dashboard-performance.test.js`. Run phone acceptance with `CHROMIUM_BIN` and `PLAYWRIGHT_MODULE` pointing to a local Chromium executable and Playwright Core module, then `node test/browser/dashboard.mjs`.

## Changed files

Paths in each row share the indicated directory. No generated database, browser binary, fixture keys, probe harness or workflow is part of the delivery.

| Area | Files |
|---|---|
| Platform read/write models | `platform/{dashboard,reportContext,reportMetrics,reportRoutes,reportSchema,reportStore,reportView,usage}.js` |
| Existing control plane and migration | `platform/{accounts,connect,db,diagnostics,draftMetadata,env,index,keys,numberIdentity,onboarding,plans,provisioning,routes,schema,settings,views,wizard}.js` |
| Browser | `platform/public/{app.js,reports.css,reports.js}` |
| Shared tenant metrics and worker publisher | `src/services/{accuracy,analystAgent,growth,growthDashboard,impact,impactMetrics,leads,paymentReview,reportArchive,reportCalendar,reportContract,tenantReports}.js` |
| Worker integration, tenant data and metering | `src/{boot,server}.js`, `src/core/llm.js`, `src/handlers/ownerCommands.js`, `src/utils/db.js`, `src/services/{adminPanel,embeddings,mediaUsage,privacy,reportBrief,transcription,tts,usageEvents,vision}.js` |
| Tests | `test/{74-dashboard,75-dashboard-performance,76-dashboard-upgrade}.test.js`, `test/fixtures/dashboard.js`, `test/browser/dashboard.mjs` |
| Documentation | `.env.example`, `README.md`, `scripts/dashboard-definitions.js`, `docs/{customer-dashboard,phase-7-part-3}.md` |

## What still needs live traffic

The test run is not a production latency SLA, a provider invoice or evidence of real WhatsApp delivery. On a pilot, monitor worker snapshot time and event-loop lag during conversations, importer delay under concurrent tenants, durable volume mounts, RSS/disk growth, large export throughput and restart/reconnect behavior. Verify HTTPS origins, separate inbox authentication and backups on the deployment. Reconcile voice duration, provider token metadata, attribution and source coverage against the operator’s own traffic. Data deleted before installation cannot be recovered; estimates and thin samples should not drive financial decisions.
