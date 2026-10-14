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
  ["ewa", "EWA"],
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

/* --- Refresh: pull today's numbers from Uzio prod, then reload this page. ---
   The work happens in the prod-refresh Edge Function, which lives in the DSP
   Ops Supabase project, not this one. Two jobs run: api_activity reads prod
   and writes that project, push_to_crm then copies the result here -- without
   the second one the button would succeed and change nothing on screen until
   Apps Script's 17:30 push.

   The function takes this page's own session token and resolves it back to a
   real user, so it refuses anyone who is not signed in to the CRM. Any signed-
   in user may press it. */
const PROD_REFRESH_URL =
  "https://nqiyiherkzlhorsnyeni.supabase.co/functions/v1/prod-refresh";

async function runProdRefresh(jobs, onLine) {
  // supabase-js keeps the session here; reading it directly avoids depending
  // on which name the client is exposed under.
  const k = Object.keys(localStorage)
    .find((x) => x.startsWith("sb-") && x.endsWith("-auth-token"));
  const token = k ? (JSON.parse(localStorage[k]) || {}).access_token : null;
  if (!token) throw new Error("You are signed out — reload and sign in again.");

  const res = await fetch(PROD_REFRESH_URL, {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ jobs: jobs }),
  });
  const body = await res.json().catch(() => ({}));
  // 207 means some jobs worked and some did not, so the per-job detail is the
  // answer, not the status code.
  if (!res.ok && res.status !== 207) {
    throw new Error(body.error || ("Refresh failed (HTTP " + res.status + ")"));
  }
  (body.jobs || []).forEach((j) => {
    (j.log || []).forEach((l) => onLine && onLine(j.job + ": " + l));
  });
  const failed = (body.jobs || []).filter((j) => !j.ok);
  if (failed.length) {
    throw new Error(failed.map((j) => j.job + " — " + (j.log || []).join("; ")).join(" | "));
  }
  return body;
}

/**
 * A refresh button plus its own status line.
 *
 * `batches` is either one list of jobs, or several run one after another.
 * Several matters for the whole-set refresh: an Edge Function has a wall-clock
 * limit, and load_history is the one job that deletes before it re-inserts, so
 * it gets a call of its own rather than sharing a timeout with six others.
 */
function refreshControl(batches, label) {
  if (typeof batches[0] === "string") batches = [batches];
  const wrap = document.createElement("span");
  wrap.className = "refresh-control";
  wrap.innerHTML =
    '<button type="button" class="btn-refresh"></button>' +
    '<span class="refresh-status muted"></span>';
  const btn = wrap.querySelector("button");
  const status = wrap.querySelector(".refresh-status");
  btn.textContent = label || "Refresh from Uzio";

  btn.onclick = async () => {
    btn.disabled = true;
    try {
      for (let i = 0; i < batches.length; i++) {
        // It reads prod and rewrites two projects; tens of seconds is normal,
        // and a silent button for that long reads as broken.
        status.textContent = batches.length > 1
          ? `Reading Uzio… step ${i + 1} of ${batches.length}`
          : "Reading Uzio… this takes up to a minute.";
        await runProdRefresh(batches[i], (l) => console.log("[prod-refresh]", l));
      }
      status.textContent = "Done. Reloading…";
      // Re-render from the CRM's now-updated copy.
      location.reload();
    } catch (e) {
      btn.disabled = false;
      status.textContent = e.message;
      status.classList.add("refresh-status--error");
      console.error("[prod-refresh]", e);
    }
  };
  return wrap;
}

/* Everything, in three calls.
   1. the jobs that only upsert, so a failure leaves the old rows in place
   2. load_history on its own -- it rebuilds each client's slice, and a
      timeout halfway through that is the one outcome worth engineering away
   3. the copy into this project, last, because it copies whatever is there
      at the moment it runs */
const REFRESH_EVERYTHING = [
  ["backfill_fein", "work_locations", "data_coverage",
   "document_counts", "system_activity", "payroll_health", "api_activity", "ewa_status"],
  ["load_history"],
  ["push_to_crm"],
  // Evidence-based task flips, after the fresh copy has landed here.
  ["task_evidence"],
];


const dpill = (label, cls) => `<span class="pill ${cls}">${esc(label)}</span>`;
const dpct = (num, den) => den ? Math.round(num / den * 100) : null;
const dbar = (p) => p === null ? `<span class="muted">—</span>`
  : `<span class="bar"><span style="width:${Math.min(100, p)}%"></span></span> ${p}%`;
const dshort = (d) => d ? String(d).slice(5) : ""; // 2026-08-18 -> 08-18

/* --- Pagination for the long grids. Client-side: the tables hold at most a
   few hundred rows, already fully fetched — slicing beats re-querying. Each
   tab keeps its own page counter; the pager only renders past one page, and
   the search box resets every counter through render.reset. --- */
const PAGE_SIZE = 25;
function pageSlice(list, page) {
  const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  const p = Math.min(Math.max(0, page), pages - 1);
  return { rows: list.slice(p * PAGE_SIZE, (p + 1) * PAGE_SIZE), p, pages };
}
function pagerHtml(key, p, pages, total) {
  if (pages <= 1) return "";
  return `<div class="filter-bar" style="margin:10px 0 0;justify-content:flex-end">
    <button type="button" class="small secondary" data-pg="${key}:prev" ${p === 0 ? "disabled" : ""}>‹ Prev</button>
    <span class="muted">page ${p + 1} of ${pages} · ${total} total</span>
    <button type="button" class="small secondary" data-pg="${key}:next" ${p >= pages - 1 ? "disabled" : ""}>Next ›</button>
  </div>`;
}
function hookPager(key, step) {
  // Document-wide on purpose: the Clients, Audit Status and Open Items pages
  // use the same pager, and only one view is ever mounted at a time.
  document.querySelectorAll(`[data-pg^="${key}:"]`).forEach((b) =>
    b.onclick = () => step(b.dataset.pg.endsWith(":next") ? 1 : -1));
}

/* --- Date-range filter, shared like the pager. A preset select fills the
   two date inputs; editing an input switches you to a custom range. A row
   with NO date fails an active filter on purpose — "this week" should not
   quietly include the undated. st is the caller's {from,to} object. --- */
function localIso(d) {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") +
    "-" + String(d.getDate()).padStart(2, "0");
}
function dfHtml(key, st) {
  return `<span style="display:inline-flex;gap:6px;align-items:center">
    <select data-dfp="${key}">
      <option value="">All time</option>
      <option value="thisweek">This week</option>
      <option value="next7">Next 7 days</option>
      <option value="thismonth">This month</option>
      <option value="last30">Last 30 days</option>
    </select>
    <input type="date" data-dfrom="${key}" value="${st.from || ""}" style="max-width:150px">
    <input type="date" data-dto="${key}" value="${st.to || ""}" style="max-width:150px">
  </span>`;
}
function wireDateFilter(key, st, onChange) {
  const sel = document.querySelector(`[data-dfp="${key}"]`);
  const f = document.querySelector(`[data-dfrom="${key}"]`);
  const t = document.querySelector(`[data-dto="${key}"]`);
  if (!sel || !f || !t) return;
  sel.onchange = () => {
    const now = new Date();
    let from = "", to = "";
    if (sel.value === "thisweek") {
      const mon = new Date(now); mon.setDate(now.getDate() - ((now.getDay() || 7) - 1));
      const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
      from = localIso(mon); to = localIso(sun);
    } else if (sel.value === "next7") {
      const e = new Date(now); e.setDate(now.getDate() + 7);
      from = localIso(now); to = localIso(e);
    } else if (sel.value === "thismonth") {
      from = localIso(new Date(now.getFullYear(), now.getMonth(), 1));
      to = localIso(new Date(now.getFullYear(), now.getMonth() + 1, 0));
    } else if (sel.value === "last30") {
      const s = new Date(now); s.setDate(now.getDate() - 30);
      from = localIso(s); to = localIso(now);
    }
    f.value = from; t.value = to; st.from = from; st.to = to; onChange();
  };
  f.onchange = () => { st.from = f.value; onChange(); };
  t.onchange = () => { st.to = t.value; onChange(); };
}
function dfPass(dateStr, st) {
  if (!st.from && !st.to) return true;
  const d = String(dateStr || "").slice(0, 10);
  if (!d) return false;
  return (!st.from || d >= st.from) && (!st.to || d <= st.to);
}

Views.renderData = async (view, tab) => {
  if (!DATA_TABS.some(([k]) => k === tab)) tab = "api";
  view.innerHTML = `
    <div class="page-head"><h1>Data</h1><span id="data-count" class="muted"></span><span id="data-refresh-all"></span></div>
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
  // Every prod job, not just the open tab's. The per-tab buttons stay: most
  // of the time one tab is what someone actually wants, and it is far quicker.
  $("#data-refresh-all").appendChild(
    refreshControl(REFRESH_EVERYTHING, "Refresh everything"));
  let renderBody = () => {}; // becomes real once the tab's data has arrived
  $("#data-q").oninput = (e) => {
    dataQ = e.target.value.trim().toLowerCase();
    if (renderBody.reset) renderBody.reset(); // a new search starts on page 1
    renderBody();
  };

  const renderers = { api: apiTab, health: healthTab, coverage: coverageTab, docs: docsTab, hist: histTab, ewa: ewaTab };
  renderBody = await renderers[tab]();
  renderBody();
};

/* --- API Activity: clients × modules, has each onboarding API ever run OK.
   Filters work on one module or on any; a cell or client name opens the run
   log drawer (apiLogDrawer) for that client. --- */
const API_STATE_LABEL = { ok: "OK", last_failed: "Last run failed", never_ok: "Never OK",
  no_result: "No result", none: "Never run" };
function apiState(r) {
  if (!r) return "none";
  if (r.run_status === "ok") return "ok";
  return r.run_status || "never_ok";
}

async function apiTab() {
  const runs = await Store.listApiActivity();
  const byClient = new Map(); // fein -> {fein, name, vendor, runs: {module: row}}
  runs.forEach((r) => {
    if (!byClient.has(r.fein)) byClient.set(r.fein, { fein: r.fein, name: r.client_name, vendor: r.vendor, runs: {} });
    byClient.get(r.fein).runs[r.module_key] = r;
  });
  const clients = [...byClient.values()].sort((a, b) => a.name.localeCompare(b.name));
  const f = { vendor: "", module: "", state: "", stale: 0, by: "" };
  const dr = { from: "", to: "" };   // last run date, on the chosen module or any
  const runners = [...new Set(runs.map((r) => r.run_by).filter(Boolean))].sort();
  $("#data-extra").innerHTML = `
    <select id="api-vendor"><option value="">All vendors</option><option>ADP</option><option>Paycom</option></select>
    <select id="api-module"><option value="">Any API</option>
      ${API_MODULES.map(([m, l]) => `<option value="${m}">${l}</option>`).join("")}</select>
    <select id="api-state">
      <option value="">Any result</option>
      <option value="problem" title="last run failed, never fully OK, or died without a result">Failed / no result</option>
      <option value="last_failed">Last run failed</option>
      <option value="never_ok">Never OK</option>
      <option value="none">Never run</option>
      <option value="ok">OK</option>
    </select>
    <select id="api-by"><option value="">Run by anyone</option>
      ${runners.map((r) => `<option>${esc(r)}</option>`).join("")}</select>
    <select id="api-stale" title="Last OK run older than">
      <option value="0">Any age</option><option value="30">OK &gt;30d ago</option>
      <option value="60">OK &gt;60d ago</option><option value="90">OK &gt;90d ago</option>
    </select>
    <span class="muted" style="font-size:12px">Last run</span>${dfHtml("apir", dr)}
    <button type="button" class="linkish" id="api-clear">Clear</button>`;
  // api_activity rebuilds this tab's numbers from prod; push_to_crm is what
  // makes them visible here rather than only in the DSP Ops project.
  $("#data-extra").appendChild(refreshControl(["api_activity", "push_to_crm"]));

  const cell = (c, m) => {
    const r = c.runs[m];
    const open = `data-log="${esc(c.fein)}" data-mod="${m}"`;
    if (!r) return `<td><span class="muted">—</span></td>`;
    if (r.run_status === "ok" || r.last_ok_date)
      return `<td class="logcell" ${open} title="last OK ${esc(r.last_ok_date || r.last_run_date)} by ${esc(r.last_ok_by || r.run_by || "?")} · click for the run log">` +
        dpill("✓ " + dshort(r.last_ok_date || r.last_run_date), "pill-done") + `</td>`;
    if (r.run_status === "last_failed")
      return `<td class="logcell" ${open} title="last run ${esc(r.last_run_date)} failed (${r.last_failed ?? "?"} of ${r.last_total ?? "?"}) · click for why">` +
        dpill("! " + dshort(r.last_run_date), "pill-onhold") + `</td>`;
    return `<td class="logcell" ${open} title="ran ${esc(r.last_run_date || "?")}, never fully OK · click for why">` +
      dpill("✕", "pill-cancelled") + `</td>`;
  };
  const mods = () => f.module ? [f.module] : API_MODULES.map(([m]) => m);
  const stateMatch = (c) => {
    if (!f.state) return true;
    return mods().some((m) => {
      const s = apiState(c.runs[m]);
      // "Never run" is its own option: with Any API it would match every
      // client, since nobody runs every API.
      return f.state === "problem" ? s !== "ok" && s !== "none" : s === f.state;
    });
  };
  // Stale = a module that HAS run ok, but not since the cutoff.
  const staleMatch = (c) => {
    if (!f.stale) return true;
    const cut = new Date(); cut.setDate(cut.getDate() - f.stale);
    const iso = localIso(cut);
    return mods().some((m) => {
      const r = c.runs[m];
      const okDate = r && (r.last_ok_date || (r.run_status === "ok" && r.last_run_date));
      return okDate && String(okDate).slice(0, 10) < iso;
    });
  };
  const byMatch = (c) => !f.by || mods().some((m) => c.runs[m] && c.runs[m].run_by === f.by);
  const dateMatch = (c) => (!dr.from && !dr.to) ||
    mods().some((m) => c.runs[m] && dfPass(c.runs[m].last_run_date, dr));

  let page = 0;
  const render = () => {
    const list = clients.filter((c) =>
      (!dataQ || c.name.toLowerCase().includes(dataQ) || String(c.fein).includes(dataQ)) &&
      (!f.vendor || c.vendor === f.vendor) &&
      stateMatch(c) && staleMatch(c) && byMatch(c) && dateMatch(c));
    const pg = pageSlice(list, page); page = pg.p;
    $("#data-body").innerHTML = `<div style="overflow-x:auto"><table class="grid"><thead><tr>
        <th>Client</th>${API_MODULES.map(([m, h]) =>
          `<th${f.module === m ? ' class="col-hl"' : ""}>${h}</th>`).join("")}
      </tr></thead><tbody>${pg.rows.map((c) => `<tr>
        <td><a href="javascript:void 0" data-log="${esc(c.fein)}" data-mod=""><b>${esc(c.name)}</b></a>
          <div class="muted" style="font-size:11px">${esc(c.vendor || "")}</div></td>
        ${API_MODULES.map(([m]) => cell(c, m)).join("")}</tr>`).join("") ||
      `<tr><td colspan="${API_MODULES.length + 1}" class="muted">No clients match.</td></tr>`}</tbody></table></div>` +
      pagerHtml("api", pg.p, pg.pages, list.length);
    hookPager("api", (d) => { page += d; render(); });
    $("#data-body").querySelectorAll("[data-log]").forEach((el) => (el.onclick = () => {
      const c = byClient.get(el.dataset.log);
      apiLogDrawer({ fein: c.fein, name: c.name, vendor: c.vendor }, el.dataset.mod || "");
    }));
    $("#data-count").textContent = `${list.length} of ${clients.length} clients`;
  };
  render.reset = () => { page = 0; };
  const bind = (id, key, num) => ($(id).onchange = (e) => {
    f[key] = num ? Number(e.target.value) : e.target.value; page = 0; render(); });
  bind("#api-vendor", "vendor"); bind("#api-module", "module"); bind("#api-state", "state");
  bind("#api-by", "by"); bind("#api-stale", "stale", true);
  wireDateFilter("apir", dr, () => { page = 0; render(); });
  $("#api-clear").onclick = () => { dataQ = ""; Views.renderData($("#view"), "api"); };
  return render;
}

/* --- Run log drawer: the Streamlit "Onboarding API Run Logs" tool, inside
   the CRM. Reads go through prod-refresh (a browser cannot reach the
   onboarding backend) under the reader's OWN Uzio sign-in — CRM and Uzio are
   separate logins, and prod's audit should name whoever looked. The password
   is sent once to mint a token; only the token is kept, in sessionStorage,
   so it dies with the tab. --- */
const OB_TOKEN_KEY = "uzio_ob_token", OB_USER_KEY = "uzio_ob_user";
const ssGet = (k) => { try { return sessionStorage.getItem(k); } catch { return null; } };
const ssSet = (k, v) => { try { v == null ? sessionStorage.removeItem(k) : sessionStorage.setItem(k, v); } catch { /* private mode */ } };

async function callProdFn(body) {
  const k = Object.keys(localStorage).find((x) => x.startsWith("sb-") && x.endsWith("-auth-token"));
  const token = k ? (JSON.parse(localStorage[k]) || {}).access_token : null;
  if (!token) throw new Error("You are signed out of the CRM — reload and sign in again.");
  const res = await fetch(PROD_REFRESH_URL, {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const out = await res.json().catch(() => ({}));
  if (out.needLogin) { ssSet(OB_TOKEN_KEY, null); const e = new Error(out.error || "Sign in to Uzio"); e.needLogin = true; throw e; }
  if (!res.ok) throw new Error(out.error || ("HTTP " + res.status));
  return out;
}

const istFmt = (iso, withYear) => iso ? new Date(iso).toLocaleString("en-IN", {
  timeZone: "Asia/Kolkata", day: "2-digit", month: "short", ...(withYear ? { year: "numeric" } : {}),
  hour: "2-digit", minute: "2-digit", hour12: false }) : "—";
const modLabel = (m) => (API_MODULES.find(([k]) => k === m) || [m, m])[1];
const RUN_PILL = { OK: ["OK", "pill-done"], FAIL: ["Failed", "pill-cancelled"], NOTHING: ["Nothing processed", "pill-onhold"],
  RUNNING: ["Running", "pill-progress"], NO_RESULT: ["No result", "pill-onhold"] };

function apiLogDrawer(client, module) {
  document.getElementById("log-drawer")?.remove();
  const d = document.createElement("div");
  d.id = "log-drawer";
  d.innerHTML = `<div class="ld-backdrop"></div><aside class="ld-panel" role="dialog" aria-label="API run log">
    <div class="ld-head"><div><h2 style="margin:0">${esc(client.name)}</h2>
      <span class="muted" style="font-size:12px">${esc(client.vendor || "")} · FEIN ${esc(client.fein)} · run log</span></div>
      <button type="button" class="linkish ld-x" aria-label="Close">✕</button></div>
    <div class="ld-body"></div></aside>`;
  document.body.appendChild(d);
  const body = d.querySelector(".ld-body");
  const close = () => { d.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  d.querySelector(".ld-x").onclick = close;
  d.querySelector(".ld-backdrop").onclick = close;

  let runs = null, pick = module || "";

  const fail = (e) => {
    if (e.needLogin) return showLogin(e.message);
    body.insertAdjacentHTML("beforeend", `<p class="overdue">${esc(e.message)}</p>`);
  };

  const showLogin = (msg, typedUser) => {
    body.innerHTML = `<div class="card" style="box-shadow:none;background:var(--surface-cont-low)">
      <h2 style="margin-top:0">Sign in with your Uzio login</h2>
      <p class="muted" style="font-size:13px;margin-top:0">This is your Uzio platform account, not the CRM one.
        It is used once to open a read-only session; the password is not stored, and every read is
        audited in prod under your name. The session ends when you close this tab.</p>
      ${msg ? `<p class="overdue" style="font-size:13px">${esc(msg)}</p>` : ""}
      <form id="ld-login" style="display:flex;flex-direction:column;gap:10px">
        <input id="ld-u" type="email" autocomplete="username" placeholder="firstname.lastname@uzio.com" required style="max-width:none">
        <input id="ld-p" type="password" autocomplete="current-password" placeholder="Uzio password" required style="max-width:none">
        <button type="submit">Sign in</button>
      </form></div>`;
    $("#ld-u").value = typedUser || ssGet(OB_USER_KEY) || "";
    ($("#ld-u").value ? $("#ld-p") : $("#ld-u")).focus();
    $("#ld-login").onsubmit = async (e) => {
      e.preventDefault();
      const btn = e.target.querySelector("button"); btn.disabled = true; btn.textContent = "Signing in…";
      const pw = $("#ld-p"); const password = pw.value; pw.value = "";
      const username = $("#ld-u").value.trim();
      try {
        const out = await callProdFn({ action: "ob_login", username, password, fein: client.fein });
        ssSet(OB_TOKEN_KEY, out.token); ssSet(OB_USER_KEY, out.user);
        loadRuns();
      } catch (err) { showLogin(err.message, username); }
    };
  };

  const loadRuns = async () => {
    body.innerHTML = `<p class="muted">Reading the onboarding log…</p>`;
    try {
      const out = await callProdFn({ action: "api_runs", fein: client.fein, obToken: ssGet(OB_TOKEN_KEY) });
      runs = out.runs || [];
      renderRuns();
    } catch (e) { body.innerHTML = ""; fail(e); }
  };

  const signedIn = () => `<div class="muted" style="font-size:12px;display:flex;gap:8px;align-items:center;margin-bottom:12px">
      Uzio: <b>${esc(ssGet(OB_USER_KEY) || "")}</b>
      <button type="button" class="linkish" id="ld-reload" style="font-size:12px">Reload</button>
      <button type="button" class="linkish" id="ld-out" style="font-size:12px">Sign out of Uzio</button></div>`;

  const renderRuns = () => {
    if (!runs.length) { body.innerHTML = signedIn() + `<p class="muted">Nothing has ever been pushed for this client.</p>`; wireTop(); return; }
    // Latest run per API = the state the client is in now (runs come newest first).
    const latest = {};
    runs.forEach((r) => Object.keys(r.modules).forEach((m) => {
      if (!latest[m]) latest[m] = { run: r, n: r.modules[m], count: 0 };
      latest[m].count++;
    }));
    const order = Object.keys(latest).sort((a, b) => {
      const ia = API_MODULES.findIndex(([k]) => k === a), ib = API_MODULES.findIndex(([k]) => k === b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    const inflight = runs.filter((r) => r.status === "RUNNING");
    const died = runs.filter((r) => r.status === "NO_RESULT");
    const card = (m) => {
      const { run, n, count } = latest[m];
      const [t, , fl] = n;
      const tone = t === 0 ? "warn" : fl ? "bad" : "ok";
      const line = t === 0 ? "last run processed nobody" : fl ? `<b>${fl} of ${t} failed</b>` : `all ${t} went through`;
      return `<button type="button" class="ld-card ld-${tone}${pick === m ? " sel" : ""}" data-pick="${m}">
        <span class="ld-api">${esc(modLabel(m))}</span>
        <span>${line}</span>
        <span class="muted" style="font-size:12px">${istFmt(run.start)} IST · ${esc(run.by)} · ${count} run${count === 1 ? "" : "s"}</span></button>`;
    };
    body.innerHTML = signedIn() +
      inflight.map((r) => `<div class="ld-banner">⏳ Run ${r.id} is still going (started ${istFmt(r.start)} IST by ${esc(r.by)}). Its API shows up once it finishes.</div>`).join("") +
      (died.length ? `<div class="ld-banner muted">${died.length} earlier run(s) never wrote a result — they died partway and are not counted.</div>` : "") +
      `<div class="ld-cards">${order.map(card).join("")}</div><div id="ld-runs"></div>`;
    wireTop();
    body.querySelectorAll("[data-pick]").forEach((b) => (b.onclick = () => { pick = b.dataset.pick; renderRuns(); }));
    if (pick && latest[pick]) renderModuleRuns(pick);
    else if (pick) $("#ld-runs").innerHTML = `<p class="muted">${esc(modLabel(pick))} has never been run for this client.</p>`;
  };

  const wireTop = () => {
    const r = $("#ld-reload"); if (r) r.onclick = loadRuns;
    const o = $("#ld-out"); if (o) o.onclick = () => { ssSet(OB_TOKEN_KEY, null); showLogin(); };
  };

  const renderModuleRuns = (m) => {
    const list = runs.filter((r) => r.modules[m]);
    const status = (r) => {
      const [t, , fl] = r.modules[m];
      if (r.status === "RUNNING" || r.status === "NO_RESULT") return RUN_PILL[r.status];
      return t === 0 ? RUN_PILL.NOTHING : fl ? [`${fl} failed`, "pill-cancelled"] : RUN_PILL.OK;
    };
    // Land on the newest attempt that failed — that is the one being chased.
    const firstFail = list.find((r) => r.modules[m][2] > 0) || list[0];
    $("#ld-runs").innerHTML = `<h2>${esc(modLabel(m))} — ${list.length} run${list.length === 1 ? "" : "s"}</h2>
      <table class="grid"><thead><tr><th>Run</th><th>When (IST)</th><th>By</th><th>Total</th><th>OK</th><th>Fail</th><th>Result</th></tr></thead>
      <tbody>${list.map((r) => { const [t, ok, fl] = r.modules[m]; const [lab, cls] = status(r);
        return `<tr class="rowlink" data-run="${r.id}"><td>${r.id}</td><td>${istFmt(r.start, true)}</td><td>${esc(r.by)}</td>
          <td>${t}</td><td>${ok}</td><td>${fl ? `<span class="overdue">${fl}</span>` : 0}</td><td>${dpill(lab, cls)}</td></tr>`; }).join("")}</tbody></table>
      <div id="ld-detail"></div>`;
    $("#ld-runs").querySelectorAll("[data-run]").forEach((tr) => (tr.onclick = () => loadDetail(Number(tr.dataset.run), m)));
    if (firstFail) loadDetail(firstFail.id, m);
  };

  const loadDetail = async (runId, m) => {
    $("#ld-runs").querySelectorAll("[data-run]").forEach((tr) => tr.classList.toggle("sel", Number(tr.dataset.run) === runId));
    const box = $("#ld-detail");
    box.innerHTML = `<p class="muted">Reading run ${runId}…</p>`;
    try {
      const out = await callProdFn({ action: "api_run_detail", runId, obToken: ssGet(OB_TOKEN_KEY) });
      const mine = (x) => x.module === m || !x.module;
      const errs = out.errors.rows.filter(mine), warns = out.warnings.rows.filter(mine);
      const gErr = out.errors.grouped.filter(mine), gWarn = out.warnings.grouped.filter(mine);
      const r = out.run;
      const grp = (g) => `<table class="grid"><thead><tr><th>Employees</th><th>Reason</th><th>e.g.</th></tr></thead><tbody>${
        g.map((x) => `<tr><td><b>${x.count}</b></td><td>${esc(x.reason)}${x.type ? ` <span class="tag">${esc(x.type)}</span>` : ""}</td>
          <td class="muted" style="font-size:12px">${esc(x.sample.join(", "))}${x.count > x.sample.length ? " …" : ""}</td></tr>`).join("")}</tbody></table>`;
      const every = (rows) => `<table class="grid"><thead><tr><th>Row</th><th>Employee ID</th><th>Reason</th></tr></thead><tbody>${
        rows.map((x) => `<tr><td>${x.row ?? ""}</td><td>${esc(x.employeeId ?? "")}</td><td>${esc(x.reason)}</td></tr>`).join("")}</tbody></table>`;
      const capped = out.errors.total > out.rawCap || out.warnings.total > out.rawCap;
      box.innerHTML = `<div class="card" style="box-shadow:none;border:1px solid var(--line);margin-top:14px">
        <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center">
          <b>Run ${r.id}</b>${dpill(...(RUN_PILL[r.status] || [r.status, "pill-na"]))}
          <span class="muted" style="font-size:12px">${istFmt(r.start, true)} IST · by ${esc(r.by)}${r.tookSec != null ? ` · took ${Math.floor(r.tookSec / 60)}:${String(r.tookSec % 60).padStart(2, "0")}` : ""}</span>
          <span style="flex:1"></span>
          ${errs.length || warns.length ? `<button type="button" class="small secondary" id="ld-csv">Download CSV</button>` : ""}
        </div>
        ${!r.end ? `<p class="muted" style="font-size:13px">No end time: this run is still going, or died without writing a result.</p>` : ""}
        ${errs.length ? `<h2>${errs.length} employee${errs.length === 1 ? "" : "s"} did not go through</h2>
          <p class="muted" style="font-size:12px;margin-top:-4px">Same reason, one line — fix the reason and they all clear.</p>${grp(gErr)}
          <details class="cgroup"><summary>Every employee (${errs.length})</summary><div style="padding:0 14px 12px;max-height:340px;overflow:auto">${every(errs)}</div></details>`
          : `<p style="margin:12px 0 0">No per-employee failures were written for ${esc(modLabel(m))} in this run.</p>`}
        ${warns.length ? `<details class="cgroup"><summary>Warnings — these went through anyway (${warns.length})</summary>
          <div style="padding:0 14px 12px">${grp(gWarn)}</div></details>` : ""}
        ${capped ? `<p class="muted" style="font-size:12px">Very large run: the employee list is cut at ${out.rawCap} rows; the grouped counts above are complete.</p>` : ""}
      </div>`;
      const csv = $("#ld-csv");
      if (csv) csv.onclick = () => {
        const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
        const lines = [["Kind", "API", "Row", "Employee ID", "Type", "Reason"].join(",")]
          .concat(errs.map((x) => ["Error", modLabel(m), x.row, x.employeeId, x.type, x.reason].map(q).join(",")))
          .concat(warns.map((x) => ["Warning", modLabel(m), x.row, x.employeeId, x.type, x.reason].map(q).join(",")));
        const a = document.createElement("a");
        a.href = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" }));
        a.download = `${client.name.replace(/[^\w]+/g, "_")}_${modLabel(m)}_run_${r.id}.csv`;
        a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      };
    } catch (e) {
      if (e.needLogin) return showLogin(e.message);
      box.innerHTML = `<p class="overdue">${esc(e.message)}</p>`;
    }
  };

  ssGet(OB_TOKEN_KEY) ? loadRuns() : showLogin();
}

/* --- Payroll Health: does prior data + Uzio runs cover pay periods gaplessly. --- */
async function healthTab() {
  const rows = await Store.listPayrollHealth();
  let status = "all", prev = "", gapsOnly = false;
  const dc = { from: "", to: "" };   // checked date
  const statuses = [...new Set(rows.map((r) => r.status).filter(Boolean))].sort();
  const prevs = [...new Set(rows.map((r) => r.previous_system).filter(Boolean))].sort();
  $("#data-extra").innerHTML = `<select id="ph-status"><option value="all">All statuses</option>
    ${statuses.map((s) => `<option>${esc(s)}</option>`).join("")}</select>
    <select id="ph-prev"><option value="">All previous systems</option>
    ${prevs.map((s) => `<option>${esc(s)}</option>`).join("")}</select>
    <label class="chk"><input type="checkbox" id="ph-gaps"> Handover gap</label>
    <span class="muted" style="font-size:12px">Checked</span>${dfHtml("phc", dc)}`;
  $("#data-extra").appendChild(refreshControl(["payroll_health", "push_to_crm"]));
  const pillCls = (s) => s === "Covered" ? "pill-done" : s === "New to platform" ? "pill-na"
    : s === "Handover gap" ? "pill-onhold" : "pill-cancelled";
  const span = (from, to, n) => from ? `${esc(from)} → ${esc(to)}<div class="muted" style="font-size:11px">${n ?? 0} rows</div>` : `<span class="muted">—</span>`;

  let page = 0;
  const render = () => {
    const list = rows.filter((r) =>
      (!dataQ || (r.company_name + " " + (r.dsp_short_code || "")).toLowerCase().includes(dataQ)) &&
      (status === "all" || r.status === status) &&
      (!prev || r.previous_system === prev) &&
      (!gapsOnly || r.handover_gap) &&
      dfPass(r.checked_date, dc));
    const pg = pageSlice(list, page); page = pg.p;
    $("#data-body").innerHTML = `<div style="overflow-x:auto"><table class="grid"><thead><tr>
        <th>Client</th><th>Prev system</th><th>Prior payroll data</th><th>Uzio runs</th><th>Gap</th><th>Status</th><th>Checked</th>
      </tr></thead><tbody>${pg.rows.map((r) => `<tr>
        <td><b>${esc(r.company_name)}</b><div class="muted" style="font-size:11px">${esc(r.dsp_short_code || "")}</div></td>
        <td>${esc(r.previous_system || "—")}</td>
        <td>${span(r.prior_from, r.prior_to, r.prior_rows)}</td>
        <td>${span(r.normal_from, r.normal_to, r.normal_rows)}</td>
        <td>${r.gap_days ? `<span class="overdue" title="${esc(r.gap_ranges || "")}">${r.gap_days}d</span>` : `<span class="muted">—</span>`}</td>
        <td>${dpill(r.status || "?", pillCls(r.status))}</td>
        <td>${fmtDate(r.checked_date)}</td></tr>`).join("") ||
      `<tr><td colspan="7" class="muted">No clients match.</td></tr>`}</tbody></table></div>` +
      pagerHtml("health", pg.p, pg.pages, list.length);
    hookPager("health", (d) => { page += d; render(); });
    $("#data-count").textContent = `${list.length} of ${rows.length} clients · ` +
      `${rows.filter((r) => r.handover_gap).length} with gaps`;
  };
  render.reset = () => { page = 0; };
  $("#ph-status").onchange = (e) => { status = e.target.value; page = 0; render(); };
  $("#ph-prev").onchange = (e) => { prev = e.target.value; page = 0; render(); };
  $("#ph-gaps").onchange = (e) => { gapsOnly = e.target.checked; page = 0; render(); };
  wireDateFilter("phc", dc, () => { page = 0; render(); });
  return render;
}

/* --- Data Coverage: % of active employees with each data element, from prod. --- */
async function coverageTab() {
  const rows = await Store.listDataCoverage();
  const FIELDS = [["active_with_payment_method", "Payment method"], ["active_with_emergency_contact", "Emergency contact"],
    ["active_with_licence", "Licence"], ["active_with_worker_comp", "Worker comp"]];
  let field = "", below = 0, minEmp = 0;
  $("#data-extra").innerHTML = `
    <select id="cv-field"><option value="">Any field</option>
      ${FIELDS.map(([k, l]) => `<option value="${k}">${l}</option>`).join("")}</select>
    <select id="cv-below">
      <option value="0">Any coverage</option><option value="100">below 100%</option>
      <option value="90">below 90%</option><option value="75">below 75%</option><option value="50">below 50%</option>
    </select>
    <select id="cv-min"><option value="0">Any size</option><option value="25">25+ active employees</option>
      <option value="100">100+ active employees</option></select>`;
  $("#data-extra").appendChild(refreshControl(["data_coverage", "push_to_crm"]));
  // With no field picked, "below N%" means any of the four is under N.
  const covMatch = (r) => {
    if (!below) return true;
    const a = r.active_employees;
    if (!a) return false;
    return (field ? [field] : FIELDS.map(([k]) => k)).some((k) => (dpct(r[k], a) ?? 0) < below);
  };
  let page = 0;
  const render = () => {
    const list = rows.filter((r) =>
      (!dataQ || (r.company_name + " " + (r.dsp_short_code || "")).toLowerCase().includes(dataQ)) &&
      covMatch(r) && (r.active_employees ?? 0) >= minEmp);
    const pg = pageSlice(list, page); page = pg.p;
    $("#data-body").innerHTML = `<div style="overflow-x:auto"><table class="grid"><thead><tr>
        <th>Client</th><th>Employees</th><th>Payment method</th><th>Emergency contact</th><th>Licence</th><th>Worker comp</th>
      </tr></thead><tbody>${pg.rows.map((r) => {
        const a = r.active_employees;
        return `<tr>
        <td><b>${esc(r.company_name)}</b><div class="muted" style="font-size:11px">${esc(r.dsp_short_code || "")}</div></td>
        <td>${a ?? "—"} active<div class="muted" style="font-size:11px">${r.total_employees ?? "—"} total</div></td>
        <td>${dbar(dpct(r.active_with_payment_method, a))}</td>
        <td>${dbar(dpct(r.active_with_emergency_contact, a))}</td>
        <td>${dbar(dpct(r.active_with_licence, a))}</td>
        <td title="${esc(r.worker_comp_codes || "")}">${dbar(dpct(r.active_with_worker_comp, a))}</td></tr>`;
      }).join("") ||
      `<tr><td colspan="6" class="muted">No clients match.</td></tr>`}</tbody></table></div>` +
      pagerHtml("cov", pg.p, pg.pages, list.length);
    hookPager("cov", (d) => { page += d; render(); });
    $("#data-count").textContent = `${list.length} of ${rows.length} clients`;
  };
  render.reset = () => { page = 0; };
  $("#cv-field").onchange = (e) => { field = e.target.value; page = 0; render(); };
  $("#cv-below").onchange = (e) => { below = Number(e.target.value); page = 0; render(); };
  $("#cv-min").onchange = (e) => { minEmp = Number(e.target.value); page = 0; render(); };
  return render;
}

/* --- Documents: the transfer-mail record, and what prod actually holds.
   The per-client ratio runs against ALL employees, not active — documents
   cover leavers too, so an active-only ratio reads over 100% and means
   nothing. --- */
async function docsTab() {
  const [transfers, counts] = await Promise.all([
    Store.listDocumentTransfers(), Store.listDocumentCounts()]);
  const dft = { from: "", to: "" };   // transfer_date range
  let tStatus = "", failedOnly = false;
  const tStatuses = [...new Set(transfers.map((r) => r.status).filter(Boolean))].sort();
  $("#data-extra").innerHTML = `<select id="dt-status"><option value="">All transfer statuses</option>
      ${tStatuses.map((s) => `<option>${esc(s)}</option>`).join("")}</select>
    <label class="chk"><input type="checkbox" id="dt-failed"> Has failed docs</label>
    <span class="muted" style="font-size:12px">Transferred</span>${dfHtml("doct", dft)}`;
  // Only the counted half: the transfer columns come from the completion
  // mails, which no prod query can rebuild.
  $("#data-extra").appendChild(refreshControl(["document_counts", "push_to_crm"]));
  const pillCls = (s) => s === "Complete" ? "pill-done" : s === "Blocked" ? "pill-cancelled"
    : s === "In progress" ? "pill-progress" : s === "Nothing to transfer" ? "pill-na" : "pill-onhold";
  const failTitle = (r) => ["filename format: " + (r.fail_filename_format ?? 0),
    "employee not found: " + (r.fail_employee_not_found ?? 0),
    "unsupported type: " + (r.fail_unsupported_type ?? 0),
    "size limit: " + (r.fail_size_limit ?? 0),
    "resolved since: " + (r.failed_resolved ?? 0)].join("\n");

  let pageT = 0, pageC = 0;
  const render = () => {
    const t = transfers.filter((r) =>
      (!dataQ || r.client_name.toLowerCase().includes(dataQ)) &&
      (!tStatus || r.status === tStatus) &&
      (!failedOnly || r.failed_docs > 0) &&
      dfPass(r.transfer_date, dft));
    const c = counts.filter((r) =>
      !dataQ || (r.company_name + " " + (r.dsp_short_code || "")).toLowerCase().includes(dataQ));
    const pgT = pageSlice(t, pageT); pageT = pgT.p;
    const pgC = pageSlice(c, pageC); pageC = pgC.p;
    $("#data-body").innerHTML = `
      <h2>Transfers (from the transfer mails)</h2>
      <div style="overflow-x:auto"><table class="grid"><thead><tr>
        <th>Client</th><th>Status</th><th>Date</th><th>Docs</th><th>Failed</th><th>Jira</th><th class="notes-cell">Notes</th>
      </tr></thead><tbody>${pgT.rows.map((r) => `<tr>
        <td><b>${esc(r.client_name)}</b></td>
        <td>${dpill(r.status || "?", pillCls(r.status))}</td>
        <td>${fmtDate(r.transfer_date)}</td>
        <td>${r.total_docs ?? "—"}</td>
        <td title="${esc(failTitle(r))}">${r.failed_docs ? `<span class="overdue">${r.failed_docs}</span>` : "0"}</td>
        <td>${esc(r.jira_id || "—")}</td>
        <td class="notes-cell"><span class="note">${esc(r.notes || "")}</span></td></tr>`).join("") ||
      `<tr><td colspan="7" class="muted">No clients match.</td></tr>`}</tbody></table></div>` +
      pagerHtml("doct", pgT.p, pgT.pages, t.length) + `
      <h2>In the database (per client)</h2>
      <div style="overflow-x:auto"><table class="grid"><thead><tr>
        <th>Client</th><th>Documents</th><th>Employees with docs</th>
      </tr></thead><tbody>${pgC.rows.map((r) => `<tr>
        <td><b>${esc(r.company_name)}</b><div class="muted" style="font-size:11px">${esc(r.dsp_short_code || "")}</div></td>
        <td>${r.documents ?? 0}</td>
        <td>${r.employees_with_docs ?? 0} of ${r.total_employees ?? "?"} employees ${dbar(dpct(r.employees_with_docs, r.total_employees))}</td></tr>`).join("") ||
      `<tr><td colspan="3" class="muted">No clients match.</td></tr>`}</tbody></table></div>` +
      pagerHtml("docc", pgC.p, pgC.pages, c.length);
    hookPager("doct", (d) => { pageT += d; render(); });
    hookPager("docc", (d) => { pageC += d; render(); });
    $("#data-count").textContent = `${t.length} transfers · ${c.length} clients counted`;
  };
  render.reset = () => { pageT = 0; pageC = 0; };
  wireDateFilter("doct", dft, () => { pageT = 0; render(); });
  $("#dt-status").onchange = (e) => { tStatus = e.target.value; pageT = 0; render(); };
  $("#dt-failed").onchange = (e) => { failedOnly = e.target.checked; pageT = 0; render(); };
  return render;
}

/* --- EWA: which earned-wage-access provider each live DSP is wired to
   (DailyPay / ZayZoon flags, PayActiv SFTP report), straight from prod via
   the ewa_status job. Asked for by Sanya, 14 Oct 2026. --- */
async function ewaTab() {
  const rows = await Store.listEwa();
  const PROVIDERS = [["dailypay", "DailyPay"], ["zayzoon", "ZayZoon"], ["payactiv", "PayActiv"]];
  const f = { prov: "", status: "" };
  const dr = { from: "", to: "" };   // provider start date
  const statuses = [...new Set(rows.map((r) => r.live_status).filter(Boolean))].sort();
  $("#data-extra").innerHTML = `
    <select id="ewa-prov"><option value="">All clients</option>
      <option value="any">Has any EWA provider</option>
      ${PROVIDERS.map(([k, l]) => `<option value="${k}">${l}</option>`).join("")}
      <option value="none">No EWA provider</option></select>
    <select id="ewa-status"><option value="">Any live status</option>
      ${statuses.map((s) => `<option>${esc(s)}</option>`).join("")}</select>
    <span class="muted" style="font-size:12px">Started</span>${dfHtml("ewad", dr)}`;
  $("#data-extra").appendChild(refreshControl(["ewa_status"]));

  const has = (r) => PROVIDERS.some(([k]) => r[k]);
  const starts = (r) => PROVIDERS.filter(([k]) => r[k] && (!f.prov || f.prov === "any" || f.prov === k))
    .map(([k]) => r[k + "_start"]);
  const cell = (on, start, extra) => on
    ? `<td>${dpill("✓ " + (start || "on"), "pill-done")}${extra ? `<div class="muted" style="font-size:11px">${esc(extra)}</div>` : ""}</td>`
    : `<td><span class="muted">—</span></td>`;

  let page = 0;
  const render = () => {
    const list = rows.filter((r) =>
      (!dataQ || (r.company_name + " " + (r.dsp_short_code || "")).toLowerCase().includes(dataQ)) &&
      (!f.prov || (f.prov === "any" ? has(r) : f.prov === "none" ? !has(r) : r[f.prov])) &&
      (!f.status || r.live_status === f.status) &&
      ((!dr.from && !dr.to) || starts(r).some((d) => dfPass(d, dr))));
    const pg = pageSlice(list, page); page = pg.p;
    $("#data-body").innerHTML = `<div style="overflow-x:auto"><table class="grid"><thead><tr>
        <th>Client</th><th>Live status</th><th>DailyPay</th><th>ZayZoon</th><th>PayActiv</th><th>Checked</th>
      </tr></thead><tbody>${pg.rows.map((r) => `<tr>
        <td><b>${esc(r.company_name)}</b><div class="muted" style="font-size:11px">${esc(r.dsp_short_code || "")}</div></td>
        <td>${esc(r.live_status || "—")}</td>
        ${cell(r.dailypay, r.dailypay_start)}
        ${cell(r.zayzoon, r.zayzoon_start)}
        ${cell(r.payactiv, r.payactiv_start, r.payactiv_schedule && r.payactiv_schedule !== "SCHEDULED" ? r.payactiv_schedule : "")}
        <td>${fmtDate(r.checked_date)}</td></tr>`).join("") ||
      `<tr><td colspan="6" class="muted">${rows.length ? "No clients match." : "No EWA data yet — press Refresh from Uzio."}</td></tr>`}</tbody></table></div>` +
      pagerHtml("ewa", pg.p, pg.pages, list.length);
    hookPager("ewa", (d) => { page += d; render(); });
    const n = (k) => rows.filter((r) => r[k]).length;
    $("#data-count").textContent = `${list.length} of ${rows.length} clients · ` +
      PROVIDERS.map(([k, l]) => `${l} ${n(k)}`).join(" · ");
  };
  render.reset = () => { page = 0; };
  $("#ewa-prov").onchange = (e) => { f.prov = e.target.value; page = 0; render(); };
  $("#ewa-status").onchange = (e) => { f.status = e.target.value; page = 0; render(); };
  wireDateFilter("ewad", dr, () => { page = 0; render(); });
  return render;
}

/* --- Client 360 platform panel: the ops-dashboard facts for ONE client,
   rendered into #cd-platform at the bottom of the client detail page
   (Phase 4 of the merge). Read-only; empty sections are simply left out, and
   a fetch problem shows one muted line instead of breaking the page. --- */
async function loadPlatformPanel(c) {
  const chipsEl = document.getElementById("cd-chips");
  const glanceEl = document.getElementById("cd-glance");
  const el = document.getElementById("cd-platform");
  if (!chipsEl && !glanceEl && !el) return;
  let b;
  try { b = await Store.getPlatformBundle(c.short_code); }
  catch (e) { if (el) el.innerHTML = `<p class="muted">Platform data unavailable (${esc(e.message)}).</p>`; return; }

  const dmy = (d) => d ? esc(String(d).slice(0, 10)) : "—";
  const row = (label, val) => (val === null || val === undefined || val === "" || val === "—")
    ? "" : `<tr><td class="muted" style="width:220px">${label}</td><td>${val}</td></tr>`;
  const tbl = (rows) => rows ? `<table class="grid"><tbody>${rows}</tbody></table>` : "";
  const sect = (title, inner) => inner
    ? `<details class="cgroup"><summary><b>${title}</b></summary><div style="padding:0 14px 12px">${inner}</div></details>` : "";
  const p = b.profile, s = b.sys, cov = b.cov;

  /* Header chips: the three-line profile card was overkill for three facts. */
  if (chipsEl && p) {
    chipsEl.innerHTML = [
      p.fein ? `<span class="chip">FEIN ${esc(p.fein)}</span>` : "",
      p.state ? `<span class="chip">${esc(p.state)}</span>` : "",
      p.frequency ? `<span class="chip">Pay ${esc(p.frequency)}</span>` : "",
      p.payroll_live_date ? `<span class="chip">Payroll live ${dmy(p.payroll_live_date)}</span>` : "",
    ].join("");
  }

  /* At a glance: one number per topic, each clicking through to its Data tab.
     The full tables live there - repeating them per client is what made the
     page seven screens long. */
  if (glanceEl) {
    const stat = (hash, label, val) => val
      ? `<a href="${hash}" style="color:inherit"><span class="muted">${label}</span>&nbsp;<b>${val}</b></a>` : "";
    const okCount = (b.api || []).filter((r) => r.run_status === "ok" || r.last_ok_date).length;
    const hc = b.hist;
    const items = [
      cov ? stat("#data/coverage", "Coverage",
        `${dpct(cov.active_with_payment_method, cov.active_employees) ?? "?"}% pay · ${dpct(cov.active_with_emergency_contact, cov.active_employees) ?? "?"}% emg · ${dpct(cov.active_with_worker_comp, cov.active_employees) ?? "?"}% wc`) : "",
      hc ? stat("#data/hist", "Historical",
        `${dpct(hc.received, hc.received + hc.pending) ?? 0}%${hc.pending ? ` (${hc.pending} left)` : ""}`) : "",
      b.health ? stat("#data/health", "Payroll health",
        dpill(b.health.status || "?", b.health.status === "Covered" ? "pill-done" : b.health.status === "New to platform" ? "pill-na" : "pill-cancelled")) : "",
      b.docs ? stat("#data/docs", "Documents",
        `${b.docs.documents ?? 0} · ${dpct(b.docs.employees_with_docs, b.docs.total_employees) ?? "?"}% employees`) : "",
      b.api && b.api.length ? stat("#data/api", "APIs", `${okCount}/${API_MODULES.length} ✓`) : "",
      s && s.pr_normal_runs != null ? `<span><span class="muted">Pay runs</span>&nbsp;<b>${s.pr_normal_runs}</b></span>` : "",
    ].filter(Boolean);
    glanceEl.innerHTML = items.length
      ? `<div class="card" style="display:flex;gap:20px;flex-wrap:wrap;align-items:center;margin-bottom:0">${items.join("")}</div>` : "";
  }

  /* Journey stepper in the Client 360 hero: historical % sits under the Data
     migration step, and a contract-signed date (when Cuzio has one) replaces
     the fallback start the pace check measures from. */
  const histHtml = b.hist
    ? ` · Historical ${dpct(b.hist.received, b.hist.received + b.hist.pending) ?? 0}%` : "";
  const signedDate = b.signed && b.signed.contract_signed_date;
  const journeyEl = document.getElementById("c360-journey");
  if (journeyEl && signedDate && typeof journeyHtml === "function") {
    journeyEl.innerHTML = journeyHtml(c, { signedDate, histHtml });
  } else {
    const heroHist = document.getElementById("hero-hist");
    if (heroHist) heroHist.innerHTML = histHtml;
  }

  if (!el) return;

  const sysRows = s ? [
    row("TT setup", s.tt_setup_completed ? "Completed" : "Not completed"),
    row("TT enrolled", s.tt_enrolled_employees),
    row("First / last punch", s.tt_first_entry_date ? `${dmy(s.tt_first_entry_date)} → ${dmy(s.tt_last_entry_date)} · ${s.tt_employees_punched ?? "?"} employees` : null),
    row("TT entries", s.tt_live_entries != null ? `${s.tt_live_entries} live · ${s.tt_imported_entries ?? 0} imported` : null),
    row("Pay runs", s.pr_normal_runs ? `${s.pr_normal_runs} (${dmy(s.pr_first_normal_date)} → ${dmy(s.pr_last_normal_date)}, last covered ${s.pr_last_run_employees ?? "?"} employees)` : "None yet"),
    row("Prior payroll loads", s.pr_prior_loads),
    row("Checked", dmy(s.checked_date)),
  ].join("") : "";

  /* Benefits: the tracker's requirement and details columns overlap - when
     one contains the other, show it once. */
  const nrm = (t) => String(t || "").toLowerCase().replace(/\s+/g, " ").trim();
  const req = p && p.benefits_requirement, det = p && p.benefits_details;
  const benRows = (req || det) ? [
    row("Benefits", clampHtml(det || req)),
    (req && det && !nrm(det).includes(nrm(req).slice(0, 80))) ? row("Requirement", clampHtml(req)) : "",
    row("Deductions via Uzio", esc((p && p.benefits_deductions_via) || "")),
  ].join("") : "";

  const norm2 = (t) => String(t || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const tr = (b.transfers || []).find((t) => {
    const a = norm2(t.client_name), z = norm2(c.dsp_name);
    return a && z && (a.includes(z) || z.includes(a));
  });
  const docRows = (b.docs || tr) ? [
    b.docs ? row("In the database", `${b.docs.documents ?? 0} documents · ${b.docs.employees_with_docs ?? 0} of ${b.docs.total_employees ?? "?"} employees ${dbar(dpct(b.docs.employees_with_docs, b.docs.total_employees))}`) : "",
    tr ? row("Transfer", `${dpill(tr.status || "?", tr.status === "Complete" ? "pill-done" : "pill-onhold")} ${dmy(tr.transfer_date)} · ${tr.total_docs ?? "—"} docs${tr.failed_docs ? ` · <span class="overdue">${tr.failed_docs} failed</span>` : ""}`) : "",
    tr && tr.notes ? row("Transfer notes", `<span class="note">${clampHtml(tr.notes)}</span>`) : "",
  ].join("") : "";

  const apiByModule = {};
  (b.api || []).forEach((r) => { apiByModule[r.module_key] = r; });
  const apiChips = b.api && b.api.length ? API_MODULES.map(([m, label]) => {
    const r = apiByModule[m];
    if (!r) return dpill(label + " —", "pill-na");
    if (r.run_status === "ok" || r.last_ok_date) return dpill(label + " ✓", "pill-done");
    if (r.run_status === "last_failed") return dpill(label + " !", "pill-onhold");
    return dpill(label + " ✕", "pill-cancelled");
  }).join(" ") : "";

  const locRows = (b.locs || []).map((l) => `<div class="act-row">
      <b>${esc(l.work_location_name || "")}</b>${l.is_primary ? ` <span class="chip">Primary</span>` : ""}
      <div class="muted" style="font-size:12px">${esc([l.address_line1, l.address_line2, l.city, l.state, l.zip_code].filter(Boolean).join(", "))}</div>
    </div>`).join("");

  /* Signed modules: what the client's order form actually covers, extracted
     from Cuzio's customer page. Always open — it is the contract's scope, the
     first thing worth seeing about a client. Green = included, amber = TBD
     (deferred on the order form), grey = explicitly N/A. */
  const sm = b.signed;
  const smCard = sm && Array.isArray(sm.modules) && sm.modules.length
    ? `<div class="card" style="margin-bottom:14px"><h2 style="margin-top:0">Signed modules
        <span class="muted" style="font-size:11px;font-weight:400">order form, via Cuzio${sm.extracted_at ? ` · ${esc(String(sm.extracted_at).slice(0, 10))}` : ""}</span></h2>
      <div style="display:flex;gap:6px;flex-wrap:wrap">${sm.modules.map((m) => {
        const st = String(m.status || "included").toLowerCase();
        const cls = st === "included" ? "pill-done" : st === "tbd" ? "pill-onhold" : "pill-na";
        const label = m.name + (st === "tbd" ? " · TBD" : st === "na" ? " · N/A" : "");
        return `<span title="${esc(m.note || "")}">${dpill(label, cls)}</span>`;
      }).join("")}</div>
      ${sm.notes ? `<div class="muted" style="font-size:12px;margin-top:8px">${esc(sm.notes)}</div>` : ""}</div>`
    : "";

  const html = smCard +
    sect("System go-live — what prod shows", tbl(sysRows)) +
    sect("Benefits", tbl(benRows)) +
    sect("Documents", tbl(docRows)) +
    sect("Onboarding APIs", apiChips ? `<div style="display:flex;gap:6px;flex-wrap:wrap;padding-top:8px">${apiChips}</div>` : "") +
    sect("Work locations", locRows);
  el.innerHTML = html ||
    `<p class="muted">No platform data for this client yet (it appears after the daily pushes).</p>`;
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

  let show = "all", scanBefore = "", hVendor = "", hImpl = "";
  const hVendors = [...new Set(clients.map((c) => c.vendor).filter(Boolean))].sort();
  const hImpls = [...new Set(clients.map((c) => c.implementor).filter(Boolean))].sort();
  $("#data-extra").innerHTML = `<select id="h-filter">
    <option value="all">All clients</option>
    <option value="open">Still collecting</option>
    <option value="done">Complete</option></select>
    <select id="h-vendor"><option value="">All vendors</option>
      ${hVendors.map((v) => `<option>${esc(v)}</option>`).join("")}</select>
    <select id="h-impl"><option value="">All implementors</option>
      ${hImpls.map((v) => `<option>${esc(v)}</option>`).join("")}</select>
    <label style="display:inline-flex;align-items:center;gap:5px" class="muted">scanned before
      <input type="date" id="h-scanbefore" style="max-width:150px"></label>`;

  const oosBlock = (title, rows) => rows.length ? `<h2>${title}</h2>` +
    rows.map((o) => `<div class="act-row"><b>${esc(o.dsp_name || o.dsp_short_code)}</b>
      <span class="tag">${esc(o.reason || "")}</span>
      ${o.notes ? `<div class="muted" style="font-size:12px">${esc(o.notes)}</div>` : ""}</div>`).join("") : "";

  let page = 0;
  const render = () => {
    const list = clients.filter((c) =>
      (!dataQ || (c.dsp_name + " " + c.dsp_short_code).toLowerCase().includes(dataQ)) &&
      (show === "all" || (show === "done" ? c.pending === 0 : c.pending > 0)) &&
      (!hVendor || c.vendor === hVendor) && (!hImpl || c.implementor === hImpl) &&
      // "scanned before X" is a staleness hunt: never-scanned counts as stale.
      (!scanBefore || !c.last_scanned || String(c.last_scanned).slice(0, 10) < scanBefore))
      .sort((a, b) => pct(b) - pct(a) || a.dsp_name.localeCompare(b.dsp_name));
    const pg = pageSlice(list, page); page = pg.p;
    $("#data-body").innerHTML = pg.rows.map((c) => {
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
    $("#data-body").innerHTML += pagerHtml("hist", pg.p, pg.pages, list.length) +
      oosBlock("On hold (auto-resumes with the RAG)", hold) +
      oosBlock("Out of scope — do not chase", gone);
    hookPager("hist", (d) => { page += d; render(); });
    $("#data-count").textContent = `${list.length} of ${clients.length} tracked · ` +
      `${clients.filter((c) => c.pending > 0).length} still collecting`;
  };
  render.reset = () => { page = 0; };
  $("#h-filter").onchange = (e) => { show = e.target.value; page = 0; render(); };
  $("#h-scanbefore").onchange = (e) => { scanBefore = e.target.value; page = 0; render(); };
  $("#h-vendor").onchange = (e) => { hVendor = e.target.value; page = 0; render(); };
  $("#h-impl").onchange = (e) => { hImpl = e.target.value; page = 0; render(); };
  return render;
}
