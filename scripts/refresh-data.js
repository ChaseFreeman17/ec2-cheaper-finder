#!/usr/bin/env node
// Fetches the AWS Price List Bulk API offer file for EC2 in us-east-1, trims it down to
// the current-generation, non-accelerated, On-Demand rows the site needs, and writes
// data/instances.json. See docs/SPEC.md and docs/adr/0002-*.md for why this source and
// this shape.
//
// No AWS credentials required — this hits the public pricing.*.amazonaws.com bulk JSON
// endpoints over plain HTTPS.

const fs = require("fs");
const path = require("path");

const REGION = "us-east-1";
const REGION_INDEX_URL =
  "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonEC2/current/region_index.json";
const PRICING_HOST = "https://pricing.us-east-1.amazonaws.com";
const OUTPUT_PATH = path.join(__dirname, "..", "data", "instances.json");

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

function parseMemoryGiB(memoryAttr) {
  // e.g. "7.5 GiB", "1024.0 GiB", "1,952 GiB"
  const cleaned = String(memoryAttr).replace(/,/g, "").replace(/GiB/i, "").trim();
  return parseFloat(cleaned);
}

function isBurstable(instanceType) {
  const family = instanceType.split(".")[0];
  return /^t\d/i.test(family);
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
  return (
    attrs.currentGeneration === "Yes" &&
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

async function main() {
  console.log(`Fetching region index...`);
  const regionIndex = await fetchJson(REGION_INDEX_URL);
  const region = regionIndex.regions && regionIndex.regions[REGION];
  if (!region) throw new Error(`Region ${REGION} not found in region index`);

  const offerUrl = PRICING_HOST + region.currentVersionUrl;
  console.log(`Fetching offer file: ${offerUrl}`);
  const offer = await fetchJson(offerUrl);

  const products = offer.products || {};
  const terms = offer.terms || {};

  const rows = new Map(); // key: `${instanceType}|${os}` -> row
  // Instance types that exist in AWS's data but are deliberately left out of `rows`,
  // so the UI can explain *why* a lookup came back empty instead of just saying
  // "not found". Reason wins the first time we see that instance type; later SKUs for
  // the same type (different OS, etc.) don't overwrite it.
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

    if (instanceType && attrs.currentGeneration === "No" && !excludedTypes.has(instanceType)) {
      excludedTypes.set(instanceType, "previous-generation");
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
      pricePerHour: price,
      networkPerformance: attrs.networkPerformance || "Unknown",
      dedicatedEbsThroughput:
        attrs.dedicatedEbsThroughput || attrs.dedicatedEbsThroughputDescription || "Not supported",
      storageType: attrs.storage === "EBS only" ? "EBS-only" : "instance-store",
      burstable: isBurstable(attrs.instanceType),
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
  // it into `rows` at all (e.g. a GPU type never has a qualifying row; a previous-gen
  // type might still slip in if our currentGeneration read was wrong for one SKU but
  // not another — favor showing real rows over an exclusion message).
  for (const row of rows.values()) {
    excludedTypes.delete(row.instanceType);
  }

  const output = {
    generatedAt: new Date().toISOString(),
    region: REGION,
    source: "AWS Price List Bulk API",
    instances: [...rows.values()].sort((a, b) =>
      a.instanceType === b.instanceType ? a.os.localeCompare(b.os) : a.instanceType.localeCompare(b.instanceType)
    ),
    excludedTypes: Object.fromEntries(
      [...excludedTypes.entries()].sort(([a], [b]) => a.localeCompare(b))
    ),
  };

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output));

  console.log(`Products seen: ${seen}`);
  console.log(`Excluded (accelerator/bare-metal/non-instance): ${excluded}`);
  console.log(`Filtered out (gen/tenancy/license/os/etc): ${filteredOut}`);
  console.log(`No on-demand price found: ${noPrice}`);
  console.log(`Rows written: ${output.instances.length} -> ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
