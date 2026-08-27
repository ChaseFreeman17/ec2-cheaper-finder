// EC2 Cheaper Finder — client-side matching against the pre-trimmed data/instances.json
// (see scripts/refresh-data.js and docs/SPEC.md for how that file is built).

const EXCLUSION_MESSAGES = {
  "accelerated":
    "it's a GPU, FPGA, or inference/training-chip instance type. Accelerators aren't a minor difference like network throughput — we don't recommend dropping one to save money, so these are left out of comparisons entirely.",
  "bare-metal":
    "it's a bare-metal instance type, which gives direct hardware access that a regular instance can't replicate — so it's left out of comparisons entirely.",
  "not-a-standard-instance":
    "it isn't a standard compute instance type (e.g. a dedicated host or another non-instance line item).",
};

const state = {
  data: null, // { generatedAt, region, source, instances: [...], excludedTypes: {...} }
};

const els = {};

function byId(id) {
  return document.getElementById(id);
}

function cacheEls() {
  els.form = byId("search-form");
  els.input = byId("instance-type");
  els.osWindows = byId("os-windows");
  els.osLinux = byId("os-linux");
  els.graviton = byId("graviton-toggle");
  els.status = byId("status");
  els.results = byId("results");
  els.freshness = byId("data-freshness");
}

async function loadData() {
  const res = await fetch("data/instances.json", { cache: "no-cache" });
  if (!res.ok) throw new Error(`Failed to load data/instances.json: ${res.status}`);
  return res.json();
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
      if (r.vcpu !== baseline.vcpu) return false;
      if (r.memoryGiB !== baseline.memoryGiB) return false;
      if (r.architecture === "arm64" && !includeGraviton) return false;
      if (!(r.pricePerHour < baseline.pricePerHour)) return false;
      return true;
    })
    .sort((a, b) => a.pricePerHour - b.pricePerHour);
}

function flaggedDifferences(baseline, candidate) {
  const flags = [];
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
  if (candidate.burstable !== baseline.burstable) {
    flags.push({
      label: "CPU",
      text: candidate.burstable ? "fixed → burstable" : "burstable → fixed",
    });
  }
  if (candidate.architecture !== baseline.architecture) {
    flags.push({
      label: "Architecture",
      text: `${baseline.architecture} → ${candidate.architecture}`,
    });
  }
  return flags;
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

    tbody.appendChild(
      el("tr", null, [
        el("td", null, [
          el("strong", { text: candidate.instanceType }),
          el("span", { class: "pill pill-muted small", text: candidate.architecture }),
        ]),
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
        text: `No ${osLabel} On-Demand pricing found for this instance type in us-east-1.`,
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

  const { instances, excludedTypes } = state.data;

  if (!anyRowMatchesType(instances, instanceType)) {
    const reason = findExcludedReason(excludedTypes, instanceType);
    if (reason) {
      showStatus(
        `"${instanceType}" isn't included because ${EXCLUSION_MESSAGES[reason] || "it's excluded from this tool's scope."}`,
        "error"
      );
    } else {
      showStatus(
        `"${instanceType}" wasn't recognized. Double-check the spelling (e.g. m5.xlarge, c6g.2xlarge, t3.micro).`,
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
  els.freshness.textContent = `Pricing data (${data.region}, On-Demand) last refreshed ${formatted}. Source: ${data.source}.`;
}

async function init() {
  cacheEls();
  els.form.addEventListener("submit", handleSearch);

  try {
    state.data = await loadData();
    renderFreshness(state.data);
  } catch (err) {
    console.error(err);
    els.freshness.textContent = "Couldn't load pricing data. Try refreshing the page.";
    showStatus("Pricing data failed to load, so searches won't work right now.", "error");
  }
}

init();
