/* Employee Profile Change Report, in the CRM.
   Port of the Streamlit tool (Deduction Tool/utils/change_report.py), which is
   itself a port of Uzio's own generator (EmployeeAuditPoiReport /
   EmployeeAuditMapping / EmployeeHistoryCustomConvertorImpl): same sheet, same
   labels, same order, same value formats. The data comes from prod-refresh
   (ecr.ts) under the reader's own Uzio login; the workbook is built here, one
   employee per request, so a big batch never meets the function's time limit.

   What it cannot show, exactly as the Streamlit tool: SSN and pay fields are
   encrypted at rest (cells read "(encrypted)"; the effective date beside a pay
   field still moves when the rate changes), and Work Schedule / Family are not
   exposed by the query endpoint. */
const ECR = (() => {
  const SHEET = "Change History";
  const ENCRYPTED = "(encrypted)";
  const VERSION_STR = "Version: V";
  const EFFECTIVE_PREFIX = " (Effective Date - ";
  const GENDER = { 0: "Male", 1: "Female", 2: "Intersex" };
  const STATUS = { 0: "UNDER_PROVISION", 1: "ACTIVE", 2: "TERMINATED", 3: "DECEASED", 4: "DELETED", 5: "FUTURE_HIRE" };
  const EMPLOYMENT_TYPE = { 0: "Part Time", 1: "Full Time", 2: "Both Part Time and Full Time",
    3: "Others", 4: "All", 5: "Term", 6: "Seasonal" };
  const TERMINATION = { DEATH: "Death", RETIREMENT: "Retirement", DISABILITY: "Permanent Disability",
    QUIT: "Voluntary Termination of Employment", FIRED: "Involuntary Termination of Employment",
    TRANSFER: "Transfer", OTHER: "Other" };
  const SOURCE = { USER_INTERFACE: "User Interface", CENSUS: "Census Template",
    ENROLLMENT: "Enrollment Update", PAYROLL_INTEGRATION: "Payroll Integration" };

  // [section, label, kind, column, effective-date key]
  const FIELDS = [
    ["Personal", "Employee Prefix", "text", "salutation", null],
    ["Personal", "Employee First Name", "text", "first_name", null],
    ["Personal", "Employee Middle Initial", "text", "middle_name", null],
    ["Personal", "Employee Last Name", "text", "last_name", null],
    ["Personal", "Employee Suffix", "text", "name_suffix", null],
    ["Personal", "Employee Date of Birth", "date", "date_of_birth", null],
    ["Personal", "Employee Gender", "gender", "gender", null],
    ["Personal", "Employee Marital Status", "marital", "marital_status", null],
    ["Personal", "Employee SSN", "encrypted", "ssn", null],
    ["Personal", "Employee Tobacco usage in last 12 months", "bool", "is_smoker", null],
    ["Job", "Employee ID", "text", "ext_employee_code", null],
    ["Job", "Employment Status", "status", "status", null],
    ["Job", "Date of Hire", "date", "date_of_hire", null],
    ["Job", "Adjusted Service Date", "date", "adjusted_service_date", null],
    ["Job", "Termination Date", "date", "date_of_termination", null],
    ["Job", "Termination Reason", "termination", "termination_type", null],
    ["Job", "Employment Type", "employment_type", "employment_type", "EMPLOYEMENT_TYPE_I"],
    ["Job", "Others (Employment Type)", "text", "other_employment_type", null],
    ["Job", "Pay Type", "text", "pay_type", "PAY_TYPE"],
    ["Job", "Pay Group", "text", "pay_group_name", "PAY_GROUP"],
    ["Job", "Annual Salary", "encrypted", "annual_salary", "ANNUAL_SALARY"],
    ["Job", "Salary Effective Date", "date", "salary_effective_date", null],
    ["Job", "Working Hours per Week", "text", "hours", "WORKING_HOURS_PER_WEEK"],
    ["Job", "Hourly Pay Rate", "encrypted", "hourly_rate", "HOURLY_RATE"],
    ["Job", "Benefits Class", "text", "class_name", "CLASS"],
    ["Job", "Job Title", "text", "designation", "JOB_TITLE"],
    ["Job", "Department", "text", "department", "DEPARTMENT"],
    ["Job", "Employee Type", "text", "employment_type_two", null],
    ["Job", "Union Classification", "text", "employment_classification_one", null],
    ["Job", "FLSA Classification", "text", "employment_classification_two", null],
    ["Job", "Work Location", "text", "work_location", null],
    ["Job", "Division", "text", "division", "DIVISION"],
    ["Job", "Bonus", "encrypted", "bonus", "BONUS"],
    ["Job", "Salary Commissions", "encrypted", "commission", "COMMISSION"],
    ["Job", "Reporting Manager", "text", "reporting_to_name", null],
    ["Job", "Special Hire", "bool", "special_hire_flag", null],
    ["Job", "Protected Veteran Status", "text", "protected_veteran_status", null],
    ["Job", "Disability Status", "text", "disability_status", null],
    ["Job", "EEO Job Category", "text", "eeo_job_category", null],
    ["Job", "Race/Ethnicity", "text", "race_ethnicity", null],
    ["Job", "Original DOH", "date", "original_doh", null],
    ["Job", "Work Schedule", "text", "work_week_schedule_name", null],
    ["Contact", "Personal Email", "text", "email", null],
    ["Contact", "Official Email", "text", "emailofficial", null],
    ["Contact", "Phone Number(Digits)", "phone", "phone", null],
    ["Contact", "Employee Address Line 1", "text", "address_line1", "ADDRESS"],
    ["Contact", "Employee Address Line 2", "text", "address_line2", "ADDRESS"],
    ["Contact", "City", "text", "city", "ADDRESS"],
    ["Contact", "Zip Code", "text", "zip", "ADDRESS"],
    ["Contact", "State(Abbreviation)", "text", "state", "ADDRESS"],
    ["Contact", "County", "text", "county", "ADDRESS"],
  ];
  const AMAZON_SKIPPED = "Union Classification";   // Uzio drops it for an Amazon exchange
  const EMERGENCY_SECTION = "Emergency Contact Details";
  const EMERGENCY_FIELDS = [
    ["Name", "text", "name"], ["Relationship", "text", "relationship"],
    ["Address (Line 1)", "text", "address_line1"], ["Address (Line 2)", "text", "address_line2"],
    ["City", "text", "city"], ["Zip Code", "text", "zip"], ["County", "text", "county"],
    ["State(Abbreviation)", "text", "state"], ["Email ID", "text", "email"],
    ["Phone Number(Digits)", "phone", "phone"],
    ["CA Arrest/Detention Notification Authorization", "lower_bool", "detention_arrest_consent"],
  ];
  const CUSTOM_SECTION = "Custom Fields";

  /* ---- values ---- */
  const pad = (n) => String(n).padStart(2, "0");
  const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/;
  function parse(value) {
    if (value === null || value === undefined || value === "" || value === "None") return null;
    const m = String(value).trim().match(ISO);
    if (!m) return null;
    return { y: +m[1], mo: +m[2], d: +m[3], h: +(m[4] || 0), mi: +(m[5] || 0), s: +(m[6] || 0), tz: m[7] || null };
  }
  function date(value) {
    const p = parse(value);
    return p ? `${pad(p.mo)}/${pad(p.d)}/${p.y}` : "";
  }
  /** Modified On, as Uzio prints it: 09/09/2026 07:33:57 PM UTC. */
  function modifiedOn(value) {
    let p = parse(value);
    if (!p) return "";
    if (p.tz) {   // aware: convert to UTC; naive: printed as stored
      const off = p.tz === "Z" ? 0 : (p.tz[0] === "-" ? -1 : 1) *
        (Number(p.tz.slice(1, 3)) * 60 + Number(p.tz.slice(-2)));
      const t = new Date(Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - off * 60000);
      p = { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate(), h: t.getUTCHours(), mi: t.getUTCMinutes(), s: t.getUTCSeconds() };
    }
    const h12 = p.h % 12 === 0 ? 12 : p.h % 12;
    return `${pad(p.mo)}/${pad(p.d)}/${p.y} ${pad(h12)}:${pad(p.mi)}:${pad(p.s)} ${p.h < 12 ? "AM" : "PM"} UTC`;
  }
  function json(value) {
    if (!value) return {};
    if (typeof value !== "string") return value;
    try { return JSON.parse(value); } catch { return {}; }
  }
  function phone(value) {   // the generator's rule: leave "-" alone, else 3/3/rest
    const t = String(value ?? "").trim();
    if (!t || t.includes("-") || t.length < 7) return t;
    return `${t.slice(0, 3)}-${t.slice(3, 6)}-${t.slice(6)}`;
  }
  const normalize = (v) => String(v).replace(/&#96;/g, "`");
  const isDigits = (v) => /^-?\d+$/.test(String(v));
  const truthy = (v) => v === true || v === 1 || ["1", "True", "true"].includes(String(v));
  const title = (s) => s.replace(/[A-Za-z]+/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());

  /** "tierra.williams1@uzio.com" -> "Tierra Williams (CSR)" when the user tables gave nothing. */
  function personLabel(email) {
    email = String(email ?? "").trim();
    if (!email || email === "System" || email === "SCRIPT") return email;
    const at = email.indexOf("@");
    if (at < 0 || !email.slice(at + 1).toLowerCase().endsWith("uzio.com")) return email;
    const parts = email.slice(0, at).replace(/_/g, ".").split(".").filter(Boolean);
    const stripDigits = (p) => p.replace(/^\d+|\d+$/g, "");
    if (parts.length >= 2 && parts.every((p) => /^[A-Za-z]+$/.test(stripDigits(p))))
      return parts.map((p) => { const s = stripDigits(p); return s[0].toUpperCase() + s.slice(1).toLowerCase(); }).join(" ") + " (CSR)";
    return `${email} (CSR)`;
  }
  const whoChanged = (row) => row.who_changed || personLabel(row.created_by);

  function effectiveDate(row, key) {
    const found = (json(row.job_effective_dates) || {})[key];
    if (found) return String(found);
    return key === "ADDRESS" ? "--" : date(row.salary_effective_date);
  }

  function cellValue(row, kind, column, effectiveKey) {
    if (kind === "custom") {
      for (const item of (json(row.custom_field) || [])) {
        if (item && typeof item === "object" && item.key === column) {
          return item.value === null || item.value === undefined || item.value === "" ? "" : normalize(item.value);
        }
      }
      return "";
    }
    const raw = row[column];
    const blank = raw === null || raw === undefined || raw === "" || raw === "None";
    let value;
    if (kind === "encrypted") value = blank ? "" : ENCRYPTED;
    else if (kind === "bool") value = truthy(raw) ? "Yes" : "No";   // normalised even when unset
    else if (blank) value = "";
    else if (kind === "date") value = date(raw);
    else if (kind === "gender") value = isDigits(raw) ? (GENDER[+raw] || "") : normalize(raw);
    else if (kind === "status") {
      const name = isDigits(raw) ? (STATUS[+raw] || String(raw)) : String(raw);
      value = name === "FUTURE_HIRE" ? "ACTIVE" : name;
    }
    else if (kind === "employment_type") value = isDigits(raw) ? (EMPLOYMENT_TYPE[+raw] || "") : normalize(raw);
    else if (kind === "marital") value = title(String(raw).replace(/_/g, " "));
    else if (kind === "termination") value = TERMINATION[String(raw).toUpperCase()] || normalize(raw);
    else if (kind === "phone") value = phone(raw);
    else if (kind === "lower_bool") value = truthy(raw) ? "true" : "false";
    else value = normalize(raw);
    if (value && effectiveKey) value = `${value}${EFFECTIVE_PREFIX}${effectiveDate(row, effectiveKey)})`;
    return value;
  }

  /* ---- grid: what goes in which cell, in which style. Kept free of any
     spreadsheet library so it can be checked against the Python original. ---- */
  function buildGrid(versionsOldestFirst, contacts) {
    const versions = versionsOldestFirst.map((v, i) => ({ ...v, _number: i + 1 }));
    const newest = versions.slice().reverse();
    const n = newest.length;
    const col = (i) => 3 + i * 2;
    const cells = {};   // "r,c" -> {v, style}
    const put = (r, c, v, style) => { cells[`${r},${c}`] = { v: v === "" ? null : v, style }; };
    const spacers = (r) => { for (let i = 0; i < n; i++) put(r, col(i) + 1, null, "red"); };

    newest.forEach((v, i) => {
      const lines = [
        "Version: " + VERSION_STR + v._number,
        "Who Changed: " + whoChanged(v),
        "Modified On: " + modifiedOn(v.created_date),
        "IP Address: " + (v.ip_address || ""),
        "Source of Change: " + (SOURCE[String(v.source || "")] || String(v.source || "")),
      ];
      lines.forEach((t, k) => put(1 + k, col(i), t, "blue"));
      put(6, col(i), null, "big");
    });
    for (let r = 1; r <= 6; r++) spacers(r);
    put(6, 1, "Section", "blue");
    put(6, 2, "EE Profile Details", "blue");

    let row = 7;
    const line = (section, label, values) => {
      const changed = new Set(values).size > 1;
      put(row, 1, section, changed ? "green" : null);
      put(row, 2, label, changed ? "green" : null);
      values.forEach((v, i) => put(row, col(i), v || null, changed ? "green_center" : "center"));
      spacers(row);
      row++;
    };

    for (const [section, label, kind, column, key] of FIELDS) {
      const values = newest.map((v) => cellValue(v, kind, column, key));
      if (label === AMAZON_SKIPPED && !values.some(Boolean)) continue;
      line(section, label, values);
    }
    const keys = [];
    for (const v of newest) for (const item of (json(v.custom_field) || [])) {
      if (item && typeof item === "object" && !keys.includes(item.key)) keys.push(item.key);
    }
    for (const key of keys) line(CUSTOM_SECTION, normalize(key), newest.map((v) => cellValue(v, "custom", key)));

    // One 11-row block per emergency-contact identifier, sorted, padded per version.
    const perVersion = newest.map((v) => {
      const byId = {};
      for (const c of (contacts || {})[String(v.id)] || []) byId[c.emergency_contact_identifier] = c;
      return byId;
    });
    const ids = [...new Set(perVersion.flatMap((m) => Object.keys(m)))].filter((k) => k && k !== "null" && k !== "undefined").sort();
    for (const id of ids) for (const [label, kind, column] of EMERGENCY_FIELDS) {
      line(EMERGENCY_SECTION, label, perVersion.map((m) => (m[id] ? cellValue(m[id], kind, column) : "")));
    }
    return { cells, rows: row - 1, versions: n, col };
  }

  const STYLES = {
    blue: { fill: "FF95B3D7", bold: true },
    red: { fill: "FFC00000" },
    big: { fill: "FFC6D9F0", size: 14 },
    center: { center: true },
    green: { fill: "FFD9F0F3", bold: true },
    green_center: { fill: "FFD9F0F3", bold: true, center: true },
  };

  async function toXlsx(grid) {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(SHEET, { views: [{ state: "frozen", xSplit: 0, ySplit: 1 }] });
    ws.getColumn(1).width = 25;
    ws.getColumn(2).width = 33;
    for (let i = 0; i < grid.versions; i++) {
      ws.getColumn(grid.col(i)).width = 50;
      ws.getColumn(grid.col(i) + 1).width = 1.5;
    }
    for (const [key, cell] of Object.entries(grid.cells)) {
      const [r, c] = key.split(",").map(Number);
      const x = ws.getCell(r, c);
      if (cell.v !== null) x.value = cell.v;
      const st = STYLES[cell.style];
      if (!st) continue;
      if (st.fill) x.fill = { type: "pattern", pattern: "solid", fgColor: { argb: st.fill } };
      if (st.bold || st.size) x.font = { ...(st.bold ? { bold: true } : {}), ...(st.size ? { size: st.size } : {}) };
      x.alignment = { wrapText: true, ...(st.center ? { horizontal: "center" } : {}) };
    }
    return wb.xlsx.writeBuffer();
  }

  function filename(when, employee) {
    const tag = String(employee || "").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
    const s = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}-${pad(when.getHours())}-${pad(when.getMinutes())}-${pad(when.getSeconds())}`;
    return tag ? `Employee Profile Change Report_${tag}_${s}.xlsx` : `Employee Profile Change Report_${s}.xlsx`;
  }

  return { buildGrid, toXlsx, filename, cellValue, modifiedOn, whoChanged, SOURCE, VERSION_STR, ENCRYPTED };
})();

if (typeof module !== "undefined" && module.exports) module.exports = ECR;

/* ---- the drawer (browser only) ---- */
const OPS_TOKEN_KEY = "uzio_ops_token", OPS_USER_KEY = "uzio_ops_user";
const ECR_BATCH_LIMIT = 300, ECR_SECONDS_EACH = 4;
const ECR_LIBS = [
  ["ExcelJS", "https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.4.0/exceljs.min.js"],
  ["JSZip", "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js"],
];
function ecrLoadLibs() {
  return Promise.all(ECR_LIBS.map(([g, src]) => window[g] ? null : new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = src; s.onload = res; s.onerror = () => rej(new Error("Could not load " + g + " — check the network and retry."));
    document.head.appendChild(s);
  })));
}
function ecrDownload(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
const ecrStatus = (row) => ECR.cellValue(row, "status", "status");
const ecrDate = (v) => (v ? String(v).slice(0, 10) : "");

/** Opens the Employee Profile Change Report drawer for one CRM client. */
function changeReportDrawer(client, fein) {
  document.getElementById("log-drawer")?.remove();
  const d = document.createElement("div");
  d.id = "log-drawer";
  d.innerHTML = `<div class="ld-backdrop"></div><aside class="ld-panel" role="dialog" aria-label="Employee profile change report">
    <div class="ld-head"><div><h2 style="margin:0">Employee profile change report</h2>
      <span class="muted" style="font-size:12px">${esc(client.dsp_name)}${fein ? ` · FEIN ${esc(fein)}` : ""} · the same workbook Uzio exports</span></div>
      <button type="button" class="linkish ld-x" aria-label="Close">✕</button></div>
    <div class="ld-body"></div></aside>`;
  document.body.appendChild(d);
  const body = d.querySelector(".ld-body");
  let busy = false;
  const close = () => { if (busy && !confirm("Reports are still being built. Close anyway?")) return; d.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  d.querySelector(".ld-x").onclick = close;
  d.querySelector(".ld-backdrop").onclick = close;

  const call = (b) => callProdFn({ ...b, opsToken: ssGet(OPS_TOKEN_KEY) });

  const showLogin = (msg, typedUser) => {
    body.innerHTML = `<div class="card" style="box-shadow:none;background:var(--surface-cont-low)">
      <h2 style="margin-top:0">Sign in with your Uzio login</h2>
      <p class="muted" style="font-size:13px;margin-top:0">Your Uzio platform account, not the CRM one. It opens a
        read-only session; the password is not stored, and every read is audited in prod under your name.
        The session ends when you close this tab.</p>
      ${msg ? `<p class="overdue" style="font-size:13px">${esc(msg)}</p>` : ""}
      <form id="ecr-login" style="display:flex;flex-direction:column;gap:10px">
        <input id="ecr-u" type="email" autocomplete="username" placeholder="firstname.lastname@uzio.com" required style="max-width:none">
        <input id="ecr-p" type="password" autocomplete="current-password" placeholder="Uzio password" required style="max-width:none">
        <button type="submit">Sign in</button>
      </form></div>`;
    $("#ecr-u").value = typedUser || ssGet(OPS_USER_KEY) || ssGet(OB_USER_KEY) || "";
    ($("#ecr-u").value ? $("#ecr-p") : $("#ecr-u")).focus();
    $("#ecr-login").onsubmit = async (e) => {
      e.preventDefault();
      const btn = e.target.querySelector("button"); btn.disabled = true; btn.textContent = "Signing in…";
      const pw = $("#ecr-p"); const password = pw.value; pw.value = "";
      const username = $("#ecr-u").value.trim();
      try {
        const out = await callProdFn({ action: "ops_login", username, password });
        ssSet(OPS_TOKEN_KEY, out.token); ssSet(OPS_USER_KEY, out.user);
        showSearch();
      } catch (err) { showLogin(err.message, username); }
    };
  };

  let matches = [];
  const picked = new Set();
  const showSearch = () => {
    body.innerHTML = `<div class="muted" style="font-size:12px;display:flex;gap:8px;align-items:center;margin-bottom:12px">
        Uzio: <b>${esc(ssGet(OPS_USER_KEY) || "")}</b>
        <button type="button" class="linkish" id="ecr-out" style="font-size:12px">Sign out of Uzio</button></div>
      <form id="ecr-find" class="card" style="box-shadow:none;border:1px solid var(--line)">
        <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-start">
          <label style="display:flex;flex-direction:column;gap:4px;font-size:12px" class="muted">Company FEIN
            <input id="ecr-fein" value="${esc(fein || "")}" placeholder="9 digits" style="width:150px"></label>
          <label style="display:flex;flex-direction:column;gap:4px;font-size:12px;flex:1;min-width:220px" class="muted">Employee IDs (optional — leave empty for everyone)
            <textarea id="ecr-ids" rows="2" placeholder="1020, BH0KS5HPZ — commas, new lines or a column pasted from Excel"></textarea></label>
          <button type="submit" style="margin-top:18px">Search</button>
        </div></form>
      <div id="ecr-results"></div>`;
    $("#ecr-out").onclick = () => { ssSet(OPS_TOKEN_KEY, null); showLogin(); };
    $("#ecr-find").onsubmit = (e) => { e.preventDefault(); search(); };
    if (fein) search();
  };

  const search = async () => {
    const box = $("#ecr-results");
    const ids = $("#ecr-ids").value.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
    const f = $("#ecr-fein").value.replace(/\D/g, "");
    if (!f && !ids.length) { box.innerHTML = `<p class="overdue">Enter the company FEIN, or at least one Employee ID.</p>`; return; }
    box.innerHTML = `<p class="muted">Searching…</p>`;
    try {
      const out = await call({ action: "ecr_find", feins: f ? [f] : [], ids });
      matches = out.employees || [];
      picked.clear();
      const notes = [];
      if ((out.unknownFeins || []).length) notes.push(`No company in Uzio has FEIN ${out.unknownFeins.join(", ")}.`);
      const seen = new Set(matches.flatMap((m) => [String(m.ext_employee_code), String(m.found_via || "").replace("was ", "")]));
      const missing = ids.filter((i) => !seen.has(i));
      if (missing.length) notes.push(`No employee found for: ${missing.join(", ")}`);
      renderResults(notes);
    } catch (e) {
      if (e.needLogin) return showLogin(e.message);
      box.innerHTML = `<p class="overdue">${esc(e.message)}</p>`;
    }
  };

  let filter = "";
  const renderResults = (notes = []) => {
    const box = $("#ecr-results");
    const list = matches.filter((m) => !filter ||
      `${m.full_name} ${m.ext_employee_code} ${m.found_via || ""}`.toLowerCase().includes(filter));
    box.innerHTML = notes.map((t) => `<p class="overdue" style="font-size:13px">${esc(t)}</p>`).join("") +
      (matches.length ? `<div class="filter-bar" style="margin-top:12px">
        <input id="ecr-q" type="search" placeholder="Filter by name or ID…" value="${esc(filter)}">
        <button type="button" class="small secondary" id="ecr-all">Select ${list.length === matches.length ? "all" : "shown"} (${list.length})</button>
        <button type="button" class="linkish" id="ecr-none">Clear</button>
        <span class="muted" style="margin-left:auto">${matches.length} employee${matches.length === 1 ? "" : "s"}</span></div>
      <div style="max-height:46vh;overflow:auto;border:1px solid var(--line);border-radius:var(--r-md)">
      <table class="grid" style="border:none"><thead><tr><th></th><th>Employee</th><th>ID</th><th>Status</th><th>Hired</th><th>Terminated</th></tr></thead>
      <tbody>${list.map((m) => `<tr class="rowlink" data-code="${esc(m.employee_code)}">
        <td><input type="checkbox" ${picked.has(m.employee_code) ? "checked" : ""}></td>
        <td><b>${esc(m.full_name || "")}</b>${m.found_via ? `<div class="muted" style="font-size:11px">${esc(m.found_via)}</div>` : ""}</td>
        <td>${esc(m.ext_employee_code || "")}</td><td>${esc(ecrStatus(m))}</td>
        <td>${esc(ecrDate(m.date_of_hire))}</td><td>${esc(ecrDate(m.date_of_termination))}</td></tr>`).join("") ||
        `<tr><td colspan="6" class="muted">No employees match the filter.</td></tr>`}</tbody></table></div>
      <div style="display:flex;gap:12px;align-items:center;margin-top:12px;flex-wrap:wrap">
        <button type="button" id="ecr-go"></button><span id="ecr-hint" class="muted" style="font-size:12px"></span>
      </div><div id="ecr-out-box"></div>` : `<p class="muted">No employees matched.</p>`);
    if (matches.length) footer();
    if (!matches.length) return;
    $("#ecr-q").oninput = (e) => { filter = e.target.value.trim().toLowerCase(); renderResults(); $("#ecr-q").focus(); };
    $("#ecr-all").onclick = () => { list.forEach((m) => picked.add(m.employee_code)); renderResults(); };
    $("#ecr-none").onclick = () => { picked.clear(); renderResults(); };
    // A tick only updates its own checkbox and the footer, so a long list keeps its scroll.
    box.querySelectorAll("tr[data-code]").forEach((tr) => (tr.onclick = () => {
      const c = tr.dataset.code;
      picked.has(c) ? picked.delete(c) : picked.add(c);
      tr.querySelector("input").checked = picked.has(c);
      footer();
    }));
    $("#ecr-go").onclick = () => { if (picked.size <= ECR_BATCH_LIMIT) generate([...picked]); };
  };

  const footer = () => {
    const n = picked.size, mins = (n * ECR_SECONDS_EACH) / 60;
    const go = $("#ecr-go"), hint = $("#ecr-hint");
    if (!go) return;
    go.textContent = `Generate ${n || ""} report${n === 1 ? "" : "s"}`.replace("  ", " ");
    go.disabled = busy || n === 0 || n > ECR_BATCH_LIMIT;
    hint.innerHTML = n > ECR_BATCH_LIMIT ? `<span class="overdue">At most ${ECR_BATCH_LIMIT} at a time.</span>`
      : n ? `about ${mins < 1.5 ? Math.round(mins * 60) + " seconds" : Math.round(mins) + " minutes"} — keep this panel open`
      : "Tick the employees to report on.";
  };

  const generate = async (codes) => {
    const out = $("#ecr-out-box");
    const byCode = Object.fromEntries(matches.map((m) => [m.employee_code, m]));
    busy = true;
    $("#ecr-go").disabled = true;
    try {
      out.innerHTML = `<p class="muted">Loading the spreadsheet builder…</p>`;
      await ecrLoadLibs();
      const stamp = new Date();
      const built = [], skipped = [];
      for (let i = 0; i < codes.length; i++) {
        const m = byCode[codes[i]] || {};
        const label = m.full_name || m.ext_employee_code || codes[i];
        out.innerHTML = `<div class="ld-banner">Reading change history — ${esc(label)} (${i + 1} of ${codes.length})</div>`;
        const r = await call({ action: "ecr_versions", employeeCode: codes[i] });
        if (!r.versions.length) { skipped.push(label); continue; }
        const buf = await ECR.toXlsx(ECR.buildGrid(r.versions, r.contacts));
        built.push({ label, name: ECR.filename(stamp, m.ext_employee_code || label), buf, versions: r.versions.length });
      }
      const xlsx = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
      out.innerHTML = (skipped.length ? `<p class="muted" style="font-size:13px">No change history exists for: ${esc(skipped.join(", "))}</p>` : "") +
        (built.length ? `<div class="card" style="box-shadow:none;border:1px solid var(--line);margin-top:10px">
          <b>${built.length} report${built.length === 1 ? "" : "s"} ready</b>
          <span class="muted" style="font-size:12px"> · one file per employee, newest version in the first column</span>
          <div style="margin:10px 0">${built.length > 1 ? `<button type="button" id="ecr-zip">Download all ${built.length} (.zip)</button>` : ""}</div>
          ${built.map((b, i) => `<div class="act-row"><button type="button" class="linkish" data-dl="${i}">${esc(b.label)}</button>
            <span class="muted" style="font-size:12px">${b.versions} version${b.versions === 1 ? "" : "s"}</span></div>`).join("")}
          <p class="muted" style="font-size:12px;margin-bottom:0">SSN and pay fields show "${ECR.ENCRYPTED}" — they are encrypted at rest. The effective date beside a pay field still moves in the version where the rate changed.</p>
        </div>` : "");
      out.querySelectorAll("[data-dl]").forEach((b) => (b.onclick = () => {
        const x = built[+b.dataset.dl]; ecrDownload(new Blob([x.buf], { type: xlsx }), x.name);
      }));
      const zipBtn = $("#ecr-zip");
      if (zipBtn) zipBtn.onclick = async () => {
        const zip = new JSZip();
        built.forEach((b) => zip.file(b.name, b.buf));
        const p = (n) => String(n).padStart(2, "0");
        const s = `${stamp.getFullYear()}-${p(stamp.getMonth() + 1)}-${p(stamp.getDate())}-${p(stamp.getHours())}-${p(stamp.getMinutes())}-${p(stamp.getSeconds())}`;
        ecrDownload(await zip.generateAsync({ type: "blob" }), `Employee Profile Change Reports_${s}.zip`);
      };
      if (built.length === 1) ecrDownload(new Blob([built[0].buf], { type: xlsx }), built[0].name);
    } catch (e) {
      if (e.needLogin) { busy = false; return showLogin(e.message); }
      out.innerHTML = `<p class="overdue">${esc(e.message)}</p>`;
    } finally {
      busy = false;
      footer();
    }
  };

  ssGet(OPS_TOKEN_KEY) ? showSearch() : showLogin();
}
