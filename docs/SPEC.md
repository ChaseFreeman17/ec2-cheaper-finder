# EC2 Cheaper Finder — Spec

See [`CONTEXT.md`](../CONTEXT.md) for glossary terms (**baseline**, **candidate**,
**match**, **flagged difference**, **excluded type**, etc.) used throughout this doc, and
[`docs/adr/`](./adr/) for the reasoning behind the three decisions marked (ADR-000x)
below.

## What it does

A teammate enters a **baseline** instance type. The tool returns every current-generation
**candidate** with the exact same vCPU count and RAM that costs less on On-Demand
pricing in `us-east-1`, sorted cheapest first, each annotated with any **flagged
differences** from the baseline.

## Architecture (ADR-0001)

Fully static site, hosted on GitHub Pages. No backend server, no user auth.

```
GitHub Actions (daily, scheduled + manual dispatch)
  → fetch AWS Price List Bulk API (EC2, us-east-1)          [ADR-0002]
  → filter to current-generation, non-accelerated, non-bare-metal, On-Demand
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
- Not `currentGeneration: Yes` → dropped
- Product family indicates GPU/FPGA/inference/training accelerator, or instance type
  ends in `.metal` → dropped (ADR-0003)
- Purchase option other than On-Demand → dropped
- Tenancy other than Shared/default → dropped (avoids duplicate rows per instance type)

**Output**: `data/instances.json`, one row per (instance type × OS), each row roughly:

```json
{
  "instanceType": "m6i.xlarge",
  "os": "Linux" | "Windows",
  "vcpu": 4,
  "memoryGiB": 16,
  "architecture": "x86_64" | "arm64",
  "pricePerHour": 0.192,
  "networkPerformance": "Up to 12.5 Gigabit",
  "dedicatedEbsThroughput": "Up to 4750 Mbps",
  "storageType": "EBS-only" | "instance-store",
  "burstable": false
}
```

Exact field names/availability to be confirmed against a real sample of the bulk JSON
during implementation — `architecture` and `burstable` in particular may need to be
derived (e.g. `burstable` = instance-type prefix is `t*`; `architecture` from the
`physicalProcessor`/instance-family naming) rather than read directly off a single
attribute.

## Matching algorithm (client-side, in `app.js`)

Given a validated baseline row:

1. Filter `instances.json` to rows where:
   - `vcpu` and `memoryGiB` exactly equal the baseline's
   - `os` is one of the checked OS boxes
   - `architecture` is `x86_64`, or `arm64` only if the Graviton toggle is on
   - `pricePerHour` < baseline's `pricePerHour`
   - `instanceType` ≠ baseline's `instanceType`
2. For each surviving row, compute:
   - `savingsPerHour = baseline.pricePerHour - candidate.pricePerHour`
   - `savingsPercent = savingsPerHour / baseline.pricePerHour * 100`
   - flagged differences: compare `networkPerformance`, `dedicatedEbsThroughput`,
     `storageType`, `burstable` against the baseline; include only the ones that differ
3. Sort by `pricePerHour` ascending.
4. If the baseline itself was excluded from the dataset (accelerated/bare-metal/
   previous-gen), show an explanatory message instead of running a search.
5. If no candidates survive step 1, show "No cheaper equivalent found."

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
