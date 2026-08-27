# EC2 Cheaper Finder — Spec

See [`CONTEXT.md`](../CONTEXT.md) for glossary terms (**baseline**, **candidate**,
**match**, **flagged difference**, **excluded type**, etc.) used throughout this doc, and
[`docs/adr/`](./adr/) for the reasoning behind the three decisions marked (ADR-000x)
below.

## What it does

A teammate enters a **baseline** instance type — current- or previous-generation, so
converting an old instance to a modern one works too. The tool returns every
**current-generation candidate** with the exact same vCPU count and RAM that costs less
on On-Demand pricing in `us-east-1`, sorted cheapest first, each annotated with any
**flagged differences** from the baseline.

## Architecture (ADR-0001)

Fully static site, hosted on GitHub Pages. No backend server, no user auth.

```
GitHub Actions (daily, scheduled + manual dispatch)
  → fetch AWS Price List Bulk API (EC2, us-east-1)          [ADR-0002]
  → filter to non-accelerated, non-bare-metal, On-Demand (both gens kept)
  → trim to the fields the UI needs (see Data schema)
  → commit data/instances.json to the repo
  → GitHub Pages serves the updated static site

Browser
  → loads index.html + app.js + data/instances.json
  → user enters baseline instance type, picks OS(es)/Graviton toggle
  → matching runs entirely client-side against instances.json
```

## Data pipeline

**Source**: AWS Price List Bulk API, `AmazonEC2` service, `us-east-1` region offer file
(no AWS credentials required — plain HTTPS GET). (ADR-0002)

**Refresh**: GitHub Actions workflow, `schedule: cron` daily + `workflow_dispatch` for
manual runs.

**Filtering during trim** (rows dropped entirely, never reach the site):
- Product family indicates GPU/FPGA/inference/training accelerator, or instance type
  ends in `.metal`, or isn't a standard compute instance line item → dropped (ADR-0003)
- Purchase option other than On-Demand → dropped
- Tenancy other than Shared/default → dropped (avoids duplicate rows per instance type)
- OS other than Linux/Windows → dropped

Current- vs. previous-generation is *not* a drop condition — both are kept, tagged with
`currentGeneration`, and it's enforced client-side instead (previous-gen rows are valid
baselines, just never valid candidates — see CONTEXT.md's "Current-generation" entry).

**Output**: `data/instances.json`, one row per (instance type × OS), each row roughly:

```json
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

Given a validated baseline row:

1. Filter `instances.json` to rows where:
   - `os` matches the baseline's `os` (baseline and candidates are always compared
     within the same OS — see the per-OS section note below)
   - `instanceType` ≠ baseline's `instanceType`
   - `currentGeneration` is `true` (candidates are always current-gen, even when the
     baseline isn't)
   - `vcpu` and `memoryGiB` exactly equal the baseline's
   - `architecture` is `x86_64`, or `arm64` only if the Graviton toggle is on
   - `pricePerHour` < baseline's `pricePerHour`
2. For each surviving row, compute:
   - `savingsPerHour = baseline.pricePerHour - candidate.pricePerHour`
   - `savingsPercent = savingsPerHour / baseline.pricePerHour * 100`
   - flagged differences: compare `networkPerformance`, `dedicatedEbsThroughput`,
     `storageType` against the baseline; include only the ones that differ
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

- **Instance type input**: free-text box + submit. On submit, look up the string in
  `instances.json`; if not found (or found only as an excluded type), show an inline
  error explaining why, no results.
- **OS checkboxes**: Windows (checked by default), Linux (unchecked by default) —
  multi-select, at least one must be checked to search.
- **Graviton toggle**: off by default.
- **Results table**, sorted cheapest first, columns: instance type, price/hr, savings
  ($/hr and %), flagged differences (as small inline badges/tags, only shown when
  present for that row).

## Repo layout

```
/
├── CONTEXT.md
├── docs/
│   ├── SPEC.md              (this file)
│   └── adr/
├── .github/workflows/refresh-data.yml
├── data/instances.json       (generated, committed by the workflow)
├── scripts/refresh-data.*     (fetch + trim script the workflow runs)
├── index.html
├── styles.css
└── app.js
```

## Explicitly out of scope for v1

- Regions other than `us-east-1`
- Purchase options other than On-Demand (Reserved/Savings Plans/Spot)
- "At least as much" fallback matching when no exact match exists
- Precise (non-string) network/IOPS numbers from `DescribeInstanceTypes`
- Auth / access control
