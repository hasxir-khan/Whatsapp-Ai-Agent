# Part 3 follow-up: identifiers, freshness and fleet load

## Identity

The people, lead and activity rollups already used a tenant-keyed HMAC. The **usage producer did not**: previously its on-disk journal could contain a truncated, unkeyed SHA-256 of a chat key. Masking that value later in the platform did not protect the journal. The worker now keys the ID before writing to either the journal or the in-process recorder.

Define `ID(key, namespace, value)` as the first **8 bytes** of `HMAC-SHA256(key, UTF8(namespace + NUL + value))`. Render the 16 hex digits using `a…p` instead of `0…f`, prefixed with `id-`. The encoding is public; the protection comes from the key. A truncated ID is a pseudonym, not an authentication credential.

| Persisted field | Derivation |
|---|---|
| `r_people.who`, lead/activity `r_cards.contact` | `ID(tenantToken, "contact", numberBeforeAtSign)`. Provisioning generates `PLATFORM_TENANT_TOKEN` once from **24 random bytes per tenant**. See [producer](../src/services/tenantReports.js), [HMAC](../src/services/reportContract.js) and [provisioning](../platform/provisioning.js). |
| Worker journal and `usage_events.conversation` for a model call | `ID(K, "chat", legacyInput)`. `legacyInput` is the first 16 hex digits of SHA-256 of the **original chat key**, including its JID suffix. It exists only inside the computation on a new worker; it is **not** the ID it emits. A supplied legacy `conversation` label is also HMACed before emission. No usable worker meter key → record the call without a conversation ID; never fall back to a plain hash. |
| `r_meter.who` for monthly quota | `ID(K, "meter", conversationID)`. This deliberately uses a separate namespace from the customer-facing contact handle. |

**Why a separate meter key?** Existing Part 3 rows already used an HMAC with the 64-character random installation secret, a NUL and the tenant slug as its key. That is longer than SHA-256's 64-byte HMAC block, so HMAC first reduces it to `K = SHA256(UTF8(installSecret + NUL + slug))`. The launcher now delivers just these **32 tenant-specific bytes** (hex in `TENANT_METER_KEY`) to the live worker, not the installation secret. Moving the HMAC upstream this way preserves equality with an already-materialised month and old journals without recovering phone numbers. See [key derivation and upgrade](../platform/meterIdentity.js), [worker writer](../src/services/usageEvents.js) and [meter importer](../platform/reportStore.js).

**What was checked:** [the regression test](../test/77-dashboard-followup.test.js) independently computes the expected HMAC bytes, publishes the same number for two provisioned tenants, and reads the actual `r_people` and lead/activity `r_cards` fields. Within each tenant, both days and the JID/bare-number forms match; the two tenants' IDs differ. For metering it checks a previously materialised chat, an unkeyed legacy DB row, old and new journals, UID replay, direct/sink writes and a second tenant. Six distinct calls for the same chat still produce **one** metered contact. The saved upgraded fixture no longer contains the old digest. The [isolated worker test](../test/76-dashboard-upgrade.test.js) also inspects the actual journal written by the launched child: both model attempts have the expected keyed ID and the unrelated media observation has none.

This protects against someone testing candidate numbers **with the rollups/exports alone**. It does not anonymise a tenant's own records or protect against compromise of the relevant secret. The full platform DB contains both tenant tokens and the installation secret. Keep it, backups and worker environments private. Upgrade the platform **and restart the managed workers**. Existing journal batches are protected on import; previously copied journals and backups cannot be retroactively protected.

## Freshness

On every report request, **Updated N min ago** is the age of `r_state.at` (the worker's observation), rounded down to whole minutes. A snapshot **strictly older than 15 minutes** displays **Worker report overdue**, its age and a notice that these are cached figures. No retained snapshot displays **Updated: unknown** and an explicit no-report notice. This is evaluated on load/refresh; a delayed import is not proof that the worker has stopped.

The usage ledger has its own timestamp. An idle import updating `r_cursor.at` cannot make a stale worker look current. Fleet health uses the newest actual worker snapshot, gives each tenant row its own age/notice, and counts overdue and missing **active** workers separately. It does not use the request time as a worker timestamp.

The [HTTP regression](../test/77-dashboard-followup.test.js) visits **all eight customer HTML pages and the operator page**, with a recent, 18-minute-old, missing and then fresh report, while the meter cursor advances. A clock-boundary test checks exactly 15 minutes and one millisecond later. Doctor uses the same cutoff.

## 50 tenants × 90 days

Reproduce with `npm ci` and **`npm run benchmark:dashboard`**. The [harness](../scripts/benchmark-dashboard.mjs) uses a private temporary DB, removes it on exit, and prints JSON measurements without session credentials. The results below are from one run, not a production capacity guarantee.

- **Environment:** Linux x64, Node 22.22.3, sql.js 1.14.1, 2 available CPUs, 3,939.9 MiB reported RAM. Load driver, seeder and serving processes are separate.
- **Fixture:** 50 growth tenants, 50 distinct signed owner sessions, 90 UTC dates **for every tenant**. Per date/tenant: four participant rows, seven hourly facts (also rolled up daily), three cards and one model attempt. Real import/refresh produced 4,500 day rows, 18,000 people, 63,000 facts, 13,500 cards, 4,500 ledger entries, 9,000 usage buckets and 4,500 meter rows. Seeding, including checkpoint probes, took **9.94 s**. This seeds synthetic worker-format reports, not 50 live bot processes.
- **Request path:** external loopback HTTP driver → real session/membership check (or independent operator Basic auth) → SQL → server-rendered HTML → fully read and checked response. All customer requests select all 90 dates and must return their own slug and `90/90 dates published`. Fleet requests alternate the two 25-tenant pages. No provider, WAN, browser paint or TLS latency is included.
- **Cold:** a newly forked Node server and freshly opened persisted DB **per table row below**. First wave of eight simultaneous requests, no earlier HTTP warm-up. OS file cache **not** dropped. Latencies start after listen; process launch to ready was **286.3–322.1 ms**, of which DB open/init was **144.8–169.1 ms**.
- **Warm:** first prime all target sessions/URLs. Then run 50 serial requests and 100 at up to eight in flight per individual endpoint. The mixed workload exercises all **400** owner/section combinations: 400 prime, 400 serial, 400 at up to eight in flight. No think time. The same real DB save timer remains enabled; periodic tenant import is excluded from the read phases and one changed import is measured separately. Percentiles use nearest rank; cold p95 is the slowest of just eight requests.

| Page | Cold ×8 p95 (ms) | Warm ×1 p95 (ms) | Warm ×8 p50 (ms) | Warm ×8 p95 (ms) | Warm ×8 req/s |
|---|---:|---:|---:|---:|---:|
| Overview | 145.4 | 9.0 | 39.8 | 87.0 | 153.0 |
| Agents | 112.9 | 5.7 | 29.3 | 62.8 | 209.8 |
| Leads | 85.0 | 4.2 | 19.0 | 42.6 | 315.0 |
| Payments | 84.2 | 5.9 | 22.4 | 48.8 | 256.4 |
| Usage | 145.9 | 12.7 | 64.9 | 135.8 | 98.6 |
| Analytics | 126.3 | 6.7 | 32.1 | 70.2 | 192.8 |
| Health | 67.3 | 3.3 | 16.7 | 39.6 | 379.1 |
| Export & data page (not a download) | 62.9 | 3.7 | 14.9 | 30.0 | 430.0 |
| Fleet (operator) | 294.0 | 28.0 | 119.0 | 263.3 | 50.9 |
| Mixed customer pages | **106.3** | **9.8** | **30.3** | **65.7** | **215.7** |

**Memory.** DB file: **23.5 MiB**. Across the ten fresh serving processes, RSS after module load but before DB open was 73.8–78.3 MiB; at ready, 153.9–172.0 MiB. Immediately after warm reads it was 133.0–152.3 MiB. The mixed-read process used 148.3 MiB RSS versus just 16.9 MiB V8 heap used at that instant; heap alone misses the DB and native buffers. The largest kernel high-water RSS recorded through reads was **194.8 MiB**; after the write probe in that process it was **221.5 MiB**. The separate seeder peaked at 223.6 MiB. These are process measurements, not memory for the whole fleet.

**Where sql.js limited this run.** Queries, rendering and writes share one event loop. Raising mixed-read concurrency from one to eight moved throughput from **202.0 to 215.7 req/s**, but p95 from **9.8 to 65.7 ms**. This is whole-request latency, not a SQL-only profile. The storage-specific measurement is `flush()`: it exports/copies and writes the **whole** database synchronously. Median of five checkpoints at each seed size:

| Tenants | DB MiB | Full checkpoint (ms) |
|---:|---:|---:|
| 1 | 0.7 | 3.0 |
| 25 | 11.9 | 25.8 |
| 50 | 23.5 | 59.4 |

At 50 tenants, replacing one changed 90-date generation through `importReports()` took **213.5 ms**, including its transaction and synchronous file exports. A callback queued just before the import could not run for **213.6 ms**. An eight-request mixed burst dispatched alongside that import returned at **253.9 ms p95**. That is one observed write/burst, not a sustained write-load percentile. No Postgres instance or production traffic was benchmarked. See the [migration guidance](../README.md#when-to-move-the-platform-db-to-postgres).

## Verification

- `npm test` on its own: **1,286/1,286 passed**, no skips, 156.8 s. An earlier full run alongside other checks recorded one Node test-runner deserialisation error in the deployment test process; it did not recur on the full rerun.
- Offline `npm run eval`: **110/110** scenarios passed, no warnings or failures. The existing 390 × 844 Chromium dashboard smoke also passed all eight pages, staff navigation/direct denial and separate operator login.
