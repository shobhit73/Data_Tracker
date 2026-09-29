/* Data views ported from the DSP Ops dashboard (Phase 2 of the platform merge).
   One nav item, four tabs, all read-only: the tables are filled by Shobhit's
   push script (service role), the app only ever selects. Sources and refresh
   cadence live on the dashboard side (dsp-ops-dashboard/crm-merge/). */
window.Views = window.Views || {};

const DATA_TABS = [
  ["api", "API Activity"],
  ["health", "Payroll Health"],
  ["coverage", "Data Coverage"],
  ["docs", "Documents"],
  ["hist", "Historical"],
];

/* Onboarding-API modules in the order they are actually run, not alphabetical. */
const API_MODULES = [
  ["EmployeeCensus", "Census"],
  ["PaymentMethodSetup", "Payment"],
  ["FedTaxWithholding", "Fed Tax"],
  ["StateTaxWithholding", "State Tax"],
  ["EmployeeDeductions", "Deductions"],
  ["EmployeeContributions", "Contrib."],
  ["WorkerCompensation", "Worker Comp"],
  ["SocCode", "SOC"],
  ["PriorPayroll", "Prior Payroll"],
];

let dataQ = "";

const dpill = (label, cls) => `<span class="pill ${cls}">${esc(label)}</span>`;
const dpct = (num, den) => den ? Math.round(num / den * 100) : null;
const dbar = (p) => p === null ? `<span class="muted">—</span>`
  : `<span class="bar"><span style="width:${Math.min(100, p)}%"></span></span> ${p}%`;
const dshort = (d) => d ? String(d).slice(5) : ""; // 2026-08-18 -> 08-18

Views.renderData = async (view, tab) => {
  if (!DATA_TABS.some(([k]) => k === tab)) tab = "api";
  view.innerHTML = `
    <div class="page-head"><h1>Data</h1><span id="data-count" class="muted"></span></div>
    <div class="tabbar">${DATA_TABS.map(([k, label]) =>
      `<button type="button" data-tab="${k}" class="${k === tab ? "active" : ""}">${label}</button>`).join("")}
    </div>
    <div class="filter-bar">
      <input id="data-q" type="search" placeholder="Search client…" value="${esc(dataQ)}">
      <span id="data-extra"></span>
    </div>
    <div id="data-body"><p class="muted">Loading…</p></div>`;
  view.querySelectorAll("[data-tab]").forEach((b) =>
    b.onclick = () => { location.hash = "#data/" + b.dataset.tab; });
  let renderBody = () => {}; // becomes real once the tab's data has arrived
  $("#data-q").oninput = (e) => { dataQ = e.target.value.trim().toLowerCase(); renderBody(); };

  const renderers = { api: apiTab, health: healthTab, coverage: coverageTab, docs: docsTab, hist: histTab };
  renderBody = await renderers[tab]();
  renderBody();
};

/* --- API Activity: clients × modules, has each onboarding API ever run OK. --- */
async function apiTab() {
  const runs = await Store.listApiActivity();
  const byClient = new Map(); // fein -> {name, vendor, runs: {module: row}}
  runs.forEach((r) => {
    if (!byClient.has(r.fein)) byClient.set(r.fein, { name: r.client_name, vendor: r.vendor, runs: {} });
    byClient.get(r.fein).runs[r.module_key] = r;
  });
  const clients = [...byClient.values()].sort((a, b) => a.name.localeCompare(b.name));
  let vendor = "all", gapsOnly = false;
  $("#data-extra").innerHTML = `
    <select id="api-vendor"><option value="all">All vendors</option>
      <option>ADP</option><option>Paycom</option></select>
    <label style="display:flex;align-items:center;gap:5px"><input type="checkbox" id="api-gaps"> gaps only</label>`;

  const cell = (r) => {
    if (!r) return `<td><span class="muted">—</span></td>`;
    if (r.run_status === "ok" || r.last_ok_date)
      return `<td title="last OK ${esc(r.last_ok_date || r.last_run_date)} by ${esc(r.last_ok_by || r.run_by || "?")}">` +
        dpill("✓ " + dshort(r.last_ok_date || r.last_run_date), "pill-done") + `</td>`;
    if (r.run_status === "last_failed")
      return `<td title="last run ${esc(r.last_run_date)} failed (${r.last_failed ?? "?"} of ${r.last_total ?? "?"})">` +
        dpill("! " + dshort(r.last_run_date), "pill-onhold") + `</td>`;
    return `<td title="ran ${esc(r.last_run_date || "?")}, never fully OK">` +
      dpill("✕", "pill-cancelled") + `</td>`;
  };
  const hasGap = (c) => API_MODULES.some(([m]) => !c.runs[m] || c.runs[m].run_status !== "ok");

  const render = () => {
    const list = clients.filter((c) =>
      (!dataQ || c.name.toLowerCase().includes(dataQ)) &&
      (vendor === "all" || c.vendor === vendor) &&
      (!gapsOnly || hasGap(c)));
    $("#data-body").innerHTML = `<div style="overflow-x:auto"><table class="grid"><thead><tr>
        <th>Client</th>${API_MODULES.map(([, h]) => `<th>${h}</th>`).join("")}
      </tr></thead><tbody>${list.map((c) => `<tr>
        <td><b>${esc(c.name)}</b><div class="muted" style="font-size:11px">${esc(c.vendor || "")}</div></td>
        ${API_MODULES.map(([m]) => cell(c.runs[m])).join("")}</tr>`).join("") ||
      `<tr><td colspan="${API_MODULES.length + 1}" class="muted">No clients match.</td></tr>`}</tbody></table></div>`;
    $("#data-count").textContent = `${list.length} of ${clients.length} clients`;
  };
  $("#api-vendor").onchange = (e) => { vendor = e.target.value; render(); };
  $("#api-gaps").onchange = (e) => { gapsOnly = e.target.checked; render(); };
  return render;
}

/* --- Payroll Health: does prior data + Uzio runs cover pay periods gaplessly. --- */
async function healthTab() {
  const rows = await Store.listPayrollHealth();
  let status = "all";
  const statuses = [...new Set(rows.map((r) => r.status).filter(Boolean))].sort();
  $("#data-extra").innerHTML = `<select id="ph-status"><option value="all">All statuses</option>
    ${statuses.map((s) => `<option>${esc(s)}</option>`).join("")}</select>`;
  const pillCls = (s) => s === "Covered" ? "pill-done" : s === "New to platform" ? "pill-na"
    : s === "Handover gap" ? "pill-onhold" : "pill-cancelled";
  const span = (from, to, n) => from ? `${esc(from)} → ${esc(to)}<div class="muted" style="font-size:11px">${n ?? 0} rows</div>` : `<span class="muted">—</span>`;

  const render = () => {
    const list = rows.filter((r) =>
      (!dataQ || (r.company_name + " " + (r.dsp_short_code || "")).toLowerCase().includes(dataQ)) &&
      (status === "all" || r.status === status));
    $("#data-body").innerHTML = `<div style="overflow-x:auto"><table class="grid"><thead><tr>
        <th>Client</th><th>Prev system</th><th>Prior payroll data</th><th>Uzio runs</th><th>Gap</th><th>Status</th><th>Checked</th>
      </tr></thead><tbody>${list.map((r) => `<tr>
        <td><b>${esc(r.company_name)}</b><div class="muted" style="font-size:11px">${esc(r.dsp_short_code || "")}</div></td>
        <td>${esc(r.previous_system || "—")}</td>
        <td>${span(r.prior_from, r.prior_to, r.prior_rows)}</td>
        <td>${span(r.normal_from, r.normal_to, r.normal_rows)}</td>
        <td>${r.gap_days ? `<span class="overdue" title="${esc(r.gap_ranges || "")}">${r.gap_days}d</span>` : `<span class="muted">—</span>`}</td>
        <td>${dpill(r.status || "?", pillCls(r.status))}</td>
        <td>${fmtDate(r.checked_date)}</td></tr>`).join("") ||
      `<tr><td colspan="7" class="muted">No clients match.</td></tr>`}</tbody></table></div>`;
    $("#data-count").textContent = `${list.length} of ${rows.length} clients · ` +
      `${rows.filter((r) => r.handover_gap).length} with gaps`;
  };
  $("#ph-status").onchange = (e) => { status = e.target.value; render(); };
  return render;
}

/* --- Data Coverage: % of active employees with each data element, from prod. --- */
async function coverageTab() {
  const rows = await Store.listDataCoverage();
  $("#data-extra").innerHTML = "";
  const render = () => {
    const list = rows.filter((r) =>
      !dataQ || (r.company_name + " " + (r.dsp_short_code || "")).toLowerCase().includes(dataQ));
    $("#data-body").innerHTML = `<div style="overflow-x:auto"><table class="grid"><thead><tr>
        <th>Client</th><th>Employees</th><th>Payment method</th><th>Emergency contact</th><th>Licence</th><th>Worker comp</th>
      </tr></thead><tbody>${list.map((r) => {
        const a = r.active_employees;
        return `<tr>
        <td><b>${esc(r.company_name)}</b><div class="muted" style="font-size:11px">${esc(r.dsp_short_code || "")}</div></td>
        <td>${a ?? "—"} active<div class="muted" style="font-size:11px">${r.total_employees ?? "—"} total</div></td>
        <td>${dbar(dpct(r.active_with_payment_method, a))}</td>
        <td>${dbar(dpct(r.active_with_emergency_contact, a))}</td>
        <td>${dbar(dpct(r.active_with_licence, a))}</td>
        <td title="${esc(r.worker_comp_codes || "")}">${dbar(dpct(r.active_with_worker_comp, a))}</td></tr>`;
      }).join("") ||
      `<tr><td colspan="6" class="muted">No clients match.</td></tr>`}</tbody></table></div>`;
    $("#data-count").textContent = `${list.length} of ${rows.length} clients`;
  };
  return render;
}

/* --- Documents: the transfer-mail record, and what prod actually holds.
   The per-client ratio runs against ALL employees, not active — documents
   cover leavers too, so an active-only ratio reads over 100% and means
   nothing. --- */
async function docsTab() {
  const [transfers, counts] = await Promise.all([
    Store.listDocumentTransfers(), Store.listDocumentCounts()]);
  $("#data-extra").innerHTML = "";
  const pillCls = (s) => s === "Complete" ? "pill-done" : s === "Blocked" ? "pill-cancelled"
    : s === "In progress" ? "pill-progress" : s === "Nothing to transfer" ? "pill-na" : "pill-onhold";
  const failTitle = (r) => ["filename format: " + (r.fail_filename_format ?? 0),
    "employee not found: " + (r.fail_employee_not_found ?? 0),
    "unsupported type: " + (r.fail_unsupported_type ?? 0),
    "size limit: " + (r.fail_size_limit ?? 0),
    "resolved since: " + (r.failed_resolved ?? 0)].join("\n");

  const render = () => {
    const t = transfers.filter((r) => !dataQ || r.client_name.toLowerCase().includes(dataQ));
    const c = counts.filter((r) =>
      !dataQ || (r.company_name + " " + (r.dsp_short_code || "")).toLowerCase().includes(dataQ));
    $("#data-body").innerHTML = `
      <h2>Transfers (from the transfer mails)</h2>
      <div style="overflow-x:auto"><table class="grid"><thead><tr>
        <th>Client</th><th>Status</th><th>Date</th><th>Docs</th><th>Failed</th><th>Jira</th><th class="notes-cell">Notes</th>
      </tr></thead><tbody>${t.map((r) => `<tr>
        <td><b>${esc(r.client_name)}</b></td>
        <td>${dpill(r.status || "?", pillCls(r.status))}</td>
        <td>${fmtDate(r.transfer_date)}</td>
        <td>${r.total_docs ?? "—"}</td>
        <td title="${esc(failTitle(r))}">${r.failed_docs ? `<span class="overdue">${r.failed_docs}</span>` : "0"}</td>
        <td>${esc(r.jira_id || "—")}</td>
        <td class="notes-cell"><span class="note">${esc(r.notes || "")}</span></td></tr>`).join("") ||
      `<tr><td colspan="7" class="muted">No clients match.</td></tr>`}</tbody></table></div>
      <h2>In the database (per client)</h2>
      <div style="overflow-x:auto"><table class="grid"><thead><tr>
        <th>Client</th><th>Documents</th><th>Employees with docs</th>
      </tr></thead><tbody>${c.map((r) => `<tr>
        <td><b>${esc(r.company_name)}</b><div class="muted" style="font-size:11px">${esc(r.dsp_short_code || "")}</div></td>
        <td>${r.documents ?? 0}</td>
        <td>${r.employees_with_docs ?? 0} of ${r.total_employees ?? "?"} employees ${dbar(dpct(r.employees_with_docs, r.total_employees))}</td></tr>`).join("") ||
      `<tr><td colspan="3" class="muted">No clients match.</td></tr>`}</tbody></table></div>`;
    $("#data-count").textContent = `${t.length} transfers · ${c.length} clients counted`;
  };
  return render;
}

/* --- Historical: the DSP Historical Data Tracker sheet, mirrored here after
   every daily 17:30 IST run. The sheet is the source of truth — fix statuses
   there, never here. N/A is excluded from the ratio (expected = received +
   pending), same arithmetic as the daily mail. --- */
async function histTab() {
  const [clients, status, oos] = await Promise.all([
    Store.listHistClients(), Store.listHistStatus(), Store.listHistOutOfScope()]);
  const pendingBy = {};
  status.forEach((s) => {
    if (s.status !== "Pending") return;
    (pendingBy[s.dsp_short_code] = pendingBy[s.dsp_short_code] || []).push(s);
  });
  const hold = oos.filter((o) => (o.reason || "").toLowerCase().includes("hold"));
  const gone = oos.filter((o) => !(o.reason || "").toLowerCase().includes("hold"));
  const pct = (c) => { const exp = c.received + c.pending; return exp ? Math.round(c.received / exp * 100) : 0; };

  let show = "all";
  $("#data-extra").innerHTML = `<select id="h-filter">
    <option value="all">All clients</option>
    <option value="open">Still collecting</option>
    <option value="done">Complete</option></select>`;

  const oosBlock = (title, rows) => rows.length ? `<h2>${title}</h2>` +
    rows.map((o) => `<div class="act-row"><b>${esc(o.dsp_name || o.dsp_short_code)}</b>
      <span class="tag">${esc(o.reason || "")}</span>
      ${o.notes ? `<div class="muted" style="font-size:12px">${esc(o.notes)}</div>` : ""}</div>`).join("") : "";

  const render = () => {
    const list = clients.filter((c) =>
      (!dataQ || (c.dsp_name + " " + c.dsp_short_code).toLowerCase().includes(dataQ)) &&
      (show === "all" || (show === "done" ? c.pending === 0 : c.pending > 0)))
      .sort((a, b) => pct(b) - pct(a) || a.dsp_name.localeCompare(b.dsp_name));
    $("#data-body").innerHTML = list.map((c) => {
      const pend = pendingBy[c.dsp_short_code] || [];
      const p = pct(c);
      return `<details class="cgroup"><summary>
        <b>${esc(c.dsp_name)}</b><span class="tag">${esc(c.vendor || "?")}</span>
        <span class="muted" style="font-size:12px">${esc(c.implementor || "")}</span>
        <span style="flex:1"></span>
        <span class="bar"><span style="width:${p}%"></span></span> <b>${p}%</b>
        <span class="muted" style="font-size:12px">${c.received} of ${c.received + c.pending} received${c.not_applicable ? ` · ${c.not_applicable} n/a` : ""} · scanned ${c.last_scanned ? esc(String(c.last_scanned).slice(0, 10)) : "—"}</span>
        </summary>${pend.length ? `
        <table class="grid"><thead><tr><th>Category</th><th>Report still to collect</th><th>Unit</th></tr></thead>
        <tbody>${pend.map((s) => `<tr><td>${esc(s.category || "")}</td><td>${esc(s.report_name || "")}</td><td>${esc(s.unit_label || "")}</td></tr>`).join("")}</tbody></table>` :
        `<p class="muted" style="padding:0 14px 12px">Nothing left to collect.</p>`}
      </details>`;
    }).join("") || `<p class="muted">No clients match.</p>`;
    $("#data-body").innerHTML += oosBlock("On hold (auto-resumes with the RAG)", hold) +
      oosBlock("Out of scope — do not chase", gone);
    $("#data-count").textContent = `${list.length} of ${clients.length} tracked · ` +
      `${clients.filter((c) => c.pending > 0).length} still collecting`;
  };
  $("#h-filter").onchange = (e) => { show = e.target.value; render(); };
  return render;
}
