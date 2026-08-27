# Per-region data files, fetched lazily, over one combined multi-region file

Extending beyond `us-east-1` (ADR-0002 originally scoped to it) means fetching the AWS
Price List bulk offer file once per AWS region — each one several hundred MB raw, even
for a region with few instance types, since the bulk file enumerates every SKU
combination (OS, tenancy, license model, pre-installed software, ...) regardless of
region size. Trimmed down to the fields this tool needs, a single region's data lands
around 500KB; combined across all regions that's a low-tens-of-MB JSON blob if written
as one file.

We chose to keep pricing data as one JSON file per region (`data/regions/<code>.json`)
plus a small `data/regions/index.json` listing region codes, display names, row counts,
and per-region freshness, rather than one combined file:

- The browser only ever needs one region's data at a time (comparisons are always
  within a single region — see CONTEXT.md's "Region" entry). Lazily fetching just the
  selected region keeps first load small regardless of how many regions the tool
  supports, and the region index is cheap to load upfront to populate the picker.
- A single failed/slow region during the daily refresh (see below) only risks that one
  region's file being stale, not the entire site's dataset.

The refresh workflow (`scripts/refresh-data.js`) fetches and trims all ~35 top-level AWS
regions sequentially — not concurrently, to bound peak memory given each region's raw
offer file can be hundreds of MB — and treats each region's fetch/parse independently: a
failure for one region logs a warning, keeps that region's last committed file as-is
(flagged `stale` in the index), and doesn't fail the whole run. AWS Local Zones and
Wavelength Zones (e.g. `us-east-1-bos-1`, `ap-northeast-1-wl1-kix1`) are deliberately
excluded from the region list — they're opt-in extensions of a parent region with a
restricted instance-type subset, not a region a teammate would pick from the normal EC2
launch-instance dropdown. `scripts/regions.js` hardcodes the region list and needs a
manual update when AWS launches a new top-level region.

This trades a slower, heavier-bandwidth daily refresh job (~35 fetches instead of 1) for
a client that only ever downloads the one region a teammate is actually comparing
against.
