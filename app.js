// EC2 Undercut — client-side matching against the pre-trimmed, per-region files in
// data/regions/ (see scripts/refresh-data.js and docs/SPEC.md for how those are built).
//
// data/regions/index.json is small and loaded once at startup to populate the region
// picker. Each data/regions/<code>.json is loaded lazily — only when that region is
// selected — and cached in memory so switching back to a region already viewed this
// session doesn't re-fetch it. See docs/adr/0004-multi-region-per-region-data-files.md.

const EXCLUSION_MESSAGES = {
  "accelerated":
    "it's a GPU, FPGA, or inference/training-chip instance type. Accelerators aren't a minor difference like network throughput — we don't recommend dropping one to save money, so these are left out of comparisons entirely.",
  "bare-metal":
    "it's a bare-metal instance type, which gives direct hardware access that a regular instance can't replicate — so it's left out of comparisons entirely.",
  "not-a-standard-instance":
    "it isn't a standard compute instance type (e.g. a dedicated host or another non-instance line item).",
};

// Both mechanisms mean "CPU performance isn't fixed" and get the same prominent
// highlight — see CONTEXT.md's "Burst-capable" entry for why these are distinct from
// (and more important than) the other flagged differences.
const BURST_KIND_INFO = {
  credit: {
    label: "Burstable (credits)",
    tooltip:
      "T-family: earns CPU credits while below its baseline and spends them while bursting above it. Running out of credits throttles it hard to baseline.",
  },
  flex: {
    label: "Flex (baseline/burst)",
    tooltip:
      "~40% baseline CPU, can burst to 100% for up to 95% of a rolling 24-hour window. Sustained high utilization gradually reduces burst throughput (no hard credit cliff).",
  },
};

const GITHUB_REPO = "ChaseFreeman17/ec2-undercut"; // for the footer's live-version link — see loadSiteVersion()
const DEFAULT_REGION = "us-east-1";
const MAX_COMBOBOX_RESULTS = 30;
const MAX_BULK_TYPES = 300; // soft cap so a pathological paste can't freeze the tab

const state = {
  regionsIndex: null, // { generatedAt, regions: [{code, name, instanceCount, generatedAt, stale?, failed?}] }
  regionCache: new Map(), // code -> { generatedAt, region, regionName, source, instances, excludedTypes }
  currentRegion: null,
  instanceTypeOptions: [], // [{ type, excluded: reason|null }], for the current region
  mode: "single", // "single" | "bulk" — see setMode()
  bulkRows: [], // last bulk-lookup result, kept around so sort/filter changes can re-render without re-searching
  bulkSort: { key: null, dir: "desc" }, // "savings" | "fleet-savings" | null — persists across bulk searches
  bulkFilters: { hideNonActionable: false, minSavingsPercent: 0 }, // persists across bulk searches, like bulkSort
};

const combo = {
  open: false,
  activeIndex: -1,
  filtered: [], // subset of state.instanceTypeOptions currently shown
};

const els = {};

function byId(id) {
  return document.getElementById(id);
}

function cacheEls() {
  els.form = byId("search-form");
  els.regionSelect = byId("region-select");
  els.input = byId("instance-type");
  els.comboList = byId("instance-type-list");
  els.singleModeField = byId("single-mode-field");
  els.bulkTextarea = byId("bulk-instance-types");
  els.bulkModeField = byId("bulk-mode-field");
  els.bulkFileInput = byId("bulk-file-input");
  els.specsModeField = byId("specs-mode-field");
  els.specsVcpu = byId("specs-vcpu");
  els.specsRam = byId("specs-ram");
  els.instanceLabel = byId("instance-label");
  els.modeTabs = document.querySelectorAll(".mode-tab");
  els.submitBtn = byId("submit-btn");
  els.osWindows = byId("os-windows");
  els.osLinux = byId("os-linux");
  els.burstable = byId("burstable-toggle");
  els.burstableMatchOnly = byId("burstable-match-only");
  els.burstableMatchOnlyLabel = byId("burstable-match-only-label");
  els.graviton = byId("graviton-toggle");
  els.status = byId("status");
  els.results = byId("results");
  els.freshness = byId("data-freshness");
  els.resetBtn = byId("reset-btn");
  els.siteVersion = byId("site-version");
}

async function fetchJson(url) {
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error(`Failed to load ${url}: ${res.status}`);
  return res.json();
}

function loadRegionsIndex() {
  return fetchJson("data/regions/index.json");
}

async function loadRegionData(code) {
  if (state.regionCache.has(code)) return state.regionCache.get(code);
  const data = await fetchJson(`data/regions/${code}.json`);
  state.regionCache.set(code, data);
  return data;
}

function pickDefaultRegion(regionsIndex) {
  const available = regionsIndex.regions.filter((r) => !r.failed);
  const codes = new Set(available.map((r) => r.code));
  if (codes.has(DEFAULT_REGION)) return DEFAULT_REGION;
  return available[0] ? available[0].code : DEFAULT_REGION;
}

function populateRegionSelect(regionsIndex) {
  els.regionSelect.innerHTML = "";
  const available = regionsIndex.regions.filter((r) => !r.failed); // never had usable data

  const groups = new Map(); // group label -> regions[]
  for (const r of available) {
    const group = r.group || "Other";
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(r);
  }

  const groupNames = [...groups.keys()].sort((a, b) => a.localeCompare(b));
  for (const groupName of groupNames) {
    const regions = groups.get(groupName).sort((a, b) => a.name.localeCompare(b.name));
    const optgroup = el("optgroup", { label: groupName }, []);
    for (const r of regions) {
      const label = r.stale ? `${r.name} (data delayed)` : r.name;
      optgroup.appendChild(el("option", { value: r.code, text: label }));
    }
    els.regionSelect.appendChild(optgroup);
  }
}

function findBaselineRow(instances, instanceType, os) {
  const needle = instanceType.trim().toLowerCase();
  return instances.find(
    (r) => r.instanceType.toLowerCase() === needle && r.os === os
  );
}

function anyRowMatchesType(instances, instanceType) {
  const needle = instanceType.trim().toLowerCase();
  return instances.some((r) => r.instanceType.toLowerCase() === needle);
}

function findExcludedReason(excludedTypes, instanceType) {
  const needle = instanceType.trim().toLowerCase();
  for (const [type, reason] of Object.entries(excludedTypes)) {
    if (type.toLowerCase() === needle) return reason;
  }
  return null;
}

function findMatches(instances, baseline, includeGraviton, includeBurstable, burstableMatchOnly) {
  return instances
    .filter((r) => {
      if (r.os !== baseline.os) return false;
      if (r.instanceType === baseline.instanceType) return false;
      if (!r.currentGeneration) return false; // candidates are always current-gen
      // vCPU/RAM only need to be at least the baseline's, never less — see CONTEXT.md's
      // "Match" entry for why (previous-gen baselines can have odd legacy memory sizes,
      // e.g. c3.2xlarge's 15 GiB, that no current-gen type hits exactly).
      if (r.vcpu < baseline.vcpu) return false;
      if (r.memoryGiB < baseline.memoryGiB) return false;
      if (r.architecture === "arm64" && !includeGraviton) return false;
      // Both toggles only filter candidates, not the baseline — a burstable baseline is
      // still searched normally even with "include burstable" off. burstableMatchOnly is
      // the stricter, opt-in refinement of includeBurstable: don't just allow burstable
      // candidates, only suggest one if the baseline itself is already burstable — so a
      // fixed-performance baseline (m5, c5, r5, ...) never gets switched onto shared/
      // bursting CPU as a "cheaper" option.
      if (r.burstKind) {
        if (!includeBurstable) return false;
        if (burstableMatchOnly && !baseline.burstKind) return false;
      }
      if (!(r.pricePerHour < baseline.pricePerHour)) return false;
      return true;
    })
    .sort((a, b) => a.pricePerHour - b.pricePerHour);
}

// Same shape as findMatches, but for the "search by specs" mode: there's no baseline
// instance to be strictly cheaper than, so this just lists every current-generation type
// meeting the given minimums, cheapest first.
function findSpecMatches(instances, minVcpu, minMemoryGiB, os, includeGraviton, includeBurstable) {
  return instances
    .filter((r) => {
      if (r.os !== os) return false;
      if (!r.currentGeneration) return false;
      if (r.vcpu < minVcpu) return false;
      if (r.memoryGiB < minMemoryGiB) return false;
      if (r.architecture === "arm64" && !includeGraviton) return false;
      if (r.burstKind && !includeBurstable) return false;
      return true;
    })
    .sort((a, b) => a.pricePerHour - b.pricePerHour);
}

// Best-effort numeric parsing for AWS's free-text bandwidth fields, so flagged
// differences can be colored by whether they're an improvement or a regression rather
// than left as a flat neutral gray. Returns Mbps, or null if the text doesn't parse (in
// which case the flag falls back to neutral — we'd rather show "unknown direction" than
// guess wrong).
function parseNetworkMbps(text) {
  if (!text) return null;
  const numMatch = text.match(/([\d,.]+)\s*(gigabit|megabit)/i);
  if (numMatch) {
    const num = parseFloat(numMatch[1].replace(/,/g, ""));
    return /gigabit/i.test(numMatch[2]) ? num * 1000 : num;
  }
  const qualitative = {
    "very low": 0.5,
    low: 1,
    "low to moderate": 1.5,
    moderate: 2,
    "moderate to high": 2.5,
    high: 3,
  };
  const key = text.trim().toLowerCase();
  return key in qualitative ? qualitative[key] : null;
}

function parseEbsMbps(text) {
  if (!text) return null;
  const m = text.match(/([\d,.]+)\s*mbps/i);
  return m ? parseFloat(m[1].replace(/,/g, "")) : null;
}

// "better"/"worse" drives the green/orange coloring in the UI; "neutral" covers changes
// with no universally-agreed direction (storage type, architecture) or ones we couldn't
// parse a number out of.
function compareDirection(baselineVal, candidateVal) {
  if (baselineVal == null || candidateVal == null) return "neutral";
  if (candidateVal > baselineVal) return "better";
  if (candidateVal < baselineVal) return "worse";
  return "neutral";
}

function flaggedDifferences(baseline, candidate) {
  const flags = [];
  if (candidate.vcpu !== baseline.vcpu) {
    // Matching only ever surfaces candidates with vcpu >= baseline, so a flagged vCPU
    // difference is always extra headroom, never less.
    flags.push({ label: "vCPU", text: `${baseline.vcpu} → ${candidate.vcpu}`, direction: "better" });
  }
  if (candidate.memoryGiB !== baseline.memoryGiB) {
    flags.push({
      label: "RAM",
      text: `${baseline.memoryGiB} GiB → ${candidate.memoryGiB} GiB`,
      direction: "better",
    });
  }
  if (candidate.networkPerformance !== baseline.networkPerformance) {
    flags.push({
      label: "Network",
      text: `${baseline.networkPerformance} → ${candidate.networkPerformance}`,
      direction: compareDirection(
        parseNetworkMbps(baseline.networkPerformance),
        parseNetworkMbps(candidate.networkPerformance)
      ),
    });
  }
  if (candidate.dedicatedEbsThroughput !== baseline.dedicatedEbsThroughput) {
    flags.push({
      label: "EBS bandwidth",
      text: `${baseline.dedicatedEbsThroughput} → ${candidate.dedicatedEbsThroughput}`,
      direction: compareDirection(
        parseEbsMbps(baseline.dedicatedEbsThroughput),
        parseEbsMbps(candidate.dedicatedEbsThroughput)
      ),
    });
  }
  if (candidate.storageType !== baseline.storageType) {
    // EBS-only vs. instance-store isn't a strict upgrade/downgrade either direction
    // (instance-store is faster but ephemeral) — left neutral rather than guessing.
    flags.push({
      label: "Storage",
      text: `${baseline.storageType} → ${candidate.storageType}`,
      direction: "neutral",
    });
  }
  // Burst-capable candidates get their own prominent badge (see renderBurstBadge)
  // instead of being buried in this generic list — CPU credit/flex throttling is a
  // bigger behavioral gotcha than a peripheral spec difference.
  if (candidate.architecture !== baseline.architecture) {
    flags.push({
      label: "Architecture",
      text: `${baseline.architecture} → ${candidate.architecture}`,
      direction: "neutral",
    });
  }
  return flags;
}

function renderBurstBadge(row) {
  if (!row.burstKind) return null;
  const info = BURST_KIND_INFO[row.burstKind];
  return el("span", { class: "pill pill-warning small", title: info.tooltip, text: `⚡ ${info.label}` });
}

function formatMoney(n) {
  return `$${n.toFixed(4).replace(/0+$/, "").replace(/\.$/, ".0")}/hr`;
}

// Hourly savings alone are hard to feel the scale of, so results also show projected
// monthly/yearly savings assuming the instance runs continuously — the same 730-hr/month,
// 8,760-hr/year averages AWS's own pricing calculator uses.
const HOURS_PER_MONTH = 730;
const HOURS_PER_YEAR = 8760;

function formatMoneyCompact(n) {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// `count` scales this to a fleet-wide total (bulk mode, when a line's count > 1) rather
// than a single instance's projection — single/specs mode calls this with no count, so
// the multiplier stays 1 and behavior is unchanged there.
function renderProjectedSavings(savingsPerHour, count) {
  const multiplier = count && count > 1 ? count : 1;
  const perUnitMonthly = savingsPerHour * HOURS_PER_MONTH;
  const perUnitYearly = savingsPerHour * HOURS_PER_YEAR;

  if (multiplier === 1) {
    return el("td", { class: "savings-projected" }, [
      el("span", { class: "savings-monthly", text: `${formatMoneyCompact(perUnitMonthly)}/mo` }),
      el("span", { class: "savings-yearly", text: `${formatMoneyCompact(perUnitYearly)}/yr` }),
    ]);
  }

  // Fleet-scaled: spell out the actual multiplication (per-instance amount × count =
  // total) rather than just tacking on a "× N instances" note next to the total — the
  // note alone didn't show what was being multiplied, only that something was.
  return el("td", { class: "savings-projected" }, [
    el("span", { class: "savings-monthly" }, [
      el("span", { class: "savings-math-unit", text: `${formatMoneyCompact(perUnitMonthly)}/mo × ${multiplier} = ` }),
      el("span", { class: "savings-math-total", text: `${formatMoneyCompact(perUnitMonthly * multiplier)}/mo` }),
    ]),
    el("span", { class: "savings-yearly" }, [
      el("span", { class: "savings-math-unit", text: `${formatMoneyCompact(perUnitYearly)}/yr × ${multiplier} = ` }),
      el("span", { class: "savings-math-total", text: `${formatMoneyCompact(perUnitYearly * multiplier)}/yr` }),
    ]),
  ]);
}

function el(tag, attrs, children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else node.setAttribute(k, v);
    }
  }
  for (const child of children || []) {
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

function renderBaselineCard(baseline) {
  const titleParts = [
    el("strong", { text: baseline.instanceType }),
    el("span", { class: "pill", text: baseline.os }),
    el("span", { class: "pill pill-muted", text: baseline.architecture }),
  ];
  if (!baseline.currentGeneration) {
    titleParts.push(el("span", { class: "pill pill-muted", text: "Previous-gen" }));
  }
  const baselineBurstBadge = renderBurstBadge(baseline);
  if (baselineBurstBadge) titleParts.push(baselineBurstBadge);

  const card = el("div", { class: "baseline-card" }, [
    el("div", { class: "baseline-title" }, titleParts),
    el("div", { class: "baseline-specs" }, [
      el("span", { text: `${baseline.vcpu} vCPU` }),
      el("span", { text: `${baseline.memoryGiB} GiB RAM` }),
      el("span", { text: formatMoney(baseline.pricePerHour) }),
    ]),
  ]);

  if (!baseline.currentGeneration) {
    card.appendChild(
      el("p", {
        class: "prev-gen-note",
        text: "This is a previous-generation instance type — results below are current-generation replacements.",
      })
    );
  }

  return card;
}

function renderResultsTable(baseline, matches) {
  if (matches.length === 0) {
    return el("p", { class: "empty-note", text: "No cheaper equivalent found for this configuration." });
  }

  const table = el("table", { class: "results-table" }, []);
  const thead = el("thead", null, [
    el("tr", null, [
      el("th", { text: "Instance type" }),
      el("th", { text: "Price" }),
      el("th", { text: "Savings" }),
      el("th", { title: "Assumes the instance runs continuously (730 hrs/month, 8,760 hrs/year)", text: "Projected savings" }),
      el("th", { text: "What changes" }),
    ]),
  ]);
  const tbody = el("tbody", null, []);

  for (const candidate of matches) {
    const savingsPerHour = baseline.pricePerHour - candidate.pricePerHour;
    const savingsPercent = (savingsPerHour / baseline.pricePerHour) * 100;
    const flags = flaggedDifferences(baseline, candidate);

    const flagsCell = el("td", null, []);
    if (flags.length === 0) {
      flagsCell.appendChild(el("span", { class: "no-diff", text: "No flagged differences" }));
    } else {
      for (const flag of flags) {
        flagsCell.appendChild(
          el("span", { class: `diff-badge diff-badge-${flag.direction}`, title: flag.text }, [
            el("strong", { text: flag.label + ": " }),
            document.createTextNode(flag.text),
          ])
        );
      }
    }

    const typeCell = el("td", null, [
      el("strong", { text: candidate.instanceType }),
      el("span", { class: "pill pill-muted small", text: candidate.architecture }),
    ]);
    const burstBadge = renderBurstBadge(candidate);
    if (burstBadge) typeCell.appendChild(burstBadge);

    tbody.appendChild(
      el("tr", { class: candidate.burstKind ? "burst-row" : "" }, [
        typeCell,
        el("td", { text: formatMoney(candidate.pricePerHour) }),
        el("td", { class: "savings" }, [
          el("span", { class: "savings-abs", text: `-${formatMoney(savingsPerHour)}` }),
          el("span", { class: "savings-pct", text: `-${savingsPercent.toFixed(0)}%` }),
        ]),
        renderProjectedSavings(savingsPerHour),
        flagsCell,
      ])
    );
  }

  table.appendChild(thead);
  table.appendChild(tbody);
  return table;
}

// "Search by specs" mode has no baseline to diff against or save against, so its table
// is just instance type / vCPU / RAM / price, cheapest first — no savings or flagged-
// differences columns.
function renderSpecsTable(matches) {
  if (matches.length === 0) {
    return el("p", { class: "empty-note", text: "No current-generation instance types meet these minimums." });
  }

  const table = el("table", { class: "results-table" }, []);
  const thead = el("thead", null, [
    el("tr", null, [
      el("th", { text: "Instance type" }),
      el("th", { text: "vCPU" }),
      el("th", { text: "RAM" }),
      el("th", { text: "Price" }),
    ]),
  ]);
  const tbody = el("tbody", null, []);

  for (const row of matches) {
    const typeCell = el("td", null, [
      el("strong", { text: row.instanceType }),
      el("span", { class: "pill pill-muted small", text: row.architecture }),
    ]);
    const burstBadge = renderBurstBadge(row);
    if (burstBadge) typeCell.appendChild(burstBadge);

    tbody.appendChild(
      el("tr", { class: row.burstKind ? "burst-row" : "" }, [
        typeCell,
        el("td", { text: String(row.vcpu) }),
        el("td", { text: `${row.memoryGiB} GiB` }),
        el("td", { text: formatMoney(row.pricePerHour) }),
      ])
    );
  }

  table.appendChild(thead);
  table.appendChild(tbody);
  return table;
}

function renderOsSection(osLabel, baseline, instances, includeGraviton, includeBurstable, burstableMatchOnly) {
  const section = el("div", { class: "os-section" }, [
    el("h2", { text: osLabel }),
  ]);

  if (!baseline) {
    section.appendChild(
      el("p", {
        class: "empty-note",
        text: `No ${osLabel} On-Demand pricing found for this instance type in this region.`,
      })
    );
    return section;
  }

  const matches = findMatches(instances, baseline, includeGraviton, includeBurstable, burstableMatchOnly);
  section.appendChild(renderBaselineCard(baseline));
  section.appendChild(renderResultsTable(baseline, matches));
  return section;
}

function showStatus(message, kind) {
  els.status.textContent = message;
  els.status.className = `status ${kind || ""}`.trim();
}

function clearResults() {
  els.results.hidden = true;
  els.results.innerHTML = "";
  state.bulkRows = [];
}

// ---- Instance-type combobox --------------------------------------------------------
// A hand-rolled autocomplete: plain free text doesn't validate as you go, and a native
// <select> with a few thousand instance types (across all regions) isn't browsable. This
// filters state.instanceTypeOptions (built fresh whenever the region changes) as the user
// types, with mouse + keyboard selection. Excluded types (GPU/bare-metal/etc.) stay in
// the list — muted, tagged "excluded" — so picking one still explains why, rather than
// just vanishing with no explanation.

function buildInstanceTypeOptions(regionData) {
  const seen = new Set();
  const options = [];
  for (const r of regionData.instances) {
    if (seen.has(r.instanceType)) continue;
    seen.add(r.instanceType);
    options.push({ type: r.instanceType, excluded: null });
  }
  for (const [type, reason] of Object.entries(regionData.excludedTypes || {})) {
    if (seen.has(type)) continue;
    seen.add(type);
    options.push({ type, excluded: reason });
  }
  options.sort((a, b) => a.type.localeCompare(b.type));
  state.instanceTypeOptions = options;
}

function filterInstanceOptions(query) {
  const q = query.trim().toLowerCase();
  const pool = q
    ? state.instanceTypeOptions.filter((o) => o.type.toLowerCase().includes(q))
    : state.instanceTypeOptions;
  return pool.slice(0, MAX_COMBOBOX_RESULTS);
}

function renderCombobox() {
  els.comboList.innerHTML = "";
  combo.filtered.forEach((opt, i) => {
    const children = [el("span", { class: "combobox-type", text: opt.type })];
    if (opt.excluded) children.push(el("span", { class: "combobox-tag", text: "Excluded" }));
    const li = el(
      "li",
      {
        role: "option",
        id: `instance-opt-${i}`,
        class: `combobox-option${i === combo.activeIndex ? " active" : ""}`,
      },
      children
    );
    // mousedown (not click) fires before the input's blur handler closes the list.
    li.addEventListener("mousedown", (e) => {
      e.preventDefault();
      selectComboOption(opt);
    });
    els.comboList.appendChild(li);
  });

  const shouldShow = combo.open && combo.filtered.length > 0;
  els.comboList.hidden = !shouldShow;
  els.input.setAttribute("aria-expanded", String(shouldShow));
  if (combo.activeIndex >= 0) {
    els.input.setAttribute("aria-activedescendant", `instance-opt-${combo.activeIndex}`);
  } else {
    els.input.removeAttribute("aria-activedescendant");
  }
}

function selectComboOption(opt) {
  els.input.value = opt.type;
  combo.open = false;
  combo.filtered = [];
  combo.activeIndex = -1;
  renderCombobox();
}

function onComboInput() {
  combo.filtered = filterInstanceOptions(els.input.value);
  combo.open = true;
  combo.activeIndex = -1;
  renderCombobox();
}

function onComboKeydown(e) {
  if (!combo.open) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") onComboInput();
    return;
  }
  if (e.key === "ArrowDown") {
    e.preventDefault();
    combo.activeIndex = Math.min(combo.activeIndex + 1, combo.filtered.length - 1);
    renderCombobox();
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    combo.activeIndex = Math.max(combo.activeIndex - 1, 0);
    renderCombobox();
  } else if (e.key === "Enter") {
    if (combo.activeIndex >= 0) {
      e.preventDefault();
      selectComboOption(combo.filtered[combo.activeIndex]);
    } else {
      combo.open = false;
      renderCombobox();
    }
  } else if (e.key === "Escape") {
    combo.open = false;
    combo.activeIndex = -1;
    renderCombobox();
  }
}

function onComboBlur() {
  // Let a pending mousedown-selection run first (see renderCombobox's listener).
  setTimeout(() => {
    combo.open = false;
    renderCombobox();
  }, 0);
}

// ---- Region loading -----------------------------------------------------------------

async function setRegion(code) {
  state.currentRegion = code;
  showStatus("", "");
  clearResults();
  els.freshness.textContent = "Loading pricing data…";

  try {
    const data = await loadRegionData(code);
    renderFreshness(data);
    buildInstanceTypeOptions(data);
  } catch (err) {
    console.error(err);
    state.instanceTypeOptions = [];
    els.freshness.textContent = "Couldn't load pricing data for this region. Try again.";
    showStatus("Pricing data failed to load for this region, so searches won't work right now.", "error");
  }
}

// ---- Mode switching (single lookup vs. bulk lookup vs. spec search) -----------------

const MODE_LABELS = {
  single: "Baseline instance type",
  bulk: "Instance types (one per line)",
  specs: "Minimum specs",
};

const MODE_SUBMIT_LABELS = {
  single: "Find cheaper equivalents",
  bulk: "Find cheaper equivalents for all",
  specs: "Find matching instance types",
};

function setMode(mode) {
  state.mode = mode;
  els.singleModeField.hidden = mode !== "single";
  els.bulkModeField.hidden = mode !== "bulk";
  els.specsModeField.hidden = mode !== "specs";
  els.instanceLabel.textContent = MODE_LABELS[mode];
  els.submitBtn.textContent = MODE_SUBMIT_LABELS[mode];
  els.modeTabs.forEach((btn) => {
    const active = btn.dataset.mode === mode;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-selected", String(active));
  });
  clearResults();
  showStatus("", "");
}

// ---- Bulk lookup ----------------------------------------------------------------------
// Same matching logic as single lookup, run once per (instance type × selected OS) pair,
// condensed into one summary row each rather than the full baseline-card + table
// treatment (which doesn't scale to dozens of types). Click "Details" on any row to jump
// back to single mode with the full breakdown for that exact type/OS.

// Bulk mode accepts a "type" or "type,count" per line — count is optional and defaults
// to 1, so a plain list of instance types (the original bulk-mode format) still works
// unchanged. Tolerant of tabs or runs of spaces as the delimiter too (common when
// pasting a column out of a spreadsheet), a leading "#" comment line, and a one-line
// CSV/TSV header (detected by its first cell not looking like an instance type — no
// "."). See docs/SPEC.md for the full format. Duplicate types are summed rather than
// dropped, since a real fleet export can legitimately list the same type on more than
// one line (e.g. split across AZs).
function parseFleetInput(text) {
  const merged = new Map(); // lowercased type -> { type, count, invalidCount }
  let sawDataLine = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;

    const cells = (line.includes(",") ? line.split(",") : line.split(/\s+/)).map((c) =>
      c.trim().replace(/^"|"$/g, "")
    );
    const type = cells[0] || "";
    if (!type) continue;

    if (!sawDataLine) {
      sawDataLine = true;
      if (!type.includes(".")) continue; // looks like a header row, e.g. "instance_type,count"
    }

    const countRaw = (cells[1] || "").trim();
    let count = 1;
    let invalidCount = false;
    if (countRaw) {
      const n = parseInt(countRaw, 10);
      if (Number.isFinite(n) && n > 0) count = n;
      else invalidCount = true; // non-numeric or <= 0 — kept at count 1, flagged for the UI
    }

    const key = type.toLowerCase();
    const existing = merged.get(key);
    if (existing) {
      existing.count += count;
      existing.invalidCount = existing.invalidCount || invalidCount;
    } else {
      merged.set(key, { type, count, invalidCount });
    }
  }
  return [...merged.values()];
}

function runBulkLookup(entries, osSelections, instances, excludedTypes, includeGraviton, includeBurstable, burstableMatchOnly) {
  const rows = [];
  for (const { type: inputType, count, invalidCount } of entries) {
    if (!anyRowMatchesType(instances, inputType)) {
      const reason = findExcludedReason(excludedTypes, inputType);
      rows.push({ inputType, kind: reason ? "excluded" : "not-found", reason, count });
      continue;
    }
    for (const os of osSelections) {
      const baseline = findBaselineRow(instances, inputType, os);
      if (!baseline) {
        rows.push({ inputType, os, kind: "no-os", count });
        continue;
      }
      const matches = findMatches(instances, baseline, includeGraviton, includeBurstable, burstableMatchOnly);
      if (matches.length === 0) {
        rows.push({ inputType, os, kind: "no-match", baseline, count });
      } else {
        rows.push({
          inputType, os, kind: "match", baseline,
          best: matches[0], matchCount: matches.length, count, invalidCount,
        });
      }
    }
  }
  return rows;
}

// The aggregate fleet-wide picture shown above the bulk table: current cost, optimized
// cost (using each matched line's cheapest candidate, or its own price again when no
// cheaper option exists), and the resulting savings — every line weighted by its count.
// Only "match"/"no-match" rows carry a real price to sum (excluded/not-found/no-os rows
// don't), so those are the only kinds counted toward the totals.
function computeFleetSummary(rows) {
  let currentHourly = 0;
  let optimizedHourly = 0;
  let pricedInstanceCount = 0;
  let pricedLines = 0;
  let cheaperLines = 0;

  for (const row of rows) {
    if (row.kind !== "match" && row.kind !== "no-match") continue;
    const baselinePrice = row.baseline.pricePerHour;
    const bestPrice = row.kind === "match" ? row.best.pricePerHour : baselinePrice;
    currentHourly += baselinePrice * row.count;
    optimizedHourly += bestPrice * row.count;
    pricedInstanceCount += row.count;
    pricedLines++;
    if (row.kind === "match") cheaperLines++;
  }

  return { currentHourly, optimizedHourly, pricedInstanceCount, pricedLines, cheaperLines };
}

function escapeCsvCell(value) {
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function buildFleetReportCsv(rows) {
  const header = [
    "Instance type", "OS", "Count", "Price/hr", "Best match", "Match price/hr",
    "Savings/hr", "Savings %", "Fleet savings/mo", "Fleet savings/yr", "Note",
  ];
  const lines = [header.map(escapeCsvCell).join(",")];

  for (const row of rows) {
    if (row.kind === "not-found" || row.kind === "excluded") {
      const note =
        row.kind === "excluded"
          ? `Excluded — ${EXCLUSION_MESSAGES[row.reason] || "outside this tool's scope"}`
          : "Not recognized in this region";
      lines.push([row.inputType, "", row.count, "", "", "", "", "", "", "", note].map(escapeCsvCell).join(","));
      continue;
    }
    if (row.kind === "no-os") {
      lines.push(
        [row.inputType, row.os, row.count, "", "", "", "", "", "", "", `No ${row.os} pricing found`]
          .map(escapeCsvCell)
          .join(",")
      );
      continue;
    }
    if (row.kind === "no-match") {
      lines.push(
        [row.baseline.instanceType, row.os, row.count, row.baseline.pricePerHour.toFixed(4), "", "", "", "", "", "", "No cheaper equivalent found"]
          .map(escapeCsvCell)
          .join(",")
      );
      continue;
    }
    const { baseline, best, count } = row;
    const savingsPerHour = baseline.pricePerHour - best.pricePerHour;
    const savingsPercent = (savingsPerHour / baseline.pricePerHour) * 100;
    lines.push(
      [
        baseline.instanceType, row.os, count, baseline.pricePerHour.toFixed(4),
        best.instanceType, best.pricePerHour.toFixed(4),
        savingsPerHour.toFixed(4), savingsPercent.toFixed(1),
        (savingsPerHour * HOURS_PER_MONTH * count).toFixed(2),
        (savingsPerHour * HOURS_PER_YEAR * count).toFixed(2),
        row.invalidCount ? "Count wasn't a valid number on the input line — treated as 1" : "",
      ]
        .map(escapeCsvCell)
        .join(",")
    );
  }
  return lines.join("\r\n");
}

function downloadCsv(filename, csvText) {
  const blob = new Blob([csvText], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function renderFleetSummary(rows) {
  const s = computeFleetSummary(rows);
  if (s.pricedLines === 0) return null; // nothing priced — nothing to summarize

  const savingsHourly = s.currentHourly - s.optimizedHourly;
  const savingsPercent = s.currentHourly > 0 ? (savingsHourly / s.currentHourly) * 100 : 0;

  const tiles = [
    el("div", { class: "stat-tile" }, [
      el("span", { class: "stat-tile-label", text: "Current cost" }),
      el("span", { class: "stat-tile-value", text: `${formatMoneyCompact(s.currentHourly * HOURS_PER_MONTH)}/mo` }),
    ]),
    el("div", { class: "stat-tile" }, [
      el("span", { class: "stat-tile-label", text: "Optimized cost" }),
      el("span", { class: "stat-tile-value", text: `${formatMoneyCompact(s.optimizedHourly * HOURS_PER_MONTH)}/mo` }),
    ]),
    el("div", { class: "stat-tile" }, [
      el("span", { class: "stat-tile-label", text: "Monthly savings" }),
      el("span", { class: "stat-tile-value stat-tile-value-success", text: `${formatMoneyCompact(savingsHourly * HOURS_PER_MONTH)}/mo` }),
      el("span", { class: "stat-tile-delta", text: `-${savingsPercent.toFixed(0)}%` }),
    ]),
    el("div", { class: "stat-tile" }, [
      el("span", { class: "stat-tile-label", text: "Yearly savings" }),
      el("span", { class: "stat-tile-value stat-tile-value-success", text: `${formatMoneyCompact(savingsHourly * HOURS_PER_YEAR)}/yr` }),
    ]),
  ];

  const note = el("p", { class: "fleet-summary-note" }, [
    `Across ${s.pricedInstanceCount.toLocaleString()} priced instance${s.pricedInstanceCount === 1 ? "" : "s"} — ${s.cheaperLines} of ${s.pricedLines} entries have a cheaper current-generation option.`,
  ]);

  const downloadBtn = el("button", { type: "button", class: "fleet-download-btn" }, ["Download report (CSV)"]);
  downloadBtn.addEventListener("click", () => downloadCsv("ec2-undercut-fleet-report.csv", buildFleetReportCsv(rows)));

  return el("div", { class: "fleet-summary" }, [el("div", { class: "stat-tile-row" }, tiles), note, downloadBtn]);
}

// "Import CSV" reads the file straight into the textarea (rather than parsing it
// directly) so the fleet list stays visible and editable before submitting, same as if
// it had been pasted in by hand.
function handleBulkFileImport(event) {
  const file = event.target.files && event.target.files[0];
  event.target.value = ""; // clear now so re-picking the same file still fires "change"
  if (!file) return;

  const reader = new FileReader();
  reader.onload = () => {
    els.bulkTextarea.value = String(reader.result || "");
    showStatus(`Loaded ${file.name} — review the list below, then submit.`, "");
  };
  reader.onerror = () => showStatus(`Couldn't read ${file.name}.`, "error");
  reader.readAsText(file);
}

function viewDetails(instanceType, os) {
  setMode("single");
  els.input.value = instanceType;
  els.osWindows.checked = os === "Windows";
  els.osLinux.checked = os === "Linux";
  runSearch(true);
  els.form.scrollIntoView({ behavior: "smooth", block: "start" });
}

// ---- Bulk table sorting --------------------------------------------------------------
// Only "match" rows have a real savings figure to rank by — everything else (excluded,
// not-found, no-os, no-match) has nothing to compare and always sinks to the bottom,
// in its original order, regardless of sort direction.
const BULK_SORT_VALUE = {
  savings: (row) => (row.kind === "match" ? row.baseline.pricePerHour - row.best.pricePerHour : null),
  "fleet-savings": (row) =>
    row.kind === "match" ? (row.baseline.pricePerHour - row.best.pricePerHour) * row.count : null,
};

function sortBulkRows(rows, sort) {
  if (!sort || !sort.key) return rows;
  const getValue = BULK_SORT_VALUE[sort.key];
  const dir = sort.dir === "asc" ? 1 : -1;
  const ranked = [];
  const unranked = [];
  for (const row of rows) {
    const value = getValue(row);
    if (value === null) unranked.push(row);
    else ranked.push({ row, value });
  }
  ranked.sort((a, b) => (a.value - b.value) * dir);
  return [...ranked.map((r) => r.row), ...unranked];
}

// ---- Bulk table filtering -------------------------------------------------------------
// Two independent, combinable filters for narrowing a big fleet paste down to what's
// actually worth acting on — separate from sorting, which only reorders. Only "match"
// rows have a savings % to compare (see BULK_SORT_VALUE above for why), so a positive
// minSavingsPercent excludes every other kind too, same as hideNonActionable does.
function matchSavingsPercent(row) {
  if (row.kind !== "match") return null;
  return ((row.baseline.pricePerHour - row.best.pricePerHour) / row.baseline.pricePerHour) * 100;
}

function bulkRowPassesFilters(row, filters) {
  if (filters.hideNonActionable && row.kind !== "match") return false;
  if (filters.minSavingsPercent > 0) {
    const pct = matchSavingsPercent(row);
    if (pct === null || pct < filters.minSavingsPercent) return false;
  }
  return true;
}

function filterBulkRows(rows, filters) {
  return rows.filter((row) => bulkRowPassesFilters(row, filters));
}

// The table itself (rows.length === 0 there just means "nothing submitted"), plus a
// count note when filters are hiding rows, plus a distinct message when filters hide
// *everything* — wrapped together so sort/filter changes can swap this whole area out
// without touching the filter bar's own controls (which would lose focus/mid-typing
// state on every keystroke in the min-savings input — see onBulkFilterChange).
function renderBulkTableArea(rows, sort, filters) {
  if (rows.length === 0) return renderBulkTable(rows, sort);

  const filtered = filterBulkRows(rows, filters);
  const wrapper = el("div", { class: "bulk-table-area-inner" }, []);

  if (filtered.length !== rows.length) {
    wrapper.appendChild(
      el("p", { class: "bulk-filter-count" }, [
        `Showing ${filtered.length} of ${rows.length} row${rows.length === 1 ? "" : "s"} — adjust the filters above to see the rest.`,
      ])
    );
  }

  wrapper.appendChild(
    filtered.length === 0
      ? el("p", { class: "empty-note", text: "No rows match the current filters." })
      : renderBulkTable(filtered, sort)
  );
  return wrapper;
}

function rerenderBulkTableArea() {
  const area = els.results.querySelector(".bulk-table-area");
  if (area) area.replaceChildren(renderBulkTableArea(state.bulkRows, state.bulkSort, state.bulkFilters));
}

function onBulkSortClick(key) {
  if (state.bulkSort.key === key) {
    state.bulkSort.dir = state.bulkSort.dir === "desc" ? "asc" : "desc";
  } else {
    state.bulkSort = { key, dir: "desc" }; // switching columns starts at "highest savings first"
  }
  rerenderBulkTableArea();
}

function renderBulkFilterBar(filters) {
  const actionableCheckbox = el("input", { type: "checkbox", id: "bulk-filter-actionable" }, []);
  actionableCheckbox.checked = filters.hideNonActionable;
  actionableCheckbox.addEventListener("change", () => {
    state.bulkFilters.hideNonActionable = actionableCheckbox.checked;
    rerenderBulkTableArea();
  });

  const minSavingsInput = el(
    "input",
    { type: "number", id: "bulk-filter-min-savings", min: "0", max: "99", step: "1", placeholder: "0" },
    []
  );
  minSavingsInput.value = filters.minSavingsPercent > 0 ? String(filters.minSavingsPercent) : "";
  minSavingsInput.addEventListener("input", () => {
    const n = parseFloat(minSavingsInput.value);
    state.bulkFilters.minSavingsPercent = Number.isFinite(n) && n > 0 ? n : 0;
    rerenderBulkTableArea();
  });

  return el("div", { class: "bulk-filter-bar" }, [
    el("label", { class: "checkbox bulk-filter-checkbox" }, [actionableCheckbox, "Hide rows with no cheaper option"]),
    el("label", { class: "bulk-filter-percent" }, ["Min savings % ≥", minSavingsInput]),
  ]);
}

function renderSortableTh(label, key, sort, title) {
  const active = sort.key === key;
  const attrs = { class: "sortable-th" + (active ? " sortable-th-active" : ""), tabindex: "0", role: "button" };
  if (title) attrs.title = title;
  const th = el("th", attrs, [
    el("span", { class: "sortable-th-label", text: label }),
    el("span", { class: "sortable-th-arrow", text: active ? (sort.dir === "asc" ? "▲" : "▼") : "" }),
  ]);
  th.setAttribute("aria-sort", active ? (sort.dir === "asc" ? "ascending" : "descending") : "none");
  const activate = () => onBulkSortClick(key);
  th.addEventListener("click", activate);
  th.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      activate();
    }
  });
  return th;
}

function renderBulkTable(rows, sort) {
  if (rows.length === 0) {
    return el("p", { class: "empty-note", text: "Enter at least one instance type, one per line." });
  }

  const table = el("table", { class: "results-table bulk-table" }, []);
  const thead = el("thead", null, [
    el("tr", null, [
      el("th", { text: "Instance type" }),
      el("th", { text: "OS" }),
      el("th", { title: "Defaults to 1 if not given for this line, e.g. \"m5.xlarge,12\"", text: "Count" }),
      el("th", { text: "Price" }),
      el("th", { text: "Best match" }),
      renderSortableTh("Savings", "savings", sort),
      renderSortableTh(
        "Fleet savings",
        "fleet-savings",
        sort,
        "Assumes each instance runs continuously (730 hrs/month, 8,760 hrs/year), scaled by count"
      ),
      el("th", { text: "" }),
    ]),
  ]);
  const tbody = el("tbody", null, []);

  for (const row of sortBulkRows(rows, sort)) {
    if (row.kind === "not-found" || row.kind === "excluded") {
      const msg =
        row.kind === "excluded"
          ? `Excluded — ${EXCLUSION_MESSAGES[row.reason] || "outside this tool's scope"}`
          : "Not recognized in this region";
      tbody.appendChild(
        el("tr", { class: "bulk-row-note" }, [
          el("td", { text: row.inputType }),
          el("td", { colspan: "7", class: "no-diff", text: msg }),
        ])
      );
      continue;
    }
    if (row.kind === "no-os") {
      tbody.appendChild(
        el("tr", { class: "bulk-row-note" }, [
          el("td", { text: row.inputType }),
          el("td", { text: row.os }),
          el("td", { colspan: "6", class: "no-diff", text: `No ${row.os} pricing found` }),
        ])
      );
      continue;
    }
    if (row.kind === "no-match") {
      tbody.appendChild(
        el("tr", { class: "bulk-row-note" }, [
          el("td", { text: row.baseline.instanceType }),
          el("td", { text: row.os }),
          el("td", { class: "bulk-count", text: String(row.count) }),
          el("td", { text: formatMoney(row.baseline.pricePerHour) }),
          el("td", { colspan: "4", class: "no-diff", text: "No cheaper equivalent found" }),
        ])
      );
      continue;
    }

    // row.kind === "match"
    const { baseline, best, matchCount, count, invalidCount } = row;
    const savingsPerHour = baseline.pricePerHour - best.pricePerHour;
    const savingsPercent = (savingsPerHour / baseline.pricePerHour) * 100;

    const matchCell = el("td", null, [
      el("strong", { text: best.instanceType }),
      el("span", { class: "pill pill-muted small", text: best.architecture }),
    ]);
    const burstBadge = renderBurstBadge(best);
    if (burstBadge) matchCell.appendChild(burstBadge);
    if (matchCount > 1) {
      matchCell.appendChild(el("span", { class: "bulk-more", text: `+${matchCount - 1} more option${matchCount - 1 === 1 ? "" : "s"}` }));
    }

    const countChildren = [document.createTextNode(String(count))];
    if (invalidCount) {
      countChildren.push(
        el("span", { class: "bulk-count-flag", title: "Count wasn't a valid number on this line — treated as 1" }, ["?"])
      );
    }
    const countCell = el("td", { class: "bulk-count" }, countChildren);

    const detailsBtn = el("button", { type: "button", class: "bulk-details-btn" }, ["Details"]);
    detailsBtn.addEventListener("click", () => viewDetails(baseline.instanceType, row.os));

    tbody.appendChild(
      el("tr", { class: best.burstKind ? "burst-row" : "" }, [
        el("td", { text: baseline.instanceType }),
        el("td", { text: row.os }),
        countCell,
        el("td", { text: formatMoney(baseline.pricePerHour) }),
        matchCell,
        el("td", { class: "savings" }, [
          el("span", { class: "savings-abs", text: `-${formatMoney(savingsPerHour)}` }),
          el("span", { class: "savings-pct", text: `-${savingsPercent.toFixed(0)}%` }),
        ]),
        renderProjectedSavings(savingsPerHour, count),
        el("td", null, [detailsBtn]),
      ])
    );
  }

  table.appendChild(thead);
  table.appendChild(tbody);
  return table;
}

// ---- Shareable URLs -------------------------------------------------------------------
// The current search (region, mode, instance type(s), OS, toggles) is reflected in the
// URL query string so a search can be bookmarked or sent to a teammate. Read once at
// startup and on browser back/forward; written on every search submit.

function buildSearchParams() {
  const params = new URLSearchParams();
  if (state.currentRegion) params.set("region", state.currentRegion);

  const osList = [];
  if (els.osWindows.checked) osList.push("windows");
  if (els.osLinux.checked) osList.push("linux");
  if (osList.length) params.set("os", osList.join(","));

  if (els.graviton.checked) params.set("graviton", "1");
  if (!els.burstable.checked) params.set("burstable", "0");
  if (els.burstableMatchOnly.checked) params.set("burstableMatchOnly", "1");

  if (state.mode === "bulk") {
    params.set("mode", "bulk");
    const entries = parseFleetInput(els.bulkTextarea.value);
    if (entries.length) {
      // "type:count" per entry (":" rather than "," since "," already separates
      // entries) — count is omitted when it's just 1, keeping old share links
      // (a bare list of types) working unchanged.
      params.set("types", entries.map((e) => (e.count > 1 ? `${e.type}:${e.count}` : e.type)).join(","));
    }
  } else if (state.mode === "specs") {
    params.set("mode", "specs");
    const vcpu = els.specsVcpu.value.trim();
    const ram = els.specsRam.value.trim();
    if (vcpu) params.set("vcpu", vcpu);
    if (ram) params.set("ram", ram);
  } else {
    const instanceType = els.input.value.trim();
    if (instanceType) params.set("type", instanceType);
  }
  return params;
}

function updateUrl(push) {
  const params = buildSearchParams();
  const query = params.toString();
  const newUrl = query ? `${location.pathname}?${query}` : location.pathname;
  if (push) history.pushState(null, "", newUrl);
  else history.replaceState(null, "", newUrl);
}

function parseUrlParams() {
  const params = new URLSearchParams(location.search);
  const osParam = params.get("os");
  const typesParam = params.get("types");
  const burstableParam = params.get("burstable");
  const modeParam = params.get("mode");
  return {
    region: params.get("region"),
    mode: modeParam === "bulk" ? "bulk" : modeParam === "specs" ? "specs" : "single",
    type: params.get("type") || "",
    types: typesParam
      ? typesParam
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
          .map((s) => {
            const [type, count] = s.split(":");
            return count ? `${type},${count}` : type;
          })
          .join("\n")
      : "",
    vcpu: params.get("vcpu") || "",
    ram: params.get("ram") || "",
    os: osParam ? osParam.split(",").map((s) => s.trim().toLowerCase()) : null,
    graviton: params.get("graviton") === "1",
    burstable: burstableParam === null ? true : burstableParam !== "0",
    burstableMatchOnly: params.get("burstableMatchOnly") === "1",
  };
}

async function applyUrlParams(urlParams) {
  const available = (state.regionsIndex && state.regionsIndex.regions || []).filter((r) => !r.failed);
  const codes = new Set(available.map((r) => r.code));
  const region = urlParams.region && codes.has(urlParams.region) ? urlParams.region : pickDefaultRegion(state.regionsIndex);
  els.regionSelect.value = region;
  if (region !== state.currentRegion) await setRegion(region);

  setMode(urlParams.mode);
  if (urlParams.os) {
    els.osWindows.checked = urlParams.os.includes("windows");
    els.osLinux.checked = urlParams.os.includes("linux");
  }
  els.graviton.checked = urlParams.graviton;
  els.burstable.checked = urlParams.burstable;
  els.burstableMatchOnly.checked = urlParams.burstableMatchOnly;
  syncBurstableSubOption();

  if (urlParams.mode === "bulk") {
    els.bulkTextarea.value = urlParams.types;
    if (urlParams.types) runSearch(false);
  } else if (urlParams.mode === "specs") {
    els.specsVcpu.value = urlParams.vcpu;
    els.specsRam.value = urlParams.ram;
    if (urlParams.vcpu && urlParams.ram) runSearch(false);
  } else {
    els.input.value = urlParams.type;
    if (urlParams.type) runSearch(false);
  }
}

// "Only match burstable types when the baseline is burstable too" only means anything
// while "Include burstable instance types" is itself on — disable (and gray out) it
// otherwise, rather than leave it interactive but silently inert. Called on the parent
// toggle's change event and everywhere else its checked state is set programmatically
// (setting .checked in JS doesn't fire "change").
function syncBurstableSubOption() {
  const enabled = els.burstable.checked;
  els.burstableMatchOnly.disabled = !enabled;
  els.burstableMatchOnlyLabel.classList.toggle("disabled", !enabled);
}

// The topbar "Home" button: strips region/mode/type/os/toggle params off the URL (so a
// search someone shared with you doesn't come back on refresh) and puts every field back
// to its as-loaded default, same as opening the site fresh — not just clearing the results.
function resetSearch() {
  history.pushState(null, "", location.pathname);

  if (state.regionsIndex) {
    const defaultRegion = pickDefaultRegion(state.regionsIndex);
    els.regionSelect.value = defaultRegion;
    if (defaultRegion !== state.currentRegion) setRegion(defaultRegion);
  }

  els.input.value = "";
  els.bulkTextarea.value = "";
  els.specsVcpu.value = "";
  els.specsRam.value = "";
  els.osWindows.checked = true;
  els.osLinux.checked = false;
  els.burstable.checked = true;
  els.burstableMatchOnly.checked = false;
  syncBurstableSubOption();
  els.graviton.checked = false;
  state.bulkSort = { key: null, dir: "desc" };
  state.bulkFilters = { hideNonActionable: false, minSavingsPercent: 0 };

  setMode("single"); // also clears results + status
  els.form.scrollIntoView({ behavior: "smooth", block: "start" });
}

// ---- Search dispatch --------------------------------------------------------------

function handleSearch(event) {
  event.preventDefault();
  runSearch(true);
}

function runSearch(pushHistory) {
  updateUrl(pushHistory);
  clearResults();
  showStatus("", "");

  const osSelections = [];
  if (els.osWindows.checked) osSelections.push("Windows");
  if (els.osLinux.checked) osSelections.push("Linux");
  if (osSelections.length === 0) {
    showStatus("Select at least one operating system.", "error");
    return;
  }

  const regionData = state.regionCache.get(state.currentRegion);
  if (!regionData) {
    showStatus("Pricing data isn't loaded yet for this region. Try again in a moment.", "error");
    return;
  }

  const includeGraviton = els.graviton.checked;
  const includeBurstable = els.burstable.checked;

  // Meaningless without a baseline to compare burstiness against, so specs mode (which
  // has no baseline) never reads this — see findMatches vs. findSpecMatches.
  const burstableMatchOnly = els.burstableMatchOnly.checked;

  if (state.mode === "bulk") {
    runBulkSearch(regionData, osSelections, includeGraviton, includeBurstable, burstableMatchOnly);
  } else if (state.mode === "specs") {
    runSpecsSearch(regionData, osSelections, includeGraviton, includeBurstable);
  } else {
    runSingleSearch(regionData, osSelections, includeGraviton, includeBurstable, burstableMatchOnly);
  }
}

function runSpecsSearch(regionData, osSelections, includeGraviton, includeBurstable) {
  const { instances } = regionData;
  const minVcpu = parseFloat(els.specsVcpu.value);
  const minRam = parseFloat(els.specsRam.value);
  if (!(minVcpu > 0) || !(minRam > 0)) {
    showStatus("Enter a minimum vCPU count and RAM amount, both greater than 0.", "error");
    return;
  }

  els.results.hidden = false;
  for (const os of osSelections) {
    const matches = findSpecMatches(instances, minVcpu, minRam, os, includeGraviton, includeBurstable);
    const section = el("div", { class: "os-section" }, [el("h2", { text: os })]);
    section.appendChild(renderSpecsTable(matches));
    els.results.appendChild(section);
  }
}

function runSingleSearch(regionData, osSelections, includeGraviton, includeBurstable, burstableMatchOnly) {
  const { instances, excludedTypes } = regionData;
  const instanceType = els.input.value.trim();
  if (!instanceType) {
    showStatus("Enter an instance type, e.g. m5.xlarge.", "error");
    return;
  }

  if (!anyRowMatchesType(instances, instanceType)) {
    const reason = findExcludedReason(excludedTypes, instanceType);
    if (reason) {
      showStatus(
        `"${instanceType}" isn't included because ${EXCLUSION_MESSAGES[reason] || "it's excluded from this tool's scope."}`,
        "error"
      );
    } else {
      showStatus(
        `"${instanceType}" wasn't recognized in ${regionData.regionName || regionData.region}. Double-check the spelling (e.g. m5.xlarge, c6g.2xlarge, t3.micro).`,
        "error"
      );
    }
    return;
  }

  els.results.hidden = false;
  for (const os of osSelections) {
    const baseline = findBaselineRow(instances, instanceType, os);
    els.results.appendChild(
      renderOsSection(os, baseline, instances, includeGraviton, includeBurstable, burstableMatchOnly)
    );
  }
}

function runBulkSearch(regionData, osSelections, includeGraviton, includeBurstable, burstableMatchOnly) {
  const { instances, excludedTypes } = regionData;
  const allEntries = parseFleetInput(els.bulkTextarea.value);
  const entries = allEntries.slice(0, MAX_BULK_TYPES);
  const totalEntered = allEntries.length;

  if (entries.length === 0) {
    showStatus("Enter at least one instance type, one per line.", "error");
    return;
  }

  const rows = runBulkLookup(
    entries, osSelections, instances, excludedTypes, includeGraviton, includeBurstable, burstableMatchOnly
  );
  state.bulkRows = rows;

  els.results.hidden = false;
  if (totalEntered > MAX_BULK_TYPES) {
    els.results.appendChild(
      el("p", { class: "empty-note" }, [
        `Only the first ${MAX_BULK_TYPES} instance types were processed (${totalEntered} entered).`,
      ])
    );
  }
  const summary = renderFleetSummary(rows);
  if (summary) els.results.appendChild(summary);
  els.results.appendChild(renderBulkFilterBar(state.bulkFilters));
  els.results.appendChild(
    el("div", { class: "bulk-table-area" }, [renderBulkTableArea(rows, state.bulkSort, state.bulkFilters)])
  );
}

function renderFreshness(data) {
  const generated = new Date(data.generatedAt);
  const formatted = Number.isNaN(generated.getTime())
    ? "unknown time"
    : generated.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  els.freshness.textContent = `Pricing data (${data.regionName || data.region}, On-Demand) last refreshed ${formatted}. Source: ${data.source}.`;
}

// Footer line linking to the exact commit GitHub Pages is (or is about to be) serving,
// so it's obvious whether the live site matches a given local checkout — see README's
// "Live version" note. Hits the public, unauthenticated GitHub API directly from the
// browser (no server of our own to ask), which is rate-limited (~60 req/hour per
// visitor IP) and occasionally blocked by privacy extensions — both are just "no version
// shown," not worth surfacing as an error for something this non-essential.
async function loadSiteVersion() {
  if (!els.siteVersion) return;
  try {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/commits/main`, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!res.ok) throw new Error(`GitHub API ${res.status}`);
    const data = await res.json();
    const sha = data.sha;
    if (!sha) throw new Error("No commit SHA in response");

    const commitDate = data.commit && data.commit.committer && data.commit.committer.date;
    const when = commitDate
      ? new Date(commitDate).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
      : null;

    els.siteVersion.textContent = "Live version: ";
    const link = el("a", {
      href: `https://github.com/${GITHUB_REPO}/commit/${sha}`,
      target: "_blank",
      rel: "noopener noreferrer",
      text: sha.slice(0, 7),
    });
    els.siteVersion.appendChild(link);
    if (when) els.siteVersion.appendChild(document.createTextNode(` (${when})`));
    els.siteVersion.hidden = false;
  } catch (err) {
    console.warn("Couldn't load live version info:", err);
    // Leave it hidden — nothing to show, and it started that way in the markup.
  }
}

async function init() {
  cacheEls();
  els.form.addEventListener("submit", handleSearch);
  els.input.addEventListener("input", onComboInput);
  els.input.addEventListener("keydown", onComboKeydown);
  els.input.addEventListener("focus", onComboInput);
  els.input.addEventListener("blur", onComboBlur);
  els.regionSelect.addEventListener("change", (e) => setRegion(e.target.value));
  els.modeTabs.forEach((btn) => btn.addEventListener("click", () => setMode(btn.dataset.mode)));
  els.bulkFileInput.addEventListener("change", handleBulkFileImport);
  els.burstable.addEventListener("change", syncBurstableSubOption);
  syncBurstableSubOption(); // sync to the checkbox's initial (checked) state in the markup
  els.resetBtn.addEventListener("click", resetSearch);
  window.addEventListener("popstate", () => {
    applyUrlParams(parseUrlParams()).catch((err) => console.error(err));
  });

  loadSiteVersion(); // independent of pricing data — don't let it block or delay the rest of init

  try {
    state.regionsIndex = await loadRegionsIndex();
    populateRegionSelect(state.regionsIndex);
    await applyUrlParams(parseUrlParams());
  } catch (err) {
    console.error(err);
    els.freshness.textContent = "Couldn't load region list. Try refreshing the page.";
    showStatus("Pricing data failed to load, so searches won't work right now.", "error");
  }
}

init();
