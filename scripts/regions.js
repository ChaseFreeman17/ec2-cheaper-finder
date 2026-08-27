// Top-level AWS EC2 regions to fetch pricing for. Deliberately excludes AWS Local Zones
// and Wavelength Zones (e.g. "us-east-1-bos-1", "ap-northeast-1-wl1-kix1" in AWS's
// region_index.json) — those are opt-in extensions of a parent region with a limited
// instance-type subset, not a region a teammate would pick from the normal EC2
// launch-instance region dropdown, and "cheaper within this region" wouldn't mean the
// same thing for them. China regions aren't included either: they're a separate AWS
// partition (aws-cn) that isn't in this pricing index at all.
//
// This list needs a manual update when AWS launches a new top-level region (rare — a
// handful of times a year). Names are AWS's official region display names where
// confidently known; newer/less-common regions fall back to a generic
// "<continent> (<code>)" label rather than risk asserting a wrong city.

const CONTINENT_LABELS = {
  af: "Africa",
  ap: "Asia Pacific",
  ca: "Canada",
  eu: "Europe",
  il: "Israel",
  me: "Middle East",
  mx: "Mexico",
  sa: "South America",
  us: "US",
};

const KNOWN_NAMES = {
  "af-south-1": "Africa (Cape Town)",
  "ap-east-1": "Asia Pacific (Hong Kong)",
  "ap-northeast-1": "Asia Pacific (Tokyo)",
  "ap-northeast-2": "Asia Pacific (Seoul)",
  "ap-northeast-3": "Asia Pacific (Osaka)",
  "ap-south-1": "Asia Pacific (Mumbai)",
  "ap-south-2": "Asia Pacific (Hyderabad)",
  "ap-southeast-1": "Asia Pacific (Singapore)",
  "ap-southeast-2": "Asia Pacific (Sydney)",
  "ap-southeast-3": "Asia Pacific (Jakarta)",
  "ap-southeast-4": "Asia Pacific (Melbourne)",
  "ap-southeast-5": "Asia Pacific (Malaysia)",
  "ca-central-1": "Canada (Central)",
  "ca-west-1": "Canada West (Calgary)",
  "eu-central-1": "Europe (Frankfurt)",
  "eu-central-2": "Europe (Zurich)",
  "eu-north-1": "Europe (Stockholm)",
  "eu-south-1": "Europe (Milan)",
  "eu-south-2": "Europe (Spain)",
  "eu-west-1": "Europe (Ireland)",
  "eu-west-2": "Europe (London)",
  "eu-west-3": "Europe (Paris)",
  "il-central-1": "Israel (Tel Aviv)",
  "me-central-1": "Middle East (UAE)",
  "me-south-1": "Middle East (Bahrain)",
  "mx-central-1": "Mexico (Central)",
  "sa-east-1": "South America (Sao Paulo)",
  "us-east-1": "US East (N. Virginia)",
  "us-east-2": "US East (Ohio)",
  "us-gov-east-1": "AWS GovCloud (US-East)",
  "us-gov-west-1": "AWS GovCloud (US-West)",
  "us-west-1": "US West (N. California)",
  "us-west-2": "US West (Oregon)",
};

// Every top-level region code refresh-data.js attempts to fetch. Cross-checked live
// against region_index.json at refresh time — a code AWS has retired is skipped with a
// warning instead of failing the whole run; a *new* region AWS adds won't appear here
// until this list is updated by hand.
const REGION_CODES = [
  "af-south-1", "ap-east-1", "ap-east-2", "ap-northeast-1", "ap-northeast-2",
  "ap-northeast-3", "ap-south-1", "ap-south-2", "ap-southeast-1", "ap-southeast-2",
  "ap-southeast-3", "ap-southeast-4", "ap-southeast-5", "ap-southeast-6", "ap-southeast-7",
  "ca-central-1", "ca-west-1", "eu-central-1", "eu-central-2", "eu-north-1", "eu-south-1",
  "eu-south-2", "eu-west-1", "eu-west-2", "eu-west-3", "il-central-1", "me-central-1",
  "me-south-1", "mx-central-1", "sa-east-1", "us-east-1", "us-east-2", "us-gov-east-1",
  "us-gov-west-1", "us-west-1", "us-west-2",
];

function nameForRegion(code) {
  if (KNOWN_NAMES[code]) return KNOWN_NAMES[code];
  const prefix = code.split("-")[0];
  return `${CONTINENT_LABELS[prefix] || prefix.toUpperCase()} (${code})`;
}

const REGIONS = REGION_CODES.map((code) => ({ code, name: nameForRegion(code) }));

module.exports = { REGIONS };
