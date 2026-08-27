#!/usr/bin/env node
// Fetches the AWS Price List Bulk API offer file for EC2, once per top-level AWS region
// (see ./regions.js), trims each down to the non-accelerated, On-Demand rows the site
// needs, and writes one JSON file per region under data/regions/, plus a small
// data/regions/index.json the client loads first to populate the region picker. Both
// current- and previous-generation rows are kept per region (previous-gen types are
// valid baselines, just never valid candidates — see CONTEXT.md's "Current-generation"
// entry). See docs/SPEC.md and docs/adr/0002-*.md / 0004-*.md for why this source and
// this per-region shape.
//
// No AWS credentials required — this hits the public pricing.*.amazonaws.com bulk JSON
// endpoints over plain HTTPS. Each region's offer file can be several hundred MB, so this
// script deliberately processes regions one at a time (not concurrently) to keep peak
// memory bounded, and a single region's fetch/parse failure doesn't abort the whole run —
// see main()'s per-region try/catch.

const fs = require("fs");
const path = require("path");
const { REGIONS } = require("./regions");

const REGION_INDEX_URL =
  "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonEC2/current/region_index.json";
const PRICING_HOST = "https://pricing.us-east-1.amazonaws.com";
const OUTPUT_DIR = path.join(__dirname, "..", "data", "regions");

// instanceFamily values that mean "this isn't a plain compute instance" — GPUs,
// inference/training ASICs, FPGAs. Excluded from the matchable pool entirely rather
// than flagged, per ADR-0003. (`productFamily !== "Compute Instance"` already excludes
// bare metal, dedicated hosts, and non-instance line items like data transfer.)
const EXCLUDED_INSTANCE_FAMILIES = new Set([
  "GPU instance",
  "Machine Learning ASIC Instances",
  "Media Accelerator Instances",
  "FPGA Instances",
]);

const SUPPORTED_OS = new Set(["Linux", "Windows"]);

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`GET ${url} failed: ${res.status} ${res.statusText}`);
  }
  const text = await res.text();
  return JSON.parse(text);
}

async function fetchJsonWithRetry(url, attempts = 2) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetchJson(url);
    } catch (err) {
      lastErr = err;
      console.warn(`  fetch failed (attempt ${i + 1}/${attempts}): ${err.message}`);
    }
  }
  throw lastErr;
}

function parseMemoryGiB(memoryAttr) {
  // e.g. "7.5 GiB", "1024.0 GiB", "1,952 GiB"
  const cleaned = String(memoryAttr).replace(/,/g, "").replace(/GiB/i, "").trim();
  return parseFloat(cleaned);
}

// Two distinct AWS mechanisms both mean "CPU performance isn't fixed", and both need to
// be surfaced — see CONTEXT.md's "Burst-capable" entry:
//   - "credit": classic T-family (t2/t3/t3a/t4g/...) — earns/spends CPU credits, throttles
//     hard to baseline once credits run out.
//   - "flex": *-flex families (c7i-flex, c8i-flex, m7i-flex, m8i-flex, r8i-flex, ...) —
//     ~40% baseline, bursts to 100% for up to 95% of a rolling 24h window, with gradual
//     (not hard) throttling under sustained high utilization.
// Returns null for fixed-performance instance types.
function burstKindOf(instanceType) {
  const family = instanceType.split(".")[0].toLowerCase();
  if (/^t\d/.test(family)) return "credit";
  if (family.endsWith("-flex")) return "flex";
  return null;
}

function architectureOf(physicalProcessor) {
  return /graviton/i.test(physicalProcessor || "") ? "arm64" : "x86_64";
}

// Returns null if the product is a normal, matchable compute instance; otherwise a
// short reason code explaining why it's excluded from the pool entirely (ADR-0003).
function exclusionReason(product) {
  const attrs = product.attributes || {};
  if (/metal/i.test(attrs.instanceType || "")) return "bare-metal";
  if (product.productFamily !== "Compute Instance") return "not-a-standard-instance";
  if (EXCLUDED_INSTANCE_FAMILIES.has(attrs.instanceFamily)) return "accelerated";
  return null;
}

function passesOnDemandFilters(attrs) {
  // Deliberately no currentGeneration check here: previous-generation types are still
  // valid *baselines* (finding a modern replacement for an old instance is the point),
  // just never valid *candidates* — that's enforced client-side in app.js using the
  // `currentGeneration` flag on each row.
  return (
    attrs.tenancy === "Shared" &&
    attrs.capacitystatus === "Used" &&
    attrs.preInstalledSw === "NA" &&
    attrs.licenseModel === "No License required" &&
    attrs.marketoption === "OnDemand" &&
    SUPPORTED_OS.has(attrs.operatingSystem)
  );
}

function onDemandPriceForSku(terms, sku) {
  const offers = terms.OnDemand && terms.OnDemand[sku];
  if (!offers) return null;
  for (const offerTermCode of Object.keys(offers)) {
    const dimensions = offers[offerTermCode].priceDimensions || {};
    for (const rateCode of Object.keys(dimensions)) {
      const dim = dimensions[rateCode];
      if (dim.unit === "Hrs" && dim.pricePerUnit && dim.pricePerUnit.USD) {
        const price = parseFloat(dim.pricePerUnit.USD);
        if (!Number.isNaN(price)) return price;
      }
    }
  }
  return null;
}

// Trims one region's raw offer file down to the rows/exclusions the site needs. Pulled
// out of the fetch step so main()'s per-region loop can retry/skip on fetch failure
// without duplicating this logic.
function trimOfferProducts(offer) {
  const products = offer.products || {};
  const terms = offer.terms || {};

  const rows = new Map(); // key: `${instanceType}|${os}` -> row
  // Instance types that exist in AWS's data but are deliberately left out of `rows`, so
  // the UI can explain *why* a lookup came back empty instead of just saying "not
  // found". Reason wins the first time we see that instance type; later SKUs for the
  // same type (different OS, etc.) don't overwrite it.
  const excludedTypes = new Map(); // instanceType -> reason
  let seen = 0;
  let excluded = 0;
  let filteredOut = 0;
  let noPrice = 0;

  for (const sku of Object.keys(products)) {
    const product = products[sku];
    seen++;
    const attrs = product.attributes || {};
    const instanceType = attrs.instanceType;

    const reason = exclusionReason(product);
    if (reason) {
      excluded++;
      if (instanceType && !excludedTypes.has(instanceType)) {
        excludedTypes.set(instanceType, reason);
      }
      continue;
    }

    if (!passesOnDemandFilters(attrs)) {
      filteredOut++;
      continue;
    }

    const price = onDemandPriceForSku(terms, sku);
    if (price === null || price <= 0) {
      noPrice++;
      continue;
    }

    const row = {
      instanceType: attrs.instanceType,
      os: attrs.operatingSystem,
      vcpu: parseInt(attrs.vcpu, 10),
      memoryGiB: parseMemoryGiB(attrs.memory),
      architecture: architectureOf(attrs.physicalProcessor),
      currentGeneration: attrs.currentGeneration === "Yes",
      pricePerHour: price,
      networkPerformance: attrs.networkPerformance || "Unknown",
      dedicatedEbsThroughput:
        attrs.dedicatedEbsThroughput || attrs.dedicatedEbsThroughputDescription || "Not supported",
      storageType: attrs.storage === "EBS only" ? "EBS-only" : "instance-store",
      burstKind: burstKindOf(attrs.instanceType),
    };

    if (Number.isNaN(row.vcpu) || Number.isNaN(row.memoryGiB)) {
      filteredOut++;
      continue;
    }

    const key = `${row.instanceType}|${row.os}`;
    const existing = rows.get(key);
    // If duplicates slip through the filters above, keep the cheapest one.
    if (!existing || row.pricePerHour < existing.pricePerHour) {
      rows.set(key, row);
    }
  }

  // An instance type only counts as "excluded" for messaging purposes if it never made
  // it into `rows` at all (belt-and-suspenders: favor showing a real row over an
  // exclusion message if a type somehow ended up in both).
  for (const row of rows.values()) {
    excludedTypes.delete(row.instanceType);
  }

  const instances = [...rows.values()].sort((a, b) =>
    a.instanceType === b.instanceType ? a.os.localeCompare(b.os) : a.instanceType.localeCompare(b.instanceType)
  );
  const excludedTypesObj = Object.fromEntries(
    [...excludedTypes.entries()].sort(([a], [b]) => a.localeCompare(b))
  );

  return { instances, excludedTypes: excludedTypesObj, seen, excluded, filteredOut, noPrice };
}

async function main() {
  console.log("Fetching region index...");
  const regionIndex = await fetchJsonWithRetry(REGION_INDEX_URL);

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const summary = [];

  for (const { code, name } of REGIONS) {
    const meta = regionIndex.regions && regionIndex.regions[code];
    if (!meta) {
      console.warn(`[${code}] skipping: not present in AWS's region index (may have been retired).`);
      continue;
    }

    const outPath = path.join(OUTPUT_DIR, `${code}.json`);
    const offerUrl = PRICING_HOST + meta.currentVersionUrl;
    console.log(`[${code}] fetching offer file...`);

    try {
      const offer = await fetchJsonWithRetry(offerUrl);
      const { instances, excludedTypes, seen, excluded, filteredOut, noPrice } =
        trimOfferProducts(offer);
      const generatedAt = new Date().toISOString();

      const output = {
        generatedAt,
        region: code,
        regionName: name,
        source: "AWS Price List Bulk API",
        instances,
        excludedTypes,
      };

      fs.writeFileSync(outPath, JSON.stringify(output));
      console.log(
        `[${code}] rows: ${instances.length} (seen ${seen}, excluded ${excluded}, filtered ${filteredOut}, no-price ${noPrice})`
      );
      summary.push({ code, name, instanceCount: instances.length, generatedAt });
    } catch (err) {
      console.error(`[${code}] FAILED: ${err.message}`);
      // A transient failure for one region shouldn't nuke that region's last-known-good
      // data or fail the whole run — keep whatever was committed before and flag it stale.
      if (fs.existsSync(outPath)) {
        try {
          const prev = JSON.parse(fs.readFileSync(outPath, "utf8"));
          summary.push({
            code,
            name,
            instanceCount: prev.instances.length,
            generatedAt: prev.generatedAt,
            stale: true,
          });
          console.warn(`[${code}] keeping previous data from ${prev.generatedAt}`);
        } catch {
          summary.push({ code, name, instanceCount: 0, generatedAt: null, failed: true });
        }
      } else {
        summary.push({ code, name, instanceCount: 0, generatedAt: null, failed: true });
      }
    }

    // These offer files are large (up to ~500MB parsed); encourage V8 to reclaim that
    // memory between regions rather than letting peak usage climb across the loop.
    // (No-op unless run with --expose-gc, which the workflow sets.)
    if (global.gc) global.gc();
  }

  summary.sort((a, b) => a.code.localeCompare(b.code));
  fs.writeFileSync(
    path.join(OUTPUT_DIR, "index.json"),
    JSON.stringify({ generatedAt: new Date().toISOString(), regions: summary })
  );

  const okCount = summary.filter((r) => !r.failed).length;
  console.log(`Done. ${okCount}/${summary.length} regions have usable data.`);
  if (okCount === 0) {
    throw new Error("Every region failed to refresh — aborting so a bad run doesn't get committed as if it succeeded.");
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { trimOfferProducts, fetchJsonWithRetry, main };
