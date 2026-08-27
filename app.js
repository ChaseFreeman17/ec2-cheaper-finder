// EC2 Cheaper Finder — client-side matching against the pre-trimmed, per-region files in
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

const DEFAULT_REGION = "us-east-1";
const MAX_COMBOBOX_RESULTS = 30;

const state = {
  regionsIndex: null, // { generatedAt, regions: [{code, name, instanceCount, generatedAt, stale?, failed?}] }
  regionCache: new Map(), // code -> { generatedAt, region, regionName, source, instances, excludedTypes }
  currentRegion: null,
  instanceTypeOptions: [], // [{ type, excluded: reason|null }], for the current region
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
  els.osWindows = byId("os-windows");
  els.osLinux = byId("os-linux");
  els.graviton = byId("graviton-toggle");
  els.status = byId("status");
  els.results = byId("results");
  els.freshness = byId("data-freshness");
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

function findMatches(instances, baseline, includeGraviton) {
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
      if (!(r.pricePerHour < baseline.pricePerHour)) return false;
      return true;
    })
    .sort((a, b) => a.pricePerHour - b.pricePerHour);
}

function flaggedDifferences(baseline, candidate) {
  const flags = [];
  if (candidate.vcpu !== baseline.vcpu) {
    flags.push({ label: "vCPU", text: `${baseline.vcpu} → ${candidate.vcpu}` });
  }
  if (candidate.memoryGiB !== baseline.memoryGiB) {
    flags.push({ label: "RAM", text: `${baseline.memoryGiB} GiB → ${candidate.memoryGiB} GiB` });
  }
  if (candidate.networkPerformance !== baseline.networkPerformance) {
    flags.push({
      label: "Network",
      text: `${baseline.networkPerformance} → ${candidate.networkPerformance}`,
    });
  }
  if (candidate.dedicatedEbsThroughput !== baseline.dedicatedEbsThroughput) {
    flags.push({
      label: "EBS bandwidth",
      text: `${baseline.dedicatedEbsThroughput} → ${candidate.dedicatedEbsThroughput}`,
    });
  }
  if (candidate.storageType !== baseline.storageType) {
    flags.push({
      label: "Storage",
      text: `${baseline.storageType} → ${candidate.storageType}`,
    });
  }
  // Burst-capable candidates get their own prominent badge (see renderBurstBadge)
  // instead of being buried in this generic list — CPU credit/flex throttling is a
  // bigger behavioral gotcha than a peripheral spec difference.
  if (candidate.architecture !== baseline.architecture) {
    flags.push({
      label: "Architecture",
      text: `${baseline.architecture} → ${candidate.architecture}`,
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
          el("span", { class: "diff-badge", title: flag.text }, [
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
        flagsCell,
      ])
    );
  }

  table.appendChild(thead);
  table.appendChild(tbody);
  return table;
}

function renderOsSection(osLabel, baseline, instances, includeGraviton) {
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

  const matches = findMatches(instances, baseline, includeGraviton);
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

function handleSearch(event) {
  event.preventDefault();
  clearResults();

  const instanceType = els.input.value.trim();
  if (!instanceType) {
    showStatus("Enter an instance type, e.g. m5.xlarge.", "error");
    return;
  }

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
  const { instances, excludedTypes } = regionData;

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

  showStatus("", "");
  els.results.hidden = false;
  els.results.innerHTML = "";

  const includeGraviton = els.graviton.checked;
  for (const os of osSelections) {
    const baseline = findBaselineRow(instances, instanceType, os);
    els.results.appendChild(renderOsSection(os, baseline, instances, includeGraviton));
  }
}

function renderFreshness(data) {
  const generated = new Date(data.generatedAt);
  const formatted = Number.isNaN(generated.getTime())
    ? "unknown time"
    : generated.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  els.freshness.textContent = `Pricing data (${data.regionName || data.region}, On-Demand) last refreshed ${formatted}. Source: ${data.source}.`;
}

async function init() {
  cacheEls();
  els.form.addEventListener("submit", handleSearch);
  els.input.addEventListener("input", onComboInput);
  els.input.addEventListener("keydown", onComboKeydown);
  els.input.addEventListener("focus", onComboInput);
  els.input.addEventListener("blur", onComboBlur);
  els.regionSelect.addEventListener("change", (e) => setRegion(e.target.value));

  try {
    state.regionsIndex = await loadRegionsIndex();
    populateRegionSelect(state.regionsIndex);
    const defaultRegion = pickDefaultRegion(state.regionsIndex);
    els.regionSelect.value = defaultRegion;
    await setRegion(defaultRegion);
  } catch (err) {
    console.error(err);
    els.freshness.textContent = "Couldn't load region list. Try refreshing the page.";
    showStatus("Pricing data failed to load, so searches won't work right now.", "error");
  }
}

init();
