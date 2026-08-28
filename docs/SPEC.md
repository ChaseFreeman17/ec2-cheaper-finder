# EC2 Undercut — Spec

See [`CONTEXT.md`](../CONTEXT.md) for glossary terms (**region**, **baseline**,
**candidate**, **match**, **flagged difference**, **excluded type**, etc.) used
throughout this doc, and [`docs/adr/`](./adr/) for the reasoning behind the decisions
marked (ADR-000x) below.

## What it does

A teammate picks a **region** (defaults to `us-east-1`) and enters a **baseline**
instance type — current- or previous-generation, so converting an old instance to a
modern one works too. The tool returns every **current-generation candidate** in that
same region with vCPU count and RAM at least as much as the baseline's (never less) that
costs less on On-Demand pricing, sorted cheapest first, each annotated with any
**flagged differences** from the baseline — including any extra vCPU/RAM it has beyond
what the baseline needs. A bulk mode runs the same lookup for a whole pasted list of
instance types at once (e.g. auditing a fleet), and every search's URL is shareable —
loading it re-runs the same search (see UI below).

## Architecture (ADR-0001)

Fully static site, hosted on GitHub Pages. No backend server, no user auth.

```
GitHub Actions (daily, scheduled + manual dispatch)
  → for each of ~35 AWS regions (scripts/regions.js):     [ADR-0004]
      fetch AWS Price List Bulk API (EC2, that region)     [ADR-0002]
      filter to non-accelerated, non-bare-metal, On-Demand (both gens kept)
      trim to the fields the UI needs (see Data schema)
      write data/regions/<code>.json
  → write data/regions/index.json (region list + freshness)
  → commit data/regions/ to the repo
  → GitHub Pages serves the updated static site

Browser
  → loads index.html + app.js + data/regions/index.json (small, populates region picker)
  → user picks a region → data/regions/<code>.json fetched lazily and cached in memory
  → user enters baseline instance type (autocomplete, see UI), picks OS(es)/Graviton toggle
  → matching runs entirely client-side against the selected region's data
```

## Data pipeline

**Source**: AWS Price List Bulk API, `AmazonEC2` service, one region-specific offer file
per AWS region (no AWS credentials required — plain HTTPS GET). (ADR-0002)

**Regions covered**: all top-level AWS regions (commercial + GovCloud), hardcoded in
`scripts/regions.js` — not AWS Local Zones or Wavelength Zones, and not China (separate
partition). See ADR-0004 for why per-region files and why this region list.

**Refresh**: GitHub Actions workflow, `schedule: cron` daily + `workflow_dispatch` for
manual runs. Regions are fetched sequentially (not concurrently) to bound peak memory —
each raw offer file can be several hundred MB. A single region's fetch/parse failure
logs a warning and keeps that region's last committed file (flagged `stale` in the
index) rather than failing the whole run.

**Filtering during trim** (rows dropped entirely, never reach the site):
- Product family indicates GPU/FPGA/inference/training accelerator, or instance type
  ends in `.metal`, or isn't a standard compute instance line item → dropped (ADR-0003)
- Purchase option other than On-Demand → dropped
- Tenancy other than Shared/default → dropped (avoids duplicate rows per instance type)
- OS other than Linux/Windows → dropped

Current- vs. previous-generation is *not* a drop condition — both are kept, tagged with
`currentGeneration`, and it's enforced client-side instead (previous-gen rows are valid
baselines, just never valid candidates — see CONTEXT.md's "Current-generation" entry).

**Output**: one file per region, `data/regions/<code>.json`, one row per (instance type ×
OS), each row roughly:

```json
{
  "generatedAt": "2026-08-27T06:17:00.000Z",
  "region": "us-east-1",
  "regionName": "US East (N. Virginia)",
  "source": "AWS Price List Bulk API",
  "instances": [
    {
      "instanceType": "m6i.xlarge",
      "os": "Linux" | "Windows",
      "vcpu": 4,
      "memoryGiB": 16,
      "architecture": "x86_64" | "arm64",
      "currentGeneration": true,
      "pricePerHour": 0.192,
      "networkPerformance": "Up to 12.5 Gigabit",
      "dedicatedEbsThroughput": "Up to 4750 Mbps",
      "storageType": "EBS-only" | "instance-store",
      "burstKind": "credit" | "flex" | null
    }
  ],
  "excludedTypes": { "p3.2xlarge": "accelerated", "...": "..." }
}
```

Plus `data/regions/index.json`, loaded first by the browser to populate the region
picker without fetching every region's full data:

```json
{
  "generatedAt": "2026-08-27T06:17:00.000Z",
  "regions": [
    { "code": "us-east-1", "name": "US East (N. Virginia)", "group": "US", "instanceCount": 1909, "generatedAt": "..." },
    { "code": "il-central-1", "name": "Israel (Tel Aviv)", "group": "Israel", "instanceCount": 475, "generatedAt": "...", "stale": true }
  ]
}
```

Field names confirmed against a real sample of the bulk JSON (`scripts/refresh-data.js`
reads `attributes.instanceType`, `.vcpu`, `.memory`, `.currentGeneration`,
`.networkPerformance`, `.dedicatedEbsThroughput`/`.dedicatedEbsThroughputDescription`,
`.storage`, `.physicalProcessor`, `.instanceFamily`, `.productFamily`, `.tenancy`,
`.capacitystatus`, `.preInstalledSw`, `.licenseModel`, `.marketoption`,
`.operatingSystem`). `architecture` and `burstKind` are derived rather than read
directly: `architecture` is `arm64` when `physicalProcessor` contains "Graviton", else
`x86_64`; `burstKind` is `"credit"` when the instance-type family prefix matches `t\d`
(e.g. `t3`, `t4g`), `"flex"` when the family ends in `-flex` (e.g. `m7i-flex`,
`c8i-flex`), else `null` (see CONTEXT.md's "Burst-capable" entry).

## Matching algorithm (client-side, in `app.js`)

All matching happens within the currently-selected region's data (loaded lazily from
`data/regions/<code>.json` and cached per session — see Architecture). Given a validated
baseline row:

1. Filter that region's `instances` to rows where:
   - `os` matches the baseline's `os` (baseline and candidates are always compared
     within the same OS — see the per-OS section note below)
   - `instanceType` ≠ baseline's `instanceType`
   - `currentGeneration` is `true` (candidates are always current-gen, even when the
     baseline isn't)
   - `vcpu` >= the baseline's `vcpu`, and `memoryGiB` >= the baseline's `memoryGiB`
     (never less, but more is fine — see CONTEXT.md's "Match" entry for why this isn't
     exact-only)
   - `architecture` is `x86_64`, or `arm64` only if the Graviton toggle is on
   - `burstKind` is falsy, or truthy is fine if the "include burstable" toggle is on
     (on by default — this only filters candidates, never hides a burstable baseline)
   - `pricePerHour` < baseline's `pricePerHour`
2. For each surviving row, compute:
   - `savingsPerHour = baseline.pricePerHour - candidate.pricePerHour`
   - `savingsPercent = savingsPerHour / baseline.pricePerHour * 100`
   - flagged differences: compare `vcpu`, `memoryGiB`, `networkPerformance`,
     `dedicatedEbsThroughput`, `storageType` against the baseline; include only the ones
     that differ (a candidate with more vCPU/RAM than the baseline gets flagged the same
     way a network/storage change does)
   - burst badge: if `burstKind` is non-null, render a prominent warning-styled badge
     (not a flagged difference) — shown for *any* burst-capable row, baseline or
     candidate, regardless of whether the baseline itself was also burst-capable
3. Sort by `pricePerHour` ascending.
4. If the baseline itself was excluded from the dataset entirely (accelerated/
   bare-metal/not-a-standard-instance, per ADR-0003), show an explanatory message
   instead of running a search. If the baseline is previous-generation, it's still
   searched normally — just noted as previous-gen above its results.
5. If no candidates survive step 1, show "No cheaper equivalent found."

Since price (and OS availability) differs by operating system, the baseline is looked
up per checked OS box independently (one baseline row + result table per checked OS),
rather than mixing OSes in a single comparison.

## UI

Single page, plain HTML/CSS/vanilla JS, modern styling (dark-mode-aware, no framework).

- **Region select**: a `<select>` populated from `data/regions/index.json` at load,
  defaulting to `us-east-1`, grouped into `<optgroup>`s by continent/geography (per
  region's `group` field — GovCloud gets its own group rather than folding into "US").
  Within a group, the redundant continent prefix is trimmed from each option's label
  (e.g. "Asia Pacific (Seoul)" reads as just "Seoul" under an "Asia Pacific" heading).
  Changing the selection clears any results, loads that region's data (fetched once,
  cached in memory for the session), and rebuilds the instance-type autocomplete list
  below. A region flagged `stale` in the index (its last refresh failed and this is
  yesterday's data) is labeled "(data delayed)" in the dropdown.
- **Instance type input**: a hand-rolled autocomplete combobox, not plain free text or a
  native `<select>` — free text doesn't validate as you type, and a `<select>` listing
  every instance type in a region (or across all regions) isn't browsable. Typing
  filters `state.instanceTypeOptions` (deduped instance types from the current region's
  `instances`, plus its `excludedTypes` keys so those are still discoverable) by
  substring match, capped at 30 results; arrow keys/Enter/Escape and mouse both work.
  Excluded types appear muted with an "excluded" tag rather than being hidden, so
  picking one still surfaces the explanatory error instead of just not existing. On
  submit, the typed value is looked up the same way regardless of whether it came from
  a suggestion or was typed by hand; not found (or found only as an excluded type) shows
  an inline error, no results.
- **OS checkboxes**: Windows (checked by default), Linux (unchecked by default) —
  multi-select, at least one must be checked to search.
- **Graviton toggle**: off by default.
- **Include burstable instance types toggle**: on by default — unlike Graviton, most
  teammates want burstable candidates visible (they're already called out with the
  ⚡ badge), so this defaults to showing them; turning it off filters burst-capable rows
  out of candidates only, never hides a burstable baseline.
- **Results table**, sorted cheapest first, columns: instance type, price/hr, savings
  ($/hr and %), projected savings (monthly and yearly, assuming the instance runs
  continuously — 730 hrs/month, 8,760 hrs/year, the same averages AWS's own pricing
  calculator uses), flagged differences (as small inline badges/tags, only shown when
  present for that row). Bulk mode's summary table carries the same projected-savings
  column.
- **Bulk lookup mode**: a "Switch to bulk lookup" link next to the instance-type label
  swaps the combobox for a textarea (one instance type per line, or comma-separated).
  Submitting runs the *same* matching logic once per (instance type × selected OS) pair
  and renders one condensed summary row each — instance type, OS, price, cheapest match,
  savings, and a "Details" button — rather than the full baseline-card-plus-table
  treatment used in single mode, which doesn't scale past a handful of types. A type
  that's unrecognized or excluded gets a one-line explanatory row instead of being
  silently skipped. Capped at 300 unique entries per submission (a soft ceiling against
  a pathological paste, not a realistic fleet size). "Details" jumps back to single mode
  pre-filled with that exact type/OS for the full breakdown.
- **Shareable URLs**: every search (region, mode, instance type(s), OS, Graviton/
  burstable toggles) is reflected in the URL query string on submit — `?region=...` plus
  either `&type=...` (single mode) or `&mode=bulk&types=...` (bulk mode, comma-joined).
  Loading a URL with these params re-runs that exact search automatically, so a result
  can be bookmarked or sent to a teammate. Manual submits push a new history entry
  (so back/forward step through past searches in a session); the initial URL-driven
  load and browser back/forward both replay via the same `applyUrlParams` path rather
  than pushing new entries.

## Repo layout

```
/
├── CONTEXT.md
├── docs/
│   ├── SPEC.md              (this file)
│   └── adr/
├── .github/workflows/refresh-data.yml
├── data/regions/
│   ├── index.json            (generated, committed by the workflow)
│   └── <region-code>.json    (generated, committed by the workflow; one per region)
├── scripts/
│   ├── regions.js            (hardcoded list of AWS regions to fetch)
│   └── refresh-data.js       (fetch + trim script the workflow runs, all regions)
├── index.html
├── styles.css
└── app.js
```

## Explicitly out of scope for v1

- Purchase options other than On-Demand (Reserved/Savings Plans/Spot)
- Precise (non-string) network/IOPS numbers from `DescribeInstanceTypes`
- Cross-region comparisons (a candidate is always in the same region as its baseline)
- Auth / access control
