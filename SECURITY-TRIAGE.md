# Dependency triage

`npm audit` before this pass: **9 findings — 8 high, 1 moderate, 0 critical.**
After the fixes below: **5 high, 0 moderate**, all inside one optional package.
Nothing was force-upgraded and no major version moved.

Re-run the numbers yourself:

```bash
npm audit                       # the whole tree
npm audit --omit=optional       # what a Cloud-only install actually ships
```

## The table

“Reachable at runtime” means: can a message, a file or an admin action reach the
vulnerable code path in this repository, as it is used here — not “is the package
installed”.

| # | finding | sev | pulled in by | reachable at runtime? | smallest safe fix | done |
|---|---|---|---|---|---|---|
| 1 | `@xenova/transformers` | high | **direct** (optionalDependencies) | Only when `visualSearch` is on **and** the optional dep was installed; it is imported lazily in `src/services/visualSearch.js:120` with a Gemini fallback | npm's only "fix" is a semver-**major downgrade** to 1.4.2 — refused (no major changes). Left optional, ignored in Dependabot, and absent from `--omit=optional` | documented |
| 2 | `onnxruntime-web` | high | `@xenova/transformers` | same path as #1 | arrives with #1; no separate patch exists | — |
| 3 | `onnx-proto` | high | `@xenova/transformers` | same path as #1 | arrives with #1 | — |
| 4 | `protobufjs` (nested under `onnx-proto`) | high | `@xenova/transformers` | same path as #1 | arrives with #1 | — |
| 5 | `sharp` (nested under `@xenova/transformers`) | high | `@xenova/transformers` | same path as #1 | arrives with #1 | — |
| 6 | `protobufjs` (top level) | high | `@whiskeysockets/baileys`, `libsignal` | Yes, on the Baileys transport: every WhatsApp frame is protobuf | patch bump 7.6.4 → **7.6.6** | ✅ `npm audit fix` |
| 7 | `axios` | high | `@whiskeysockets/baileys` | Yes on Baileys (media/HTTP calls to WhatsApp's servers); **no** on Cloud-only | patch/minor 1.18.0 → **1.21.1** | ✅ `npm audit fix` |
| 8 | `follow-redirects` | high | `axios` → `baileys` | same as #7 | patch 1.16.0 → **1.16.3** | ✅ `npm audit fix` |
| 9 | `@xmldom/xmldom` | high | **`mammoth`** (direct dep, `.docx` reading) | Yes: a customer sends a `.docx` and `mammoth` parses it. This is the one finding reachable **without** Baileys | patch 0.8.13 → **0.8.15** | ✅ `npm audit fix` |
| 10 | `music-metadata` | moderate | `@whiskeysockets/baileys` | Yes on Baileys (voice-note metadata). The advisory is a DoS on a malformed MP4 header | minor 11.13.0 → **11.16.1** | ✅ `npm audit fix` |

(Items 2–5 are separate advisories but share one transitive chain, so they are
listed separately here and count as five of the remaining findings.)

`npm audit fix` (no `--force`) applied: `@xmldom/xmldom`, `axios`,
`follow-redirects`, `music-metadata`, `protobufjs`, `sharp` **0.35.2 → 0.35.5 +
libvips 1.3.4** (the sharp bump also clears the nested copy under `@xenova`).
Tests were run after the change: **961 pass, 0 fail**, eval **87/87**.

## What is left, and why it is defensible

Five high findings remain, all reached only through `@xenova/transformers` — an
**optional** dependency that is:

- not installed by `npm ci --omit=optional` (verified: 101 packages, none of
  `@xenova`, `onnxruntime-web`, `onnx-proto`, `sharp`),
- imported lazily, only when `visualSearch` is on, with a Gemini fallback when
  the model is missing,
- ignored in `.github/dependabot.yml` for **major** updates only, because its
  only published "fix" is a downgrade to 1.4.2.

If you want zero findings on the full install, the honest options are: (a) run
Cloud-only and omit optional deps, (b) drop local CLIP search and rely on Gemini
vision, or (c) wait for `@huggingface/transformers` to publish a fixed major and
take that upgrade deliberately. None of the three is a version pin away.

## Baileys and libsignal-node

- Declared by Baileys as `git+https://github.com/whiskeysockets/libsignal-node.git`
  (no ref in Baileys' own `package.json`), but the **lockfile pins the commit**:
  `git+ssh://git@github.com/whiskeysockets/libsignal-node.git#bcea72df9ec34d9d9140ab30619cf479c7c144c7`.
  So `npm ci` is reproducible — if that commit moved, nothing would change here.
- npm rewrites the `git+ssh` form to HTTPS for a public repository, which is why
  a clean CI run can fetch it without an SSH key.
- Licence: **GPL-3.0** (Baileys itself is MIT). See the README licence section —
  this is a licensing question, not a vulnerability one.
- Since this pass, Baileys is an **optional** dependency and is loaded lazily, so
  `TRANSPORT=cloud` never imports it; asking for it when it is missing produces
  one actionable sentence (`baileys_missing`).

## Verification commands

```bash
npm ci                                        # full install
npm test && npm run eval                       # 961 / 87
npm ci --omit=optional                        # Cloud-only
TRANSPORT=cloud npm test                       # 954 pass, 7 skipped, 0 fail
node -e "import('./src/transport/index.js').then(m=>m.createTransport({kind:'baileys'}))"  # baileys_missing
```
