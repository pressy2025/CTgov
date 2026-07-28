# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in this repository.

## Project Overview

Three browser-only playgrounds for public life-sciences APIs (ClinicalTrials.gov v2,
openFDA, SEC EDGAR), used for Syngage lead research. Fork of
`hozefa-syngage/clinicalgovapi`. Active branch: `newctgov_test`.

## Architecture — zero build, one file per page

Each page is a **single self-contained HTML file**: one inline `<style>` block, one inline
`<script>` block, no modules, no framework, no `package.json`, no tests. The only external
dependency is Chart.js 4.4.1 from jsDelivr.

**Do not introduce a bundler, framework, or build step.** `render.yaml` publishes the repo
root directly (`env: static`, empty `buildCommand`), and the pages are expected to run when
opened straight from disk. Adding a build breaks both properties. If a build genuinely
becomes necessary, `render.yaml` must be updated in the same change.

There is real duplication between the two playgrounds (`syntaxHighlight`, `renderBarChart`,
`downloadFile`, `escapeHtml`, `renderEndpoint`, and the whole explorer shell). **This is
accepted, not an oversight** — deduplicating it requires modules and therefore a build step,
which costs more than the duplication does at this size.

## The `ENDPOINTS` registry is the extension point

Both playgrounds declare `const ENDPOINTS = {…}` (see
`clinicaltrials-api-playground.html:1050`). Each key holds `method`, `path`, `summary`,
`desc`, `useCase`, `presets[]`, and `params[]`. `renderEndpoint(key)`
(`clinicaltrials-api-playground.html:1205`) generates the entire UI from that object.

Adding an endpoint, a parameter, or a preset is a **data-only change** to `ENDPOINTS`. Do
not hand-write UI markup for a new endpoint. Sidebar entries live in the static
`.endpoint-item` list in the HTML body and must be added alongside the registry key.

Presets support an optional `group` field; `renderEndpoint` buckets chips by it.

## Treat the manual query-string building as deliberate

`buildUrl()` (`clinicaltrials-api-playground.html:1294`, especially the encoding at
`:1304-1317`) and `lfBuildUrl()` (`:2330`) assemble query strings by hand and then
selectively **un-escape** `%3A` → `:`, `%2C` → `,`, `%7C` → `|`, `%20` → `+`, rather than
using `URLSearchParams`. The in-code comment explains why: ClinicalTrials.gov was rejecting
percent-encoded `:` and `,` in `filter.*` / `aggFilters` values with
`Invalid format of aggregation-filter name:value pair`.

Verified against API v2.0.5 (2026-07-24): **both forms currently return 200** —
`aggFilters=phase%3A1` and `aggFilters=phase:1` both work, as do encoded and literal
`filter.advanced` brackets. So the original constraint appears to have been fixed upstream,
or was narrower than the comment suggests.

Do not refactor this to `URLSearchParams` just because the encoding now looks redundant.
The current code is known-good against the live API, the failure it guards against was real
at the time, and the payoff is nil. If you do change it, re-run the filtered presets against
the live API first — a regression here is silent (wrong results, not an error). The same
logic is duplicated in `openfda-edgar-playground.html:829`.

## Lead Finder (CT.gov playground only)

All Lead Finder code is prefixed `lf*` and lives at
`clinicaltrials-api-playground.html:2118-2634`. Flow:

1. `lfExtract(text)` (`:2172`) — regex-matches a pasted positioning document against the
   `LF_MODALITIES`, `LF_THERAPEUTIC_AREAS`, `LF_PHASES`, and `LF_SPONSOR_CLASSES`
   taxonomies, plus company size, geography, and target roles.
2. `lfBuildQueries(attrs)` (`:2233`) — picks whichever of modalities/therapeutic areas has
   **more** matches as the "anchor" dimension and emits one query per anchor (capped at 5).
   The opposite dimension is applied as a shared filter **only when it has exactly one
   item**, to avoid over-narrowing. A detected "Commercial" phase reserves one extra slot
   for a dedicated Phase 3 + `ACTIVE_NOT_RECRUITING` query (enrollment complete ≈ 6–12
   months from readout — the commercial-manufacturing decision window).
3. `lfExecuteAll(queries)` (`:2341`) — fans out with `Promise.all`.
4. `lfInferSignal(study)` (`:2357`) — classifies each trial into an outreach signal from
   status, phase, and post/update dates.

**Tuning lead quality means editing the `LF_*` taxonomies and the anchor logic**, not the
rendering functions. `PHASE_META` (`:2147`) is the shared phase reference used by the
attribute cards, results tables, and pipeline cards — update it in one place.

`LF_EXAMPLES` holds the built-in BIOVECTRA and Thermo Fisher positioning documents wired to
the example buttons.

## Registry verification (openFDA) — `lfReg*` / `lfFda*`

An optional, user-triggered pass that corrects `sizeTier` from public FDA record instead of
trial footprint. Added because `lfSizeTierFromTrials` is a footprint proxy whose own comment
admits it misses "Daiichi Sankyo at 2 trials, BioNTech at 16 countries". Measured on a
BIOVECTRA run: **8 of the top 20 tiers corrected**, which for a CDMO seller drops AbbVie,
GSK, Bayer and Takeda from 86 to 74 and lifts genuinely clinical-stage sponsors above them.

**It adds no scoring dimension.** The six dimensions still sum to 100 and `LF_ARCHETYPE_FIT` is
untouched — FDA data only improves two *inputs*: `sizeTier` (read by Buyer fit) and
`sponsor.signals` (read by `lfTopSignal`).

### The rule that governs everything

> A zero may only be shown, scored, or sent to the model when `resolution === "absent"`.

`unresolved` means "we could not look it up" and must stay inert and visually distinct (hatched
amber, never a number). Conflating the two tells a CDMO seller that Janssen is an emerging
biotech — worse than not verifying at all, because the model then has a number to cite.
`absent` is unreachable unless a guard-approved probe actually ran.

### Four things that will bite you

1. **openFDA `sponsor_name` phrase matching is exact on the full field value.**
   `sponsor_name:"IONIS"` returns 0 — openFDA spells it `IONIS PHARMS INC`. The **wildcard is
   the primary probe**, not a fallback. Quote encoding is irrelevant.
2. **Never emit an unquoted multi-token value.** `sponsor_name:JANSSEN BIOTECH` silently returns
   `VERO BIOTECH INC` — a wrong answer with no error. Every probe is a quoted phrase or a single
   token + `*`; `lfRegVariants` enforces it and the harness property-tests it.
3. **A shared first token is not a shared company.** `HANGZHOU*` matched `HANGZHOU BINJIANG`,
   an unrelated firm in the same city. `LF_REG_GENERIC_ROOTS` blocks place names and industry
   words, and `lfRegAccept` additionally requires a second shared token when the first is generic.
4. **HTTP 404 is an empty result, not an error** — the exact opposite of ClinicalTrials.gov,
   where 403 is fatal and non-retryable. Do not generalise one registry's rules to the other.

### Demotion is deliberately narrower than promotion

Promotion on FDA evidence is safe. Demotion is not: BioNTech has a genuine Drugs@FDA zero
(Comirnaty is filed by Pfizer) and demoting it to `emerging` *raised* its score 84 → 89 for a
CDMO seller — an FDA zero would have promoted a multi-billion-dollar company as an emerging
lead. So `lfSizeTier` only demotes `mid → emerging` when `trialCount < 5`, i.e. when the `mid`
came from the late-phase rule alone (the Mirati/Immunovant "one global Phase 3" case) rather
than from portfolio volume. It never demotes from `large`.

### Degradation

Same posture as the AI re-rank: verification may fail in any way and the deterministic results
stay on screen. Per-sponsor errors are isolated inside `lfPool`, a 429 stops the pass rather
than retrying a free public API, and `LF_REG_BUDGET_MS` bounds the worst case. With
`LF_LAST.reg` empty every function returns exactly its pre-feature output — that additivity is
what the harness checks first.

`LF_LAST.reg` must be passed to **both** `lfRollupSponsors` call sites (`lfRenderResults` and
`lfAiRerank`). Missing the second is silent: cards would show corrected tiers while the model
received the uncorrected ones.

### SEC EDGAR is deliberately NOT in the playground

Verified 2026-07-28: of the three `CORS_PROXIES`, codetabs returns 522 and cors.eu.org returns
an HTML error page. allorigins works for EDGAR full-text search (21,476 vs 21,480 bytes direct)
but **truncates `company_tickers.json` at ~76 KB of 798 KB**, so ticker→CIK resolution cannot
work in a browser. EDGAR full-text also caps retrievable hits at ~100 of 332 PDUFA mentions per
year, needing ~30 paginated proxied requests, and that population (small-cap US biotech) barely
intersects CT.gov ADC sponsors. **EDGAR belongs in the Modal backend**, where the required
`User-Agent` is settable and results can be cached. `_source.display_names` carries
name + ticker + CIK in one string, so the backend join needs no ticker map either.

### Verifying

```bash
node tools/verify-registry.mjs          # units + guards + live resolution  (~15s)
node tools/verify-registry.mjs --e2e    # + full CT.gov→openFDA pass and render checks (~40s)
```

This is the **one exception to "no test suite"**, and a narrow one: a single dependency-free
`.mjs` that reads this HTML and evaluates the shipped `<script>` behind a DOM stub. There is no
`package.json`, no build step, and nothing it touches is served — so the zero-build property
holds. It earns its place because both bugs it now guards against reached a working build and
produced *wrong answers with no error*: the `HANGZHOU BINJIANG` false match, and the inverted
demotion rule. Run it after touching `lfRegAccept`, `lfRegVariants`, `LF_REG_GENERIC_ROOTS`,
`lfSizeTier`, or `LF_SPONSOR_ALIASES`.

The assertions that matter most: the unverified render must equal pre-feature output, no card may
render `FDA · 0 apps`, unresolved must never move a tier, and no large-footprint sponsor may be
demoted on an FDA zero.

## CORS: CT.gov is fine, EDGAR is not

ClinicalTrials.gov and openFDA permit direct browser calls.

SEC EDGAR requires a descriptive `User-Agent` per its Fair Access rules, which browsers
refuse to let scripts set — so direct calls fail with CORS errors or `403`. The
openFDA/EDGAR playground falls back to a chain of free public proxies
(`CORS_PROXIES`, `openfda-edgar-playground.html:896-899`: allorigins → codetabs →
cors.eu.org) behind a "Retry via CORS proxy (demo)" button.

**That chain is demo-only.** Those proxies are third-party and see the full request. Never
route credentials or sensitive data through them. Production EDGAR access must go through a
Syngage backend proxy setting `User-Agent: SyngageAI/1.0 ops@syngage.ai`. Do not remove the
warning banners that say so (`openfda-edgar-playground.html:781`).

## `clinicaltrials-api-playground-0.html` is a backup

It is the pre-Lead-Finder snapshot of the main playground, committed as a reference. The
landing page does not link to it. **Do not mirror edits into it** — leave it frozen. If it
ever stops being useful, delete it rather than maintaining it in parallel.

## Verification

There is no test suite; verification is manual in a browser.

```bash
python3 -m http.server 8000   # then open http://localhost:8000/
```

- The CT.gov playground header shows a live `API: v… · Data: …` string — if it reads
  `unreachable`, the `/version` fetch failed.
- Fastest end-to-end check of the URL encoding: `/studies` → "ADC Phase 1-2 (recruiting)"
  preset → Execute → expect HTTP 200 with results.
- Lead Finder: "BIOVECTRA" example button → "Extract & Find Leads" → expect attribute
  cards, an anchor banner, ~5 queries, and trial results.
- EDGAR endpoints are *expected* to fail on first attempt; that is the documented behavior,
  not a regression.

If tests are ever added, the pure functions (`lfExtract`, `lfBuildQueries`,
`lfGeoToCountries`, `lfInferSignal`) are the natural first targets — but they must be
extracted to a module first, which reintroduces the build-step question above.
