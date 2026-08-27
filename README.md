# EC2 Cheaper Finder

A static site: enter an EC2 instance type, get back current-generation instance types
with the exact same vCPU/RAM that cost less On-Demand in `us-east-1`, with network/EBS
bandwidth/storage-type/burstable differences flagged. See [`docs/SPEC.md`](docs/SPEC.md)
for the full design and [`CONTEXT.md`](CONTEXT.md) for the glossary.

## Running locally

No build step. Just serve the directory statically, e.g.:

```sh
npx serve .
# or: python -m http.server 8000
```

Then open the printed local URL. `data/instances.json` is already checked into the repo
(refreshed daily by CI), so it works without fetching anything from AWS yourself.

## Refreshing the pricing data manually

```sh
node scripts/refresh-data.js
```

This hits the public AWS Price List Bulk API (no AWS credentials needed) and rewrites
`data/instances.json`. It downloads a large (several-hundred-MB) file, so give it a
minute. `.github/workflows/refresh-data.yml` runs this daily and commits the result
automatically.

## Deploying to GitHub Pages

1. Push this repo to GitHub.
2. In the repo's **Settings → Pages**, set **Source** to "Deploy from a branch", branch
   `main`, folder `/(root)`.
3. That's it — every push to `main` (including the daily automated data-refresh commits)
   redeploys the site automatically. No separate deploy workflow is needed.
