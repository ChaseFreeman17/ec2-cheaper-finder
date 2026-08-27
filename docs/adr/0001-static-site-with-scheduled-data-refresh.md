# Static site with a scheduled data-refresh workflow, not a live backend

The tool needs to be usable by teammates via a browser, but the raw AWS Price List bulk
JSON is hundreds of MB — too large to fetch client-side on every visit, and running a
live backend server just to proxy/cache it is more infrastructure than a small lookup
tool warrants. We decided to host a fully static site on GitHub Pages, with a GitHub
Actions workflow that runs daily, re-fetches and trims the AWS pricing data down to just
what the tool needs, and commits the small resulting JSON for the static page to read
directly. This trades true real-time pricing (data can be up to ~24h stale) for zero
server cost/maintenance and a trivially simple deploy.
