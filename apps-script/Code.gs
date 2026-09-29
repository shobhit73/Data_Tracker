/**
 * Code.gs - the whole DSP Historical Data Mail pipeline in one file.
 *
 * Everything except settings lives here, in sections:
 *   SHEET      - the tracker Google Sheet is the database; only this section
 *                reads or writes it
 *   SCAN       - Drive walk + filename->report matching
 *   DISCOVERY  - Drive + onboarding tracker decide who is in scope;
 *                RAG hold/resume sync; one-time cleanup helpers
 *   MAIL       - the daily mail (HTML + plain text) and the day-over-day
 *                snapshot
 *   MAIN       - entry points: runDaily, previewOnly, scanOnly, discoverOnly,
 *                checkSetup, installTrigger, removeTrigger
 *
 * Settings you may edit (SHEET_ID, MAIL_TO, tab names, limits) are in the
 * separate config file - code updates replace THIS file only and never touch
 * your settings.
 */


/* ======================================================================
 * SHEET
 * ====================================================================== */

/**
 * Sheet.gs — the Google Sheet IS the database. This file is the only place
 * that reads or writes it.
 *
 * Replaces the old Supabase.gs. `loadAll()` deliberately returns the same
 * shape the Supabase loader did, so Scan.gs and Mail.gs did not have to be
 * rewritten when the store changed.
 *
 * Reads are batched (one getValues per tab) and writes are batched (one
 * setValues per tab). Apps Script charges roughly a fixed cost per Sheet call,
 * so per-cell writes would blow the 6-minute budget on a wide tab.
 */

function ss_() {
  var id = sheetId();
  if (!id || id.indexOf('PASTE') === 0) {
    throw new Error('SHEET_ID is not set in Config.gs. Copy it out of the ' +
                    'tracker sheet URL: docs.google.com/spreadsheets/d/<id>/edit');
  }
  try {
    return SpreadsheetApp.openById(id);
  } catch (e) {
    // Much the likeliest cause: the file is still the uploaded .xlsx rather
    // than a real Google Sheet. Apps Script cannot open an Office file, and
    // Drive's own error says nothing about that.
    throw new Error(
      'Could not open the sheet (id "' + id + '"). If the file was uploaded ' +
      'as .xlsx, open it in Drive and use File > Save as Google Sheets, then ' +
      'use the NEW file\'s id here. Original error: ' + e.message);
  }
}

function tab_(name) {
  var sh = ss_().getSheetByName(name);
  if (!sh) throw new Error('Tab "' + name + '" not found in the tracker sheet.');
  return sh;
}

/** Rows below the header, as arrays. */
function rows_(sheet) {
  var values = sheet.getDataRange().getValues();
  return values.length > 1 ? values.slice(1) : [];
}

/**
 * Everything the mail and the scan need.
 *
 * catalog entries are one per (report, unit) pair rather than one per report -
 * the Catalog tab is keyed that way because a sheet column IS a report-unit.
 * Consumers only read .vendor/.category/.report_name off them, so the change
 * is invisible to Scan.gs and Mail.gs.
 */
function loadAll() {
  var catalog = rows_(tab_(TAB_CATALOG))
    .filter(function (r) { return r[0] && r[2]; })
    .map(function (r, i) {
      return {
        id: i + 1,
        vendor: String(r[0]).trim(),
        category: String(r[1]).trim(),
        report_name: String(r[2]).trim(),
        unit_label: String(r[3]).trim(),
        header: String(r[4]).trim(),
        sort_order: i
      };
    });

  var overview = [], scope = [];
  rows_(tab_(TAB_CLIENTS)).forEach(function (r) {
    if (!r[0]) return;
    var code = String(r[0]).trim();
    overview.push({
      dsp_short_code: code,
      dsp_name: String(r[1] || code).trim(),
      implementor: String(r[2] || '').trim()
    });
    scope.push({
      dsp_short_code: code,
      vendor: String(r[3] || '').trim(),
      folder_url: String(r[4] || '').trim() || null,
      // Per-client rather than per-report: one scan covers a whole client, so
      // a single 'Last Scanned' is the honest granularity.
      last_scanned: r[5] ? formatSheetDate_(r[5]) : null
    });
  });

  // Catalog lookup by (vendor, column header) - how a status cell finds its
  // report. Header text is the join key, so a header may be reworded only if
  // the Catalog tab is reworded with it.
  var byHeader = {};
  catalog.forEach(function (c) { byHeader[c.vendor + '|' + c.header] = c; });

  var nameToCode = {};
  overview.forEach(function (o) { nameToCode[o.dsp_name] = o.dsp_short_code; });
  var vendorOf = {};
  scope.forEach(function (s) { vendorOf[s.dsp_short_code] = s.vendor; });
  var scannedOf = {};
  scope.forEach(function (s) { scannedOf[s.dsp_short_code] = s.last_scanned; });

  var status = [];
  Object.keys(STATUS_TABS).forEach(function (vendor) {
    var sh = ss_().getSheetByName(STATUS_TABS[vendor]);
    if (!sh) return;
    var values = sh.getDataRange().getValues();
    if (values.length < 2) return;
    var headers = values[0];
    for (var r = 1; r < values.length; r++) {
      var clientName = String(values[r][0] || '').trim();
      if (!clientName) continue;
      var code = nameToCode[clientName];
      if (!code) continue;           // a row nobody listed on Clients
      for (var c = 1; c < headers.length; c++) {
        var head = String(headers[c] || '').trim();
        if (!head) continue;
        var cat = byHeader[vendor + '|' + head];
        if (!cat) continue;          // a column with no Catalog entry
        var cell = String(values[r][c] || '').trim();
        status.push({
          dsp_short_code: code,
          report_id: cat.id,
          unit_label: cat.unit_label,
          // Sheet speaks Present/Missing/N/A; the rest of the code speaks
          // Received/Pending/Not applicable. Translate once, here.
          status: cell === ST_PRESENT ? 'Received'
                : cell === ST_NA ? 'Not applicable' : 'Pending',
          checked_date: scannedOf[code] || null
        });
      }
    }
  });

  var excluded = [];
  var exTab = ss_().getSheetByName(TAB_EXCLUDED);
  if (exTab) {
    rows_(exTab).forEach(function (r) {
      if (r[0]) excluded.push({ notes: String(r[3] || '').trim(),
                                dsp_short_code: String(r[0]).trim(),
                                dsp_name: String(r[1] || '').trim(),
                                reason: String(r[2] || '').trim() });
    });
  }

  return { status: status, catalog: catalog, scope: scope,
           overview: overview, excluded: excluded };
}

/** Sheet dates come back as Date objects or strings; normalise to yyyy-MM-dd. */
function formatSheetDate_(v) {
  if (v instanceof Date) {
    return Utilities.formatDate(v, 'Asia/Kolkata', 'yyyy-MM-dd');
  }
  return String(v).trim() || null;
}

/**
 * Apply a batch of scan hits.
 *
 * hits: [{code, vendor, header, fileName, folderUrl}]
 *
 * Returns {fresh, held, relinked} counts. A cell already reading 'N/A' is
 * NEVER overwritten - that status is a human decision recorded from a mail or
 * a vendor check ("Q3 not due yet", "client never used E-Verify"), meaning the
 * report cannot exist rather than that nobody fetched it. A real file can
 * still match such a cell, so those are counted as held and reported, not
 * written. This is the last guard before the write and the one a future edit
 * cannot skip.
 */
function sheetApplyHits(hits) {
  var out = { fresh: 0, held: 0, relinked: 0, heldDetail: [] };
  if (!hits.length) return out;

  var byVendor = {};
  hits.forEach(function (h) { (byVendor[h.vendor] = byVendor[h.vendor] || []).push(h); });

  var nameOf = {};
  rows_(tab_(TAB_CLIENTS)).forEach(function (r) {
    if (r[0]) nameOf[String(r[0]).trim()] = String(r[1] || '').trim();
  });

  Object.keys(byVendor).forEach(function (vendor) {
    var sh = ss_().getSheetByName(STATUS_TABS[vendor]);
    if (!sh) return;
    var range = sh.getDataRange();
    var values = range.getValues();
    if (values.length < 2) return;

    var headers = values[0];
    var colOf = {};
    for (var c = 1; c < headers.length; c++) {
      var h = String(headers[c] || '').trim();
      if (h) colOf[h] = c;
    }
    var rowOf = {};
    for (var r = 1; r < values.length; r++) {
      var n = String(values[r][0] || '').trim();
      if (n) rowOf[n] = r;
    }

    var dirty = false;
    var notes = [];   // {row, col, text} - applied after the value write
    byVendor[vendor].forEach(function (hit) {
      var rIdx = rowOf[nameOf[hit.code]];
      var cIdx = colOf[hit.header];
      if (rIdx === undefined || cIdx === undefined) return;
      var current = String(values[rIdx][cIdx] || '').trim();
      if (current === ST_NA) {
        out.held++;
        out.heldDetail.push(hit.code + ' / ' + hit.header + ' <- ' + hit.fileName);
        return;
      }
      if (current === ST_PRESENT) out.relinked++;
      else { out.fresh++; values[rIdx][cIdx] = ST_PRESENT; dirty = true; }
      notes.push({ row: rIdx + 1, col: cIdx + 1,
                   text: hit.fileName + (hit.folderUrl ? '\n' + hit.folderUrl : '') });
    });

    if (dirty) range.setValues(values);
    // Notes carry which file satisfied the cell - the audit trail that a bare
    // 'Present' loses. Written after the values so a failure here cannot leave
    // the statuses half-applied.
    notes.forEach(function (n) {
      try { sh.getRange(n.row, n.col).setNote(n.text); } catch (e) { /* non-fatal */ }
    });
  });

  return out;
}

/** Stamp when a client was last scanned, so the mail can show freshness. */
function sheetSetLastScanned(codes) {
  if (!codes.length) return;
  var sh = tab_(TAB_CLIENTS);
  var range = sh.getDataRange();
  var values = range.getValues();
  var today = Utilities.formatDate(new Date(), 'Asia/Kolkata', 'yyyy-MM-dd');
  var want = {};
  codes.forEach(function (c) { want[c] = true; });
  var dirty = false;
  for (var r = 1; r < values.length; r++) {
    if (want[String(values[r][0] || '').trim()]) { values[r][5] = today; dirty = true; }
  }
  if (dirty) range.setValues(values);
}

/** Append newly discovered clients to the Clients tab. */
function sheetAppendClients(rows) {
  if (!rows.length) return;
  var sh = tab_(TAB_CLIENTS);
  rows.forEach(function (r) {
    sh.appendRow([r.code, r.name, r.implementer || '', r.vendor || '',
                  FOLDER_URL_PREFIX + r.folderId, '']);
  });
}

/**
 * Every client whose vendor is set must have a row in that vendor's status
 * tab - that row is what puts it in the scan and in the mail. Covers both a
 * client discovery just added with a known vendor, and one where a person
 * filled the vendor in by hand since the last run. New rows start all Missing;
 * the next scan flips whatever is actually in Drive.
 *
 * Returns the names it created rows for.
 */
function sheetEnsureStatusRows(data, newRows) {
  var created = [];

  var hasStatus = {};
  data.status.forEach(function (r) { hasStatus[r.dsp_short_code] = true; });

  // Clients as the sheet knows them right now, plus what was appended moments
  // ago in this same run (data predates that append).
  var clients = [];
  data.scope.forEach(function (s) {
    var ov = null;
    for (var i = 0; i < data.overview.length; i++) {
      if (data.overview[i].dsp_short_code === s.dsp_short_code) { ov = data.overview[i]; break; }
    }
    clients.push({ code: s.dsp_short_code, name: ov ? ov.dsp_name : s.dsp_short_code,
                   vendor: s.vendor, hasStatus: !!hasStatus[s.dsp_short_code] });
  });
  (newRows || []).forEach(function (r) {
    clients.push({ code: r.code, name: r.name, vendor: r.vendor, hasStatus: false });
  });

  var perTab = {};   // tab name -> {sheet, headers, existingNames}
  clients.forEach(function (c) {
    if (c.hasStatus || !c.vendor || !STATUS_TABS[c.vendor]) return;
    var tabName = STATUS_TABS[c.vendor];
    var t = perTab[tabName];
    if (!t) {
      var sh = ss_().getSheetByName(tabName);
      if (!sh) return;
      var values = sh.getDataRange().getValues();
      var existing = {};
      for (var r = 1; r < values.length; r++) {
        var n = String(values[r][0] || '').trim();
        if (n) existing[norm(n)] = true;
      }
      t = perTab[tabName] = { sheet: sh, ncols: values[0].length, existing: existing };
    }
    if (t.existing[norm(c.name)]) return;    // row already there under this name
    var row = [c.name];
    for (var i = 1; i < t.ncols; i++) row.push(ST_MISSING);
    t.sheet.appendRow(row);
    t.existing[norm(c.name)] = true;
    created.push(c.name + ' -> ' + tabName);
  });

  return created;
}

/** Remove one client's row from the Out of Scope tab (used by the RAG
 *  hold/resume sync). Deleting by code only - never touches other rows. */
function sheetRemoveExcludedRow(code) {
  var sh = ss_().getSheetByName(TAB_EXCLUDED);
  if (!sh) return;
  var values = sh.getDataRange().getValues();
  for (var r = values.length - 1; r >= 1; r--) {
    if (String(values[r][0] || '').trim() === code) sh.deleteRow(r + 1);
  }
}

/** Record the folder we actually found, so the next run skips the name search. */
function sheetSetFolderUrl(code, folderId) {
  var sh = tab_(TAB_CLIENTS);
  var range = sh.getDataRange();
  var values = range.getValues();
  for (var r = 1; r < values.length; r++) {
    if (String(values[r][0] || '').trim() === code) {
      var url = FOLDER_URL_PREFIX + folderId;
      if (String(values[r][4] || '').trim() === url) return;
      values[r][4] = url;
      range.setValues(values);
      return;
    }
  }
}


/* ======================================================================
 * SCAN
 * ====================================================================== */

/**
 * Scan.gs — walk each incomplete client's Drive folder and mark reports
 * Received. Direct port of scripts/scan_drive_historical.py; keep the two in
 * step.
 *
 * The scan is one-directional: it only ever writes 'Received', never 'Pending',
 * so a client already complete cannot regress and a client with zero Pending
 * rows is skipped entirely (scanning it could not change anything).
 */

/** Report name -> keywords that must ALL appear in a filename.
 *  A nested array means alternatives: any one of them matching is enough. */
var KEYWORDS = {
  // --- ADP ---
  'ADP|Payroll History': [['historicalpayroll'], ['payroll', 'history']],
  'ADP|Time Off Balance Detail': ['timeoff', 'balance', 'detail'],
  'ADP|Time Off Balance Summary': ['timeoff', 'balance', 'summary'],
  'ADP|Time Off Policy Assignment': ['timeoff', 'policy'],
  'ADP|Time Off Request': ['timeoff', 'request'],
  'ADP|Timecard Report with Supervisor Approval': ['timecard', 'supervisor'],
  'ADP|Timecard Report with Notes': ['timecard', 'notes'],
  'ADP|Timecard Exception Report': ['timecard', 'exception'],
  // Just 'audit': the folder is spelt 'Audit Trial' but the files inside are
  // 'Audit_Trail_Report', so neither spelling matches both. The quarter check
  // is what actually pins this report down.
  'ADP|Audit Trail': ['audit'],
  'ADP|Form I-9 and E-Verify Information': ['i9', 'everify'],
  // ADP calls the garnishment report an Employee Lien Report; files land under
  // either word depending on who pulled them.
  'ADP|Employee Lien Report': [['lien'], ['garnishment']],
  'ADP|Qualified Overtime Wages And Tips': ['overtime'],
  // --- Paycom ---
  'Paycom|Estimated Qualified Premiums Report': ['qualified', 'premiums'],
  'Paycom|Employee Time-Off': ['employee', 'timeoff'],
  'Paycom|Holiday/Blackout': ['holiday'],
  'Paycom|Time-Off Audit': ['timeoff', 'audit'],
  'Paycom|Time-Off Summary': ['timeoff', 'summary'],
  'Paycom|Salary Time Off Absence Tracking': ['absence'],
  'Paycom|Break/Lunch Duration': ['break', 'duration'],
  'Paycom|Employee Punch Change': ['punch', 'change'],
  'Paycom|Employee Rates by Allocation': ['rates', 'allocation'],
  'Paycom|Hours Worked vs Threshold': ['threshold'],
  'Paycom|Labor Allocation': ['labor', 'allocation'],
  'Paycom|Labor Analysis/Overtime': ['labor', 'analysis'],
  'Paycom|Missed Break/Lunch': ['missed', 'break'],
  'Paycom|Missing Punch': ['missing', 'punch'],
  'Paycom|Pay Class Effective Date': ['payclass'],
  'Paycom|Punch Audit': ['punch', 'audit'],
  'Paycom|Punches Outside Current Allocation': ['punches', 'outside'],
  'Paycom|Time Between Shifts': ['between', 'shifts'],
  'Paycom|Time Detail': ['time', 'detail'],
  'Paycom|Timecard Approval': ['timecard', 'approval'],
  'Paycom|Total Hours by Time Range': ['totalhours', 'range'],
  'Paycom|Total Hours Summary by Allocation': ['totalhours', 'summary', 'allocation'],
  'Paycom|Total Hours Summary': ['totalhours', 'summary'],
  'Paycom|Zero Hours Summary': ['zerohours'],
  'Paycom|Accrual Balances': ['accrual', 'balance'],
  'Paycom|Accrual Detail': ['accrual', 'detail'],
  'Paycom|Accrual Summary': ['accrual', 'summary'],
  'Paycom|Historical Accrual Data': ['historical', 'accrual'],
  'Paycom|Effective Dates': ['effective', 'date'],
  'Paycom|Employee Changes': ['employee', 'change'],
  'Paycom|Employee Dates': ['employee', 'date'],
  'Paycom|Rate History': ['rate', 'history'],
  'Paycom|Employee Accrual': ['employee', 'accrual'],
  'Paycom|Equifax TWN Feed': ['equifax'],
  'Paycom|Employee 3rd Party Payee': ['3rdparty'],
  'Paycom|Employee Rates': ['employee', 'rates'],
  'Paycom|Employee Position': ['employee', 'position'],
  'Paycom|Position Discrepancy': ['position', 'discrepancy'],
  'Paycom|Position Management Audit': ['position', 'management'],
  'Paycom|Point-in-Time': ['pointintime'],
  'Paycom|Changed Contact': ['changed', 'contact'],
  'Paycom|Form I-9 Audit Report': ['i9', 'audit'],
  'Paycom|Prior Payroll (Advanced Report Writer, consolidated)': ['priorpayroll'],
  'Paycom|E-Verify Cases (grid export)': ['everify', 'cases'],
  'Paycom|E-Verify Case Details (all cases)': ['everify', 'case', 'details'],
  'Paycom|Garnishment Report': ['garnishment']
};

/** Lowercase and strip every separator, so 'Time_Off Balance-Detail.xlsx' and
 *  'timeoffbalancedetail' compare equal. Coerces to String first: sheet cells
 *  arrive as Dates and numbers too (the onboarding tracker's header row has
 *  date-typed columns), and Date has no toLowerCase - that crashed the whole
 *  discovery step on 25 Sep. */
function norm(s) {
  return String(s === null || s === undefined ? '' : s)
    .toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * The client's Historical Data subfolder, or null.
 *
 * Matched on the normalised name because the folder has been spelt
 * 'Historical data' and 'HistoricalData' in different clients - the same class
 * of typo that made 'Audit Trial' vs 'Audit Trail' a problem.
 */
function historicalFolderOf_(clientFolder) {
  var want = norm(HISTORICAL_FOLDER);
  var it = clientFolder.getFolders();
  while (it.hasNext()) {
    var f = it.next();
    if (norm(f.getName()) === want) return f;
  }
  return null;
}

function alternatives(spec) {
  return (spec && spec.length && Array.isArray(spec[0])) ? spec : [spec];
}

/**
 * 0 if the file does not match, otherwise how specific the match is.
 *
 * Specificity matters because report names nest inside one another:
 * 'Employee Rates' inside 'EmployeeRatesByAllocation', 'Employee Changes'
 * inside 'EmployeePunchChange'. Each file goes to its highest-scoring report
 * rather than to whichever came first. The report's own name appearing whole
 * outranks any keyword match — scoring on keyword length alone is not enough,
 * since 'employee'+'change' is longer than 'punch'+'change' and would steal
 * EmployeePunchChange's file.
 */
function matchScore(spec, reportName, filename) {
  var n = norm(filename);
  var whole = norm(reportName);
  if (whole && n.indexOf(whole) !== -1) return 1000 + whole.length;

  // norm() strips separators, so a keyword can hide inside an unrelated word.
  // The one that bit us: 'lien' is inside 'c-lien-t'. Every file named
  // 'Client_Uzio_ADP_Census...' matched Employee Lien Report, and two clients
  // with no historical data at all were marked as having a report.
  //
  // Removing the literal 'client' cannot hide a genuine hit: a real
  // 'Client Lien Report.xlsx' still keeps its own 'lien' afterwards.
  var haystack = n.split('client').join('');

  var best = 0;
  alternatives(spec).forEach(function (alt) {
    var all = alt.every(function (k) { return haystack.indexOf(k) !== -1; });
    if (all) {
      var score = alt.reduce(function (a, k) { return a + k.length; }, 0);
      if (score > best) best = score;
    }
  });
  return best;
}

/** Is this specific year/quarter present in the filename? */
function unitInFilename(unitLabel, filename) {
  if (unitLabel === 'Report') return true;
  var n = norm(filename);
  if (/^\d{4}$/.test(unitLabel)) return n.indexOf(unitLabel) !== -1;
  var m = /^(\d{4}) Q([1-4])$/.exec(unitLabel);
  if (m) {
    // accept 2025Q1 and Q12025
    return n.indexOf(m[1] + 'q' + m[2]) !== -1 || n.indexOf('q' + m[2] + m[1]) !== -1;
  }
  return false;
}

/** Recursively list a folder. Returns {files: ['Sub/name.xlsx', ...],
 *  folders: {'': id, 'Sub': id}, truncated: bool}. */
function walkFolder(rootFolder) {
  var out = { files: [], folders: { '': rootFolder.getId() }, truncated: false };

  function walk(folder, prefix, depth) {
    if (out.truncated) return;
    if (depth > MAX_FOLDER_DEPTH) return;

    var it = folder.getFiles();
    while (it.hasNext()) {
      if (out.files.length >= MAX_FILES_PER_CLIENT) { out.truncated = true; return; }
      // One next() per iteration - calling it twice here would skip every
      // other file and report arrived reports as still Pending.
      var name = it.next().getName();
      out.files.push(prefix ? prefix + '/' + name : name);
    }
    var fit = folder.getFolders();
    while (fit.hasNext()) {
      var sub = fit.next();
      var subPrefix = prefix ? prefix + '/' + sub.getName() : sub.getName();
      out.folders[subPrefix] = sub.getId();
      walk(sub, subPrefix, depth + 1);
      if (out.truncated) return;
    }
  }

  walk(rootFolder, '', 0);
  return out;
}

/** Resolve a client's Drive folder: the recorded scope URL if there is one,
 *  otherwise a normalised name match among the children of the DSP root.
 *  Name matching is normalised because the sheet and Drive disagree on
 *  punctuation — 'CDC LOGISTICS, LLC' vs the folder 'CDC LOGISTICS LLC'. */
function resolveClientFolder(code, folderUrl, dspName) {
  if (folderUrl) {
    var m = /folders\/([A-Za-z0-9_-]+)/.exec(folderUrl);
    if (m) {
      try { return DriveApp.getFolderById(m[1]); } catch (e) { /* fall through */ }
    }
  }
  if (!dspName) return null;
  var want = norm(dspName);
  var root = DriveApp.getFolderById(DSP_CLIENTS_ROOT_ID);
  var it = root.getFolders();
  var loose = null;
  while (it.hasNext()) {
    var f = it.next();
    var got = norm(f.getName());
    if (got === want) return f;
    // 'InnovDel' folder vs 'InnovDel Inc' client name - remember but keep
    // looking for an exact hit first.
    if (!loose && (got.indexOf(want) === 0 || want.indexOf(got) === 0)) loose = f;
  }
  return loose;
}

/**
 * Scan every DSP that still has Pending rows and write what it finds.
 * Returns a log array for the run summary. Never throws for one bad client —
 * a Drive failure on one DSP must not cost the whole mail.
 */
function runScan(data) {
  var log = [];
  var catalogById = {};
  data.catalog.forEach(function (c) { catalogById[c.id] = c; });

  var scopeByCode = {};
  data.scope.forEach(function (s) { scopeByCode[s.dsp_short_code] = s; });
  var nameByCode = {};
  data.overview.forEach(function (o) { nameByCode[o.dsp_short_code] = o.dsp_name; });

  // Only DSPs with at least one Pending row - and never one that is out of
  // scope. A held client keeps its status rows (history and N/A decisions
  // survive the hold), so the exclusion list is what keeps it out of the scan.
  var excludedCodes = {};
  (data.excluded || []).forEach(function (x) { excludedCodes[x.dsp_short_code] = true; });
  var pendingCodes = {};
  data.status.forEach(function (r) {
    if (r.status === 'Pending' && !excludedCodes[r.dsp_short_code]) {
      pendingCodes[r.dsp_short_code] = true;
    }
  });
  var codes = Object.keys(pendingCodes);
  if (!codes.length) { log.push('No DSP has pending reports; scan skipped.'); return log; }

  // Hits are collected across every client and written in one batch per tab at
  // the end. Per-cell writes would spend the 6-minute budget on Sheet calls.
  var hits = [];
  var scanned = [];

  codes.forEach(function (code) {
    var scope = scopeByCode[code];
    if (!scope) { log.push(code + ': not in historical_scope - skipped'); return; }

    var folder;
    try {
      folder = resolveClientFolder(code, scope.folder_url, nameByCode[code]);
    } catch (e) {
      log.push(code + ': Drive lookup failed - ' + e.message);
      return;
    }
    if (!folder) { log.push(code + ': no Drive folder found - still Pending'); return; }

    // Historical reports live in exactly one subfolder of the client folder,
    // with a fixed name and fixed subfolders (Employee Lien Detail, I9,
    // Payroll, Time & Attendance, Time Off). The siblings - 'Audit Files',
    // 'Prior Payroll Files' - are different work, and only this folder is
    // scanned. Letting the matcher see the rest of the client folder is what
    // marked a report Present off a census audit report.
    var histFolder;
    try {
      histFolder = historicalFolderOf_(folder);
    } catch (e) {
      log.push(code + ': Drive lookup failed - ' + e.message);
      return;
    }
    if (!histFolder) {
      log.push(code + ': no "' + HISTORICAL_FOLDER + '" folder - nothing marked');
      scanned.push(code);
      return;
    }

    var walked;
    try {
      walked = walkFolder(histFolder);
    } catch (e) {
      log.push(code + ': Drive walk failed - ' + e.message);
      return;
    }
    if (walked.truncated) {
      log.push(code + ': WARNING folder has more than ' + MAX_FILES_PER_CLIENT +
               ' files - scan stopped early, results may be incomplete');
    }

    // Rows we could still fill for this client, with their catalog entry.
    var mine = data.status.filter(function (r) { return r.dsp_short_code === code; });
    var statusOf = {};
    mine.forEach(function (r) { statusOf[r.report_id + '|' + r.unit_label] = r.status; });

    // Walk files, not reports: each file goes to the single report it matches
    // most specifically, one file per report-unit.
    var claimed = {};
    var recognised = {};
    walked.files.forEach(function (fn) {
      var best = null, bestScore = 0;
      mine.forEach(function (r) {
        var cat = catalogById[r.report_id];
        if (!cat || cat.vendor !== scope.vendor) return;
        var kws = KEYWORDS[cat.vendor + '|' + cat.report_name];
        if (!kws || !unitInFilename(r.unit_label, fn)) return;
        var score = matchScore(kws, cat.report_name, fn);
        if (score > bestScore) { bestScore = score; best = r; }
      });
      if (!best) return;
      recognised[fn] = true;
      var key = best.report_id + '|' + best.unit_label;
      if (!claimed[key]) claimed[key] = { row: best, file: fn };
    });

    Object.keys(claimed).forEach(function (key) {
      var c = claimed[key];
      var cat = catalogById[c.row.report_id];
      if (!cat) return;
      var prefix = c.file.indexOf('/') !== -1
        ? c.file.slice(0, c.file.lastIndexOf('/')) : '';
      var fid = walked.folders[prefix] || walked.folders[''];
      // The N/A guard lives in sheetApplyHits, at the write itself - a hit is
      // collected here regardless so it can be counted and reported as held.
      hits.push({
        code: code,
        vendor: scope.vendor,
        header: cat.header,
        fileName: c.file.split('/').pop(),
        folderUrl: fid ? FOLDER_URL_PREFIX + fid : null
      });
    });

    try {
      sheetSetFolderUrl(code, folder.getId());
    } catch (e) {
      log.push('  could not record folder url for ' + code + ': ' + e.message);
    }
    scanned.push(code);

    var unmatched = walked.files.filter(function (f) { return !recognised[f]; });
    log.push(code + ': ' + walked.files.length + ' file(s) in ' +
             HISTORICAL_FOLDER + ', ' + Object.keys(claimed).length +
             ' report(s) matched, ' + unmatched.length + ' matched nothing');

    // Every line here sits inside Historical Data, so each one is either a
    // report named in a way the rules miss or a stray that does not belong.
    // Both are worth a person's eye; a count alone is unactionable.
    if (unmatched.length) {
      unmatched.slice(0, UNMATCHED_TO_LIST).forEach(function (f) {
        log.push('    ? ' + f);
      });
      if (unmatched.length > UNMATCHED_TO_LIST) {
        log.push('    ... and ' + (unmatched.length - UNMATCHED_TO_LIST) +
                 ' more not listed');
      }
    }
  });

  var applied = { fresh: 0, held: 0, relinked: 0, heldDetail: [] };
  try {
    applied = sheetApplyHits(hits);
    sheetSetLastScanned(scanned);
  } catch (e) {
    log.push('WRITE FAILED: ' + e.message + ' - the sheet was not updated');
    return log;
  }

  log.push('Applied: ' + applied.fresh + ' newly Present, ' + applied.relinked +
           ' already Present (note refreshed), ' + applied.held + ' held as N/A');
  // Surfaced rather than silently skipped: a file matching a cell somebody
  // marked N/A is worth one look - either the file is misnamed, or the N/A
  // call was wrong and a person needs to undo it.
  applied.heldDetail.forEach(function (d) { log.push('  HELD ' + d); });

  return log;
}


/* ======================================================================
 * DISCOVERY
 * ====================================================================== */

/**
 * Discovery.gs — Drive says who exists; Shruti's tracker says who is in scope.
 *
 * v1 used "has a Historical Data folder" as the in-scope signal. That died the
 * day it shipped: Rohit's folder automation creates a Historical Data folder
 * for EVERY new client, so the folder proves nothing, and v1 dragged in
 * brand-new DSPs that never ran on ADP or Paycom - clients with no history to
 * collect at all.
 *
 * The rule now, as stated by Shobhit on 16 Sep:
 *
 *   A client is in historical scope ONLY if their PREVIOUS payroll system was
 *   ADP or Paycom. That is where historical data lives. A 'New' DSP has no
 *   previous system and therefore no historical data - never track it.
 *
 * Previous system comes from Shruti's onboarding tracker (the
 * 'DSP Implementation' tab), which also carries the short code, implementer
 * and vendor - so a discovered in-scope client arrives fully filled-in and
 * starts tracking the same run, no human step.
 */

// Shruti's 'Uzio Implementation Onboarding Tracker' - READ ONLY, never write.
var ONBOARDING_TRACKER_ID = '1GRnfKMp4tcjGXWhkx5rpRKQD8eadikZPNqeufctoXsI';
var ONBOARDING_TAB = 'DSP Implementation';

// Folders under the DSP root that are not clients.
var NON_CLIENT_FOLDERS = [
  'Tracking', 'Automation Scripts', 'Data Transfer',
  'DSP Onboarding Project Tracking', 'DSP Unwind and DSP Exit Support Guide',
  'Test LLC'
];

/** 'ADP' / 'Paycom' out of whatever spelling the tracker cell holds, else ''. */
function prevVendor_(cell) {
  var v = norm(cell);
  if (!v) return '';
  if (v.indexOf('paycom') !== -1) return 'Paycom';
  if (v.indexOf('adp') !== -1) return 'ADP';
  return '';   // 'New', blank, or some system we have no catalogue for
}

/**
 * Read Shruti's tracker once: normalised DSP name -> {code, implementer, prev}.
 * Columns are found by header text, not position - that sheet grows columns.
 */
function readOnboardingTracker_() {
  var sh = SpreadsheetApp.openById(ONBOARDING_TRACKER_ID)
    .getSheetByName(ONBOARDING_TAB);
  if (!sh) throw new Error('Tab "' + ONBOARDING_TAB + '" not found in the onboarding tracker');
  var values = sh.getDataRange().getValues();
  if (values.length < 2) return {};

  // First match wins for every header - the tab has a SECOND 'RAG' column far
  // to the right (a weekly grid); Shruti's status lives in the first one.
  var col = { name: -1, code: -1, prev: -1, impl: -1, rag: -1 };
  values[0].forEach(function (h, i) {
    var n = norm(h);
    if (col.name === -1 && n === 'dspname') col.name = i;
    if (col.code === -1 && n === 'dspshortcode') col.code = i;
    if (col.prev === -1 && n === 'previoussystem') col.prev = i;
    if (col.impl === -1 && n === 'implementor') col.impl = i;
    if (col.rag === -1 && n === 'rag') col.rag = i;
  });
  if (col.name === -1 || col.prev === -1) {
    throw new Error('Onboarding tracker headers moved - could not find DSP Name / Previous System');
  }

  var out = {};
  for (var r = 1; r < values.length; r++) {
    var name = String(values[r][col.name] || '').trim();
    if (!name) continue;
    out[norm(name)] = {
      name: name,
      code: col.code !== -1 ? String(values[r][col.code] || '').trim() : '',
      implementer: col.impl !== -1 ? String(values[r][col.impl] || '').trim() : '',
      prev: prevVendor_(values[r][col.prev]),
      rag: col.rag !== -1 ? String(values[r][col.rag] || '').trim() : ''
    };
  }
  return out;
}

/**
 * Does this RAG value mean "paused"?
 *
 * The tracker's RAG dropdown (verified against the sheet, 25 Sep 2026) is:
 *   ACTIVE : Green, Amber, Red, (blank)
 *   PAUSED : On Hold, Cancelled, Unresponsive,
 *            Waiting on Product Update/Enhancement,
 *            Waiting on Third PartyUpdate/Enhancement
 *
 * Red is deliberately ACTIVE - it means the project is in trouble, not
 * stopped, and a troubled client's historical data matters more, not less.
 * Trek's "hold" was actually spelt 'Waiting on Product Update/Enhancement',
 * so matching only 'On Hold' would have missed the very client this feature
 * was asked for. A blank RAG counts as active: absence of a status is not a
 * hold. Matching is on keywords (hold/cancel/unresponsive/waiting), so minor
 * respellings of the paused options keep working.
 */
function ragPaused_(rag) {
  var n = norm(rag);
  if (!n) return false;
  return n.indexOf('hold') !== -1 || n.indexOf('cancel') !== -1 ||
         n.indexOf('unresponsive') !== -1 || n.indexOf('waiting') !== -1;
}

// The Out of Scope 'Reason' column is a dropdown of exactly these three
// values (details go in the Notes column next to it). The word "hold" in
// REASON_ON_HOLD is load-bearing: it is what makes an entry auto-resumable.
var REASON_ACCESS_REVOKED = 'Access revoked';
var REASON_ON_HOLD = 'On hold';
var REASON_OTHER = 'Other - see notes';

// Only Out of Scope entries carrying this word in their reason are ever
// auto-removed. The access-revoked entries (JDW, Chief, Fass, Accelerated,
// Lincoln) are all RAG Green in the tracker, so without this marker the
// resume half of the sync would drag every one of them straight back in.
function isHoldEntry_(reason) {
  return norm(reason).indexOf('hold') !== -1;
}

/**
 * ONE-TIME (25 Sep 2026): turn the Out of Scope 'Reason' column into a
 * dropdown and move the old free-text reasons into a new 'Notes' column.
 *
 * Why: the whole hold/resume mechanism keys off the word "hold" in the
 * reason. Free text meant one differently-worded entry could silently break
 * an auto-resume, or worse, get one wrongly resumed. Three fixed values end
 * that; the who/when/why detail lives on in Notes.
 *
 * Idempotent - rows already carrying a dropdown value are left alone, and
 * re-applying the validation rule is harmless.
 */
function setupOutOfScopeDropdownOnce() {
  var sh = tab_(TAB_EXCLUDED);
  var range = sh.getDataRange();
  var values = range.getValues();
  var CHOICES = [REASON_ACCESS_REVOKED, REASON_ON_HOLD, REASON_OTHER];
  var migrated = 0;

  // Make sure the Notes header exists.
  if (String(values[0][3] || '').trim() === '') {
    sh.getRange(1, 4).setValue('Notes');
  }

  for (var r = 1; r < values.length; r++) {
    if (!values[r][0]) continue;
    var reason = String(values[r][2] || '').trim();
    if (!reason || CHOICES.indexOf(reason) !== -1) continue;   // already migrated

    var short_;
    if (norm(reason).indexOf('hold') !== -1) short_ = REASON_ON_HOLD;
    else if (norm(reason).indexOf('revoked') !== -1 ||
             norm(reason).indexOf('lost') !== -1) short_ = REASON_ACCESS_REVOKED;
    else short_ = REASON_OTHER;

    sh.getRange(r + 1, 3).setValue(short_);
    // Keep the old text - it is the who/when/why - unless Notes already has
    // something a person wrote there.
    if (String(values[r][3] || '').trim() === '') {
      sh.getRange(r + 1, 4).setValue(reason);
    }
    migrated++;
  }

  // Dropdown on the Reason column. Strict for humans (pick from the list);
  // the script only ever writes these three values anyway.
  var rule = SpreadsheetApp.newDataValidation()
    .requireValueInList(CHOICES, true)
    .setAllowInvalid(false)
    .setHelpText('Pick one. "On hold" auto-resumes when the tracker RAG is ' +
                 'active again; put the details in Notes.')
    .build();
  sh.getRange(2, 3, Math.max(values.length - 1, 1) + 200, 1)
    .setDataValidation(rule);

  console.log('Dropdown applied. Migrated ' + migrated +
              ' free-text reason(s) into the Notes column.');
}

/**
 * Dheeraj's ask (24 Sep mail thread): drive hold/resume from the SAME column
 * Shruti uses - the tracker's RAG. Both directions, every run:
 *
 *   pause : tracked client whose RAG turns paused -> an Out of Scope entry is
 *           added. Its rows STAY, so Present history and hand-made N/A
 *           decisions survive the hold; the mail and the scan just skip it.
 *   resume: a hold-marked entry whose RAG is active again -> entry removed,
 *           the client is back the same run.
 *
 * Mutates data.excluded in place so the caller's folder walk sees the state
 * as it now is on the sheet.
 */
function syncHoldWithTracker_(data, tracker) {
  var out = { held: [], resumed: [], changed: false, log: [] };

  // resume first, so a client can leave hold and be rediscovered in one run
  for (var i = data.excluded.length - 1; i >= 0; i--) {
    var x = data.excluded[i];
    if (!isHoldEntry_(x.reason)) continue;
    var t = trackerLookup_(tracker, x.dsp_name || x.dsp_short_code);
    if (!t || ragPaused_(t.rag)) continue;
    sheetRemoveExcludedRow(x.dsp_short_code);
    data.excluded.splice(i, 1);
    out.resumed.push(x.dsp_name || x.dsp_short_code);
    out.changed = true;
  }

  // then pause any tracked client whose RAG says so
  var excludedCodes = {};
  data.excluded.forEach(function (x) { excludedCodes[x.dsp_short_code] = true; });
  data.overview.forEach(function (o) {
    if (excludedCodes[o.dsp_short_code]) return;
    var t = trackerLookup_(tracker, o.dsp_name);
    if (!t || !ragPaused_(t.rag)) return;
    // Reason is a dropdown value; the detail goes in the Notes column. The
    // word "hold" in the reason is what makes the entry auto-resumable.
    var note = 'RAG "' + t.rag + '" in the onboarding tracker (auto-synced ' +
      Utilities.formatDate(new Date(), 'Asia/Kolkata', 'dd MMM yyyy') +
      '). Comes back automatically when the RAG is active again.';
    tab_(TAB_EXCLUDED).appendRow([o.dsp_short_code, o.dsp_name,
                                  REASON_ON_HOLD, note]);
    data.excluded.push({ dsp_short_code: o.dsp_short_code,
                         dsp_name: o.dsp_name, reason: REASON_ON_HOLD });
    out.held.push(o.dsp_name + ' (RAG: ' + t.rag + ')');
    out.changed = true;
  });

  if (out.resumed.length) out.log.push('Resumed (RAG active again): ' + out.resumed.join(', '));
  if (out.held.length) out.log.push('Put on hold (RAG): ' + out.held.join(', '));
  return out;
}

/** Tracker row for a Drive folder name: exact normalised match first, then
 *  containment either way ('InnovDel' folder vs 'InnovDel Inc' row). */
function trackerLookup_(tracker, folderName) {
  var n = norm(folderName);
  if (tracker[n]) return tracker[n];
  var hit = null;
  Object.keys(tracker).forEach(function (k) {
    if (!hit && k.length > 3 && (n.indexOf(k) !== -1 || k.indexOf(n) !== -1)) {
      hit = tracker[k];
    }
  });
  return hit;
}

/** A short unique code for a client the tracker has no code for. */
function makeCode_(name, taken) {
  var words = String(name).toUpperCase().replace(/[^A-Z0-9 ]/g, '').split(/\s+/)
    .filter(function (w) { return w; });
  var base = words.map(function (w) { return w.charAt(0); }).join('').slice(0, 4);
  while (base.length < 3) base += 'X';
  var code = base, i = 2;
  while (taken[code]) { code = base + i; i++; }
  return code;
}

/**
 * Walk the DSP root; any client folder the sheet does not know whose previous
 * system (per Shruti's tracker) is ADP or Paycom gets added, vendor and all,
 * and starts tracking this run. 'New' DSPs are skipped - that is the rule, not
 * an omission. Folders the tracker cannot answer for are only logged.
 */
function discoverAndSync(data) {
  // The editor's Run dropdown lists every function; direct runs pass no
  // argument, so load the sheet ourselves rather than crash on data.overview.
  if (!data) data = loadAll();

  var out = { added: [], skippedNew: [], skippedHold: [], unknown: [],
              statusRowsCreated: [], resumed: [], held: [],
              holdChanged: false, log: [] };

  var tracker;
  try {
    tracker = readOnboardingTracker_();
  } catch (e) {
    out.log.push('DISCOVERY SKIPPED: cannot read the onboarding tracker - ' + e.message);
    return out;
  }

  // Hold/resume sync runs before the folder walk, so a just-resumed client is
  // rediscovered in this same run and a just-held one is not re-added.
  try {
    var hold = syncHoldWithTracker_(data, tracker);
    out.held = hold.held;
    out.resumed = hold.resumed;
    out.holdChanged = hold.changed;
    hold.log.forEach(function (l) { out.log.push(l); });
  } catch (e) {
    out.log.push('HOLD SYNC FAILED: ' + e.message + ' - continuing without it');
  }

  var knownNames = {};
  data.overview.forEach(function (o) { knownNames[norm(o.dsp_name)] = true; });
  // Names drift ('Flash Hub Delivery' vs its folder 'Flash Hub Delivery
  // Correct Folder'), so a client is also recognised by the folder id already
  // recorded on its row - never re-add a folder the sheet already points at.
  var knownIds = {};
  data.scope.forEach(function (s) {
    var m = /folders\/([A-Za-z0-9_-]+)/.exec(s.folder_url || '');
    if (m) knownIds[m[1]] = true;
  });
  var takenCodes = {};
  data.scope.forEach(function (s) { takenCodes[s.dsp_short_code] = true; });

  var blacklist = {};
  NON_CLIENT_FOLDERS.forEach(function (n) { blacklist[norm(n)] = true; });
  var excludedNorms = (data.excluded || []).map(function (x) {
    return norm(x.dsp_name || x.dsp_short_code);
  });

  var newRows = [];
  var it;
  try {
    it = DriveApp.getFolderById(DSP_CLIENTS_ROOT_ID).getFolders();
  } catch (e) {
    out.log.push('DISCOVERY FAILED: cannot open DSP root - ' + e.message);
    return out;
  }

  while (it.hasNext()) {
    var f = it.next();
    var n = norm(f.getName());
    if (!n || blacklist[n] || knownNames[n] || knownIds[f.getId()]) continue;
    var isExcluded = excludedNorms.some(function (e) {
      return n.indexOf(e) !== -1 || e.indexOf(n) !== -1;
    });
    if (isExcluded) continue;

    // BOTH gates, deliberately. The Historical Data subfolder alone is too
    // weak (Rohit's automation creates one for every new client, including
    // brand-new DSPs with no history - the 16 Sep overreach). The tracker's
    // previous-system rule alone is too broad (it matches every client ever
    // migrated from ADP/Paycom - dropping the folder gate flooded the sheet
    // with 29 long-live clients on 25 Sep). A client enters scope only when
    // its folder has a Historical Data subfolder AND its previous system is
    // ADP/Paycom AND its RAG is active.
    var hd;
    try { hd = historicalFolderOf_(f); } catch (e) { continue; }
    if (!hd) continue;   // old pre-programme clients never get one - stay out

    var t = trackerLookup_(tracker, f.getName());
    if (!t) {
      // Not silent, not added: a folder the onboarding tracker knows nothing
      // about is either brand new or misnamed, and a person should look once.
      out.unknown.push(f.getName().trim());
      continue;
    }
    if (!t.prev) {
      // The rule: no ADP/Paycom past, no historical data, no tracking.
      out.skippedNew.push(f.getName().trim());
      continue;
    }
    if (ragPaused_(t.rag)) {
      // In scope on paper, but the RAG says paused - do not start tracking.
      // The day the RAG turns active, this same walk picks it up.
      out.skippedHold.push(f.getName().trim() + ' (RAG: ' + t.rag + ')');
      continue;
    }

    var code = t.code || makeCode_(f.getName(), takenCodes);
    takenCodes[code] = true;
    newRows.push({
      code: code,
      name: f.getName().trim(),
      implementer: t.implementer || '',
      vendor: t.prev,
      folderId: f.getId()
    });
  }

  if (newRows.length) {
    sheetAppendClients(newRows);
    newRows.forEach(function (r) {
      out.added.push(r.name + ' (' + r.code + ', ' + r.vendor + ')');
    });
    out.log.push('Discovered ' + newRows.length + ' new client(s) with ADP/Paycom history: ' +
                 newRows.map(function (r) { return r.name; }).join(', '));
  }
  if (out.skippedNew.length) {
    out.log.push('Skipped (previous system not ADP/Paycom - no historical data): ' +
                 out.skippedNew.join(', '));
  }
  if (out.skippedHold.length) {
    out.log.push('Skipped (in scope but RAG paused - will start when active): ' +
                 out.skippedHold.join(', '));
  }
  if (out.unknown.length) {
    out.log.push('NEEDS A LOOK - folder in Drive but not found in the onboarding tracker: ' +
                 out.unknown.join(', '));
  }

  // Vendor-set clients without a status row - both freshly discovered ones and
  // ones where a person just filled the vendor in - get their row of Missing
  // cells now, which is what puts them in the scan and the mail.
  var created = sheetEnsureStatusRows(data, newRows);
  out.statusRowsCreated = created;
  if (created.length) {
    out.log.push('Started tracking (new status rows): ' + created.join(', '));
  }

  return out;
}

/**
 * Take a client out of scope, permanently and re-add-proofly.
 *
 * Order matters: the Out of Scope entry goes in FIRST, because a client whose
 * previous system is ADP/Paycom passes the discovery rule and would be re-added
 * on the next run if its rows were merely deleted. Idempotent.
 *
 * To bring a client BACK (e.g. a hold is lifted): delete its row from the
 * Out of Scope tab - discovery re-adds it automatically on the next run.
 */
function markOutOfScope_(code, name, reason, note) {
  var done = [];

  var ex = tab_(TAB_EXCLUDED);
  var exists = rows_(ex).some(function (r) {
    return String(r[0] || '').trim() === code;
  });
  if (!exists) {
    ex.appendRow([code, name, reason, note || '']);
    done.push('Out of Scope entry added');
  }

  var sh = tab_(TAB_CLIENTS);
  var values = sh.getDataRange().getValues();
  for (var r = values.length - 1; r >= 1; r--) {
    if (String(values[r][0] || '').trim() === code) {
      sh.deleteRow(r + 1);
      done.push('Clients row removed');
    }
  }

  Object.keys(STATUS_TABS).forEach(function (vendor) {
    var st = ss_().getSheetByName(STATUS_TABS[vendor]);
    if (!st) return;
    var sv = st.getDataRange().getValues();
    for (var r2 = sv.length - 1; r2 >= 1; r2--) {
      if (norm(String(sv[r2][0] || '')) === norm(name)) {
        st.deleteRow(r2 + 1);
        done.push(STATUS_TABS[vendor] + ' row removed');
      }
    }
  });

  console.log(code + ': ' + (done.length ? done.join('; ')
    : 'nothing to do - already out of scope.'));
}

/**
 * ONE-TIME (25 Sep 2026): Shobhit confirmed ADP/Paycom access is gone for
 * these 21 clients - their historical data can no longer be downloaded. Each
 * gets a permanent Out of Scope entry (which also blocks discovery from ever
 * re-adding them, even if a Historical Data folder appears in their Drive
 * folder later) and any Clients/status rows are removed. The reason carries
 * no "hold", so the RAG resume sync never touches them. Idempotent.
 */
function markAccessLostSep25Once() {
  var NOTE = 'ADP/Paycom access revoked - the historical data can no ' +
    'longer be downloaded. Marked out of scope by Shobhit, 25 Sep 2026.';
  var CLIENTS = [
    ['KDLL', 'KDL LLC'],
    ['MJGX', 'Majestic Logistix LLC'],
    ['URBZ', 'Urban Box Logistics'],
    ['LLGC', 'Leadership Logistics LLC'],
    ['DNIC', 'DNI Carriers LLC'],
    ['WFW', 'Wheels for Work'],
    ['VAUE', 'Valuable Logistics Inc'],
    ['EXGX', 'EXCELL LOGISTICS CORP'],
    ['AMZI', 'Amazing Logistics'],
    ['TRUD', 'Trudelo'],
    ['MIKE', 'Mike And Fade Consult LLC'],
    ['STJO', 'Fonguh Delivery Services LLC DBA Saint Joseph'],
    ['TRZC', '55th and 3rd'],
    ['SODN', '61 Degrees North LLC'],
    ['REMN', 'Remson Deliveries'],
    ['SKDL', 'Skyland Logistics'],
    ['TRVL', 'Travel Management Professionals'],
    ['PRAL', 'Pria Logistics'],
    ['ESTW', 'East West Logistix'],
    ['HASB', 'Hansen Brothers Delivery'],
    ['MWDL', 'Cat 5 Couriers']
  ];
  CLIENTS.forEach(function (c) {
    markOutOfScope_(c[0], c[1], REASON_ACCESS_REVOKED, NOTE);
  });
  console.log('Done - ' + CLIENTS.length + ' clients marked access-lost/out of scope.');
}

/**
 * ONE-TIME (25 Sep 2026): the first successful run of tracker-driven
 * discovery was missing the Historical Data folder gate and added 29
 * long-live clients (Skyland, Happy Delivery, Wheels for Work, ...) that were
 * never part of the historical programme. This removes exactly those 29 -
 * their Clients rows and their status rows - and nothing else. Idempotent;
 * run once, then delete if you like.
 */
function cleanupSep25FloodOnce() {
  var CODES = ['SKDL', 'HADE', 'WFW', 'HASB', 'TRZC', 'MAKL', 'CAVN', 'TRUD',
               'DNIC', 'LITE', 'SODN', 'MWDL', 'REMN', 'JMPS', 'FALX', 'EXGX',
               'AMZI', 'MIKE', 'VAUE', 'NRCS', 'TRVL', 'URBZ', 'BDGT', 'KDLL',
               'ESTW', 'PRAL', 'MJGX', 'LLGC', 'STJO'];
  var removed = [];

  var sh = tab_(TAB_CLIENTS);
  var values = sh.getDataRange().getValues();
  var names = {};
  // Bottom-up, so deleting a row never shifts the ones still to check.
  for (var r = values.length - 1; r >= 1; r--) {
    var code = String(values[r][0] || '').trim();
    if (CODES.indexOf(code) === -1) continue;
    names[norm(String(values[r][1] || ''))] = true;
    sh.deleteRow(r + 1);
    removed.push(code);
  }

  Object.keys(STATUS_TABS).forEach(function (vendor) {
    var st = ss_().getSheetByName(STATUS_TABS[vendor]);
    if (!st) return;
    var sv = st.getDataRange().getValues();
    for (var r2 = sv.length - 1; r2 >= 1; r2--) {
      if (names[norm(String(sv[r2][0] || ''))]) {
        st.deleteRow(r2 + 1);
        removed.push(STATUS_TABS[vendor] + ': ' + sv[r2][0]);
      }
    }
  });

  console.log(removed.length
    ? 'Removed ' + removed.length + ' row(s):\n  ' + removed.join('\n  ')
    : 'Nothing to remove - already clean.');
}

/**
 * ONE-TIME (23 Sep 2026): Shruti's reply on that day's mail thread -
 * "Please remove Trek from this report as it is on Hold." Not access-lost,
 * just paused: if the hold lifts, delete Trek's Out of Scope row and
 * discovery brings it back with its tracked state starting fresh.
 */
function markTrekOnHoldOnce() {
  markOutOfScope_('TRKD', 'Trek Delivery', REASON_ON_HOLD,
    'Removed from the report at Shruti\'s request (mail, 23 Sep 2026). ' +
    'Auto-resumes when the tracker RAG is active again.');
}

/**
 * ONE-TIME (16 Sep 2026): Lincoln Log's Paycom access is gone, so its
 * historical data can no longer be downloaded. Order matters here: the Out of
 * Scope entry goes in FIRST, because Lincoln passes the previous-system rule
 * (prev = Paycom) and discovery would happily re-add it tomorrow if the rows
 * were merely deleted. Idempotent - a second run finds nothing to do.
 */
function markLincolnOutOfScopeOnce() {
  var done = [];

  // 1. Out of Scope tab - the entry that makes the removal stick.
  var ex = tab_(TAB_EXCLUDED);
  var exists = rows_(ex).some(function (r) {
    return String(r[0] || '').trim() === 'LICO';
  });
  if (!exists) {
    ex.appendRow(['LICO', 'Lincoln Log',
      'Paycom access lost - the historical data can no longer be downloaded. ' +
      'Marked out of scope by Shobhit, 16 Sep 2026.']);
    done.push('Out of Scope entry added');
  }

  // 2. Clients row.
  var sh = tab_(TAB_CLIENTS);
  var values = sh.getDataRange().getValues();
  for (var r = values.length - 1; r >= 1; r--) {
    if (String(values[r][0] || '').trim() === 'LICO') {
      sh.deleteRow(r + 1);
      done.push('Clients row removed');
    }
  }

  // 3. Paycom Status row.
  var st = ss_().getSheetByName(STATUS_TABS['Paycom']);
  if (st) {
    var sv = st.getDataRange().getValues();
    for (var r2 = sv.length - 1; r2 >= 1; r2--) {
      if (norm(String(sv[r2][0] || '')) === norm('Lincoln Log')) {
        st.deleteRow(r2 + 1);
        done.push('Paycom Status row removed');
      }
    }
  }

  console.log(done.length ? done.join('; ') : 'Nothing to do - Lincoln Log already out of scope.');
}

/**
 * ONE-TIME cleanup for v1's mistake (16 Sep 2026): v1 added 12 clients whose
 * previous system is not ADP/Paycom. This removes exactly those rows from the
 * Clients tab and their vendor status tab, and nothing else. Run it once from
 * the editor; running it again finds nothing and says so. Delete this function
 * after use if you like - it lists its targets by code, so it can never touch
 * anything added later.
 */
function cleanupV1OverreachOnce() {
  var CODES = ['OKLL', 'KMLG', 'SEHA', 'ITFL', 'STR4', 'RJGL',
               'LELL', 'HILG', 'KHRT', 'FIFL', 'DMD2', 'SGRT'];
  var removed = [];

  var sh = tab_(TAB_CLIENTS);
  var values = sh.getDataRange().getValues();
  var names = {};
  // Bottom-up, so deleting a row never shifts the ones still to check.
  for (var r = values.length - 1; r >= 1; r--) {
    var code = String(values[r][0] || '').trim();
    if (CODES.indexOf(code) === -1) continue;
    names[norm(String(values[r][1] || ''))] = true;
    sh.deleteRow(r + 1);
    removed.push(code + ' (' + values[r][1] + ')');
  }

  Object.keys(STATUS_TABS).forEach(function (vendor) {
    var st = ss_().getSheetByName(STATUS_TABS[vendor]);
    if (!st) return;
    var sv = st.getDataRange().getValues();
    for (var r = sv.length - 1; r >= 1; r--) {
      if (names[norm(String(sv[r][0] || ''))]) {
        st.deleteRow(r + 1);
        removed.push(STATUS_TABS[vendor] + ' row: ' + sv[r][0]);
      }
    }
  });

  console.log(removed.length
    ? 'Removed:\n  ' + removed.join('\n  ')
    : 'Nothing to remove - already clean.');
}


/* ======================================================================
 * MAIL
 * ====================================================================== */

/**
 * Mail.gs — the daily "Historical data" mail.
 *
 * Written around the reader, not the data. Four people get this every evening
 * (Mercedes, Tierra, Asad, Candace) and each owns a couple of clients. A daily
 * mail that shows the same eleven-row table every day stops being read by about
 * Thursday, so this one is built on three ideas instead:
 *
 *   1. LEAD WITH THE ASK. The headline is the number of files still to fetch,
 *      not a count of clients "needing action". You can act on 74 files.
 *   2. WHAT MOVED. A snapshot of the previous run is kept in Script Properties
 *      so the mail can say what was collected since. That is the only part that
 *      genuinely changes day to day, and it is the reason to open it.
 *   3. GROUP BY OWNER, SURFACE THE WINNABLE. Each implementer gets their own
 *      block with their own name on it, and a client four files from done is
 *      called out ahead of one that has not started - that is the one that can
 *      actually be finished this week.
 *
 * Built out of tables with inline styles, not divs and flexbox: Gmail, Outlook
 * and the Apple clients strip or ignore modern layout CSS. A bar made of two
 * table cells with percentage widths is the one construction that renders the
 * same everywhere.
 */

// ---- palette --------------------------------------------------------------
var C_INK = '#1f1f1f';
var C_SOFT = '#6b6f76';
var C_FAINT = '#9aa0a6';
var C_LINE = '#e6e8eb';
var C_CARD = '#fafbfc';
var C_GREEN = '#1e8e3e';
var C_RED = '#d93025';
var C_AMBER = '#e37400';
var C_TRACK = '#eceff1';
var C_BLUE = '#1a73e8';

var FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif";

// A client this close to done is called out as winnable.
var ALMOST_DONE_THRESHOLD = 5;

function esc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtDate(d) {
  if (!d) return null;
  var parts = String(d).split('-');
  var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return parseInt(parts[2], 10) + ' ' + months[parseInt(parts[1], 10) - 1];
}

/** 'Audit Trail (7): 2025 Q1, 2025 Q2, ...' - kept for any caller that wants
 *  the uncompacted form. */
function phrase(category, labels) {
  return category + ' (' + labels.length + '): ' + labels.join(', ');
}

/** Roll the raw tables up into everything the mail needs. */
function summarise(data) {
  var catalogById = {};
  data.catalog.forEach(function (c) { catalogById[c.id] = c; });
  var scopeByCode = {};
  data.scope.forEach(function (s) { scopeByCode[s.dsp_short_code] = s; });
  var overviewByCode = {};
  data.overview.forEach(function (o) { overviewByCode[o.dsp_short_code] = o; });

  // Out-of-scope clients (access revoked, or on hold via the RAG sync) keep
  // their status rows but must not appear in gaps, complete, or the totals.
  var excludedByCode = {};
  (data.excluded || []).forEach(function (x) { excludedByCode[x.dsp_short_code] = x; });

  var byCode = {};
  data.status.forEach(function (r) {
    if (excludedByCode[r.dsp_short_code]) return;
    var c = byCode[r.dsp_short_code];
    if (!c) {
      var ov = overviewByCode[r.dsp_short_code] || {};
      var sc = scopeByCode[r.dsp_short_code] || {};
      c = byCode[r.dsp_short_code] = {
        code: r.dsp_short_code,
        name: ov.dsp_name || r.dsp_short_code,
        implementor: ov.implementor || 'Unassigned',
        vendor: sc.vendor || 'vendor not set',
        folderUrl: sc.folder_url || null,
        pending: 0, received: 0, na: 0, total: 0,
        checked: null,
        cats: {}
      };
    }
    c.total++;
    if (r.status === 'Pending') {
      c.pending++;
      var cat = catalogById[r.report_id];
      if (cat) {
        var label = r.unit_label === 'Report' ? cat.report_name : r.unit_label;
        (c.cats[cat.category] = c.cats[cat.category] || []).push(label);
      }
    } else if (r.status === 'Received') {
      c.received++;
    } else {
      c.na++;
    }
    if (r.checked_date && (!c.checked || r.checked_date > c.checked)) {
      c.checked = r.checked_date;
    }
  });

  var clients = Object.keys(byCode).map(function (k) { return byCode[k]; });

  // The ratio must be against the reports that APPLY, not every catalogue row.
  // 'Not applicable' is a human decision that the report cannot exist for this
  // client - a quarter not yet due, a module they never used. Counting those in
  // the denominator makes a client look short by reports nobody will ever
  // collect: 10 received with 5 n/a showed as '10/18', so the reader subtracts
  // and expects 8 outstanding when only 3 are.
  clients.forEach(function (c) { c.applicable = c.total - c.na; });

  var gaps = clients.filter(function (c) { return c.pending > 0; });
  var complete = clients.filter(function (c) { return c.pending === 0; });
  var notStarted = gaps.filter(function (c) { return c.received === 0; });
  var partial = gaps.filter(function (c) { return c.received > 0; });
  var almostDone = partial.filter(function (c) {
    return c.pending <= ALMOST_DONE_THRESHOLD;
  }).sort(function (a, b) { return a.pending - b.pending; });

  var tally = {};
  gaps.forEach(function (c) {
    Object.keys(c.cats).forEach(function (cat) {
      tally[cat] = (tally[cat] || 0) + c.cats[cat].length;
    });
  });

  // Most winnable first: fewest reports left, then alphabetical. A client that
  // has not started sinks to the bottom - it needs a folder created, not a file
  // fetched, so it is a different kind of task.
  gaps.sort(function (a, b) {
    if ((a.received === 0) !== (b.received === 0)) return a.received === 0 ? 1 : -1;
    return a.pending - b.pending || a.name.localeCompare(b.name);
  });

  var owners = {};
  gaps.forEach(function (c) {
    var o = owners[c.implementor] = owners[c.implementor] ||
      { name: c.implementor, clients: [], pending: 0 };
    o.clients.push(c);
    o.pending += c.pending;
  });
  var ownerList = Object.keys(owners).map(function (k) { return owners[k]; })
    .sort(function (a, b) {
      return b.pending - a.pending || a.name.localeCompare(b.name);
    });

  var totalPending = 0, totalDone = 0, totalApplicable = 0;
  clients.forEach(function (c) {
    totalPending += c.pending;
    totalDone += c.received;
    totalApplicable += c.applicable;
  });

  // Two different kinds of "not in the report": paused (comes back on its own
  // when the tracker's RAG is active) and gone-for-good (access revoked). The
  // mail says which is which - lumping Trek in with "access revoked" would be
  // telling the team something false.
  var onHoldNames = [], excludedNames = [];
  (data.excluded || []).forEach(function (x) {
    var ov = overviewByCode[x.dsp_short_code];
    var nm = (ov && ov.dsp_name) || x.dsp_name || x.dsp_short_code;
    if (String(x.reason || '').toLowerCase().indexOf('hold') !== -1) {
      onHoldNames.push(nm);
    } else {
      excludedNames.push(nm);
    }
  });
  onHoldNames.sort();
  excludedNames.sort();

  // On the Clients tab but in no status tab - almost always a discovered
  // client whose vendor is still blank. Tracking is paused for them, and
  // saying so loudly is the difference between "paused" and "forgotten".
  var hasStatusRow = {};
  data.status.forEach(function (r) { hasStatusRow[r.dsp_short_code] = true; });
  var untracked = [];
  data.overview.forEach(function (o) {
    if (hasStatusRow[o.dsp_short_code] || excludedByCode[o.dsp_short_code]) return;
    var sc = scopeByCode[o.dsp_short_code] || {};
    untracked.push({ name: o.dsp_name, implementor: o.implementor || 'unassigned',
                     folderUrl: sc.folder_url || null });
  });
  untracked.sort(function (a, b) { return a.name.localeCompare(b.name); });

  return { clients: clients, gaps: gaps, complete: complete,
           notStarted: notStarted, partial: partial, almostDone: almostDone,
           owners: ownerList, tally: tally, excludedNames: excludedNames,
           onHoldNames: onHoldNames, untracked: untracked,
           totalPending: totalPending, totalDone: totalDone,
           totalApplicable: totalApplicable };
}

function orderedCats(c) {
  return Object.keys(c.cats).sort(function (a, b) {
    return categoryRank(a) - categoryRank(b) || a.localeCompare(b);
  });
}

function pctOf(done, total) {
  return total > 0 ? Math.round((done / total) * 100) : 0;
}

// ---- the previous run's snapshot ------------------------------------------
// Only runDaily saves one, so previewing the mail never consumes the delta.

var SNAPSHOT_KEY = 'PREV_SNAPSHOT';

function loadSnapshot() {
  try {
    var raw = PropertiesService.getScriptProperties().getProperty(SNAPSHOT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;    // a corrupt snapshot must never cost the mail
  }
}

function saveSnapshot(s) {
  try {
    var snap = {
      date: Utilities.formatDate(new Date(), 'Asia/Kolkata', 'yyyy-MM-dd'),
      done: s.totalDone,
      byClient: {}
    };
    s.clients.forEach(function (c) { snap.byClient[c.code] = c.received; });
    PropertiesService.getScriptProperties()
      .setProperty(SNAPSHOT_KEY, JSON.stringify(snap));
  } catch (e) { /* never worth failing the run over */ }
}

/** What moved since the last saved snapshot. null when there is nothing to say. */
function movement(s, snap) {
  if (!snap || typeof snap.done !== 'number') return null;
  var movers = [];
  s.clients.forEach(function (c) {
    var was = snap.byClient ? snap.byClient[c.code] : undefined;
    if (typeof was === 'number' && c.received > was) {
      movers.push({ name: c.name, gained: c.received - was });
    }
  });
  movers.sort(function (a, b) { return b.gained - a.gained; });
  return { delta: s.totalDone - snap.done, since: snap.date, movers: movers };
}

// ---- label compaction -----------------------------------------------------

/**
 * Turn a run of period labels into a range.
 *
 * Seven separate 'Audit Trail 2025 Q1 ... 2026 Q3' entries fill a line and say
 * nothing more than '2025 Q1 - 2026 Q3 (7 quarters)' does. Only collapses when
 * the labels really are consecutive, so a genuine hole in the middle still gets
 * listed item by item - that hole is the interesting part.
 */
function compactLabels(labels) {
  if (labels.length < 3) return labels.join(', ');

  var quarters = labels.every(function (l) { return /^\d{4} Q[1-4]$/.test(l); });
  var years = labels.every(function (l) { return /^\d{4}$/.test(l); });
  if (!quarters && !years) return labels.join(', ');

  var idx = labels.map(function (l) {
    if (years) return parseInt(l, 10);
    var m = /^(\d{4}) Q([1-4])$/.exec(l);
    return parseInt(m[1], 10) * 4 + parseInt(m[2], 10);
  }).sort(function (a, b) { return a - b; });

  for (var i = 1; i < idx.length; i++) {
    if (idx[i] !== idx[i - 1] + 1) return labels.join(', ');   // not a clean run
  }
  var sorted = labels.slice().sort();
  return sorted[0] + ' – ' + sorted[sorted.length - 1] +
         ' (' + labels.length + (years ? ' years)' : ' quarters)');
}

/** One line describing everything a client still owes. */
function outstandingLine(c) {
  return orderedCats(c).map(function (cat) {
    return cat + ': ' + compactLabels(c.cats[cat]);
  }).join('   ·   ');
}

// ---- html pieces ----------------------------------------------------------

/**
 * A progress bar, email-safe.
 *
 * Two table cells with percentage widths. Zero and full collapse to one cell,
 * because a 0%-wide cell still renders a visible sliver in Outlook and would
 * show progress where there is none.
 */
function bar(done, total, height, colour) {
  var h = height || 6;
  var col = colour || C_GREEN;
  var pct = pctOf(done, total);
  var cell = 'height:' + h + 'px;font-size:0;line-height:0;';
  var r = h / 2;
  var out = '<table width="100%" cellpadding="0" cellspacing="0" border="0" ' +
            'style="border-collapse:separate;table-layout:fixed;"><tr>';
  if (pct <= 0) {
    out += '<td style="' + cell + 'background:' + C_TRACK + ';border-radius:' +
           r + 'px;">&nbsp;</td>';
  } else if (pct >= 100) {
    out += '<td style="' + cell + 'background:' + col + ';border-radius:' +
           r + 'px;">&nbsp;</td>';
  } else {
    out += '<td width="' + pct + '%" style="' + cell + 'background:' + col +
           ';border-radius:' + r + 'px 0 0 ' + r + 'px;">&nbsp;</td>' +
           '<td width="' + (100 - pct) + '%" style="' + cell + 'background:' +
           C_TRACK + ';border-radius:0 ' + r + 'px ' + r + 'px 0;">&nbsp;</td>';
  }
  return out + '</tr></table>';
}

function rule() {
  return '<div style="border-top:1px solid ' + C_LINE + ';margin:26px 0 0;"></div>';
}

function eyebrow(text) {
  return '<div style="font:600 11px/1.4 ' + FONT + ';color:' + C_FAINT +
    ';text-transform:uppercase;letter-spacing:1px;padding:22px 0 12px;">' +
    esc(text) + '</div>';
}

/** One client line inside a block. */
function clientRow(c, first) {
  var pct = pctOf(c.received, c.applicable);
  var name = esc(c.name);
  if (c.folderUrl) {
    name = '<a href="' + esc(c.folderUrl) + '" style="color:' + C_INK +
           ';text-decoration:none;border-bottom:1px solid ' + C_LINE + ';">' +
           name + '</a>';
  }
  var left = c.received === 0
    ? '<span style="color:' + C_AMBER + ';font-weight:600;">not started</span>'
    : '<span style="color:' + C_RED + ';font-weight:600;">' + c.pending + ' left</span>';

  var p = [];
  p.push('<table width="100%" cellpadding="0" cellspacing="0" border="0" style="' +
         (first ? '' : 'border-top:1px solid ' + C_LINE + ';') + '">' +
         '<tr><td style="padding:' + (first ? '0' : '14px') + ' 0 14px;">');

  p.push('<table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>' +
         '<td style="font:600 14px/1.4 ' + FONT + ';color:' + C_INK + ';">' + name +
         '</td><td align="right" style="white-space:nowrap;font:13px/1.4 ' + FONT +
         ';color:' + C_SOFT + ';">' + left + '</td></tr></table>');

  p.push('<table width="100%" cellpadding="0" cellspacing="0" border="0" ' +
         'style="margin-top:8px;"><tr><td>' + bar(c.received, c.applicable) +
         '</td><td width="90" align="right" style="font:12px/1 ' + FONT +
         ';color:' + C_SOFT + ';padding-left:12px;white-space:nowrap;">' +
         c.received + '/' + c.applicable + '  ' + pct + '%</td></tr></table>');

  if (c.received === 0) {
    p.push('<div style="font:12px/1.6 ' + FONT + ';color:' + C_AMBER +
           ';padding-top:9px;">No Historical Data folder in Drive yet &mdash; ' +
           'create it and start the pull.</div>');
  } else {
    p.push('<div style="font:12px/1.6 ' + FONT + ';color:' + C_SOFT +
           ';padding-top:9px;">' + esc(outstandingLine(c)) + '</div>');
  }

  p.push('</td></tr></table>');
  return p.join('');
}

function buildSubject(s) {
  // The ask, not a status. '74 reports' is something you can act on; '5 of 11
  // clients need action' has to be decoded by opening the mail.
  var today = Utilities.formatDate(new Date(), 'Asia/Kolkata', 'MM/dd/yyyy');
  if (!s.totalPending) return 'Historical data — all clients complete — ' + today;
  return 'Historical data — ' + s.totalPending + ' reports to collect across ' +
    s.gaps.length + ' client' + (s.gaps.length === 1 ? '' : 's') + ' — ' + today;
}

function buildHtml(s, excluded, snap) {
  var p = [];
  var move = movement(s, snap);
  var pct = pctOf(s.totalDone, s.totalApplicable);

  p.push('<div style="max-width:660px;font-family:' + FONT + ';color:' + C_INK +
         ';background:#ffffff;">');

  // ---- headline: the ask --------------------------------------------------
  p.push('<div style="font:11px/1.4 ' + FONT + ';color:' + C_FAINT +
         ';text-transform:uppercase;letter-spacing:1px;">Historical data &nbsp;·&nbsp; ' +
         esc(Utilities.formatDate(new Date(), 'Asia/Kolkata', 'EEE d MMM yyyy')) +
         '</div>');

  if (s.totalPending) {
    p.push('<div style="font:600 30px/1.25 ' + FONT + ';color:' + C_INK +
           ';padding:10px 0 0;">' + s.totalPending + ' reports still to collect</div>');
    p.push('<div style="font:14px/1.5 ' + FONT + ';color:' + C_SOFT +
           ';padding:4px 0 0;">across ' + s.gaps.length + ' client' +
           (s.gaps.length === 1 ? '' : 's') + ' &nbsp;·&nbsp; ' +
           s.complete.length + ' already complete</div>');
  } else {
    p.push('<div style="font:600 30px/1.25 ' + FONT + ';color:' + C_GREEN +
           ';padding:10px 0 0;">Everything collected</div>');
    p.push('<div style="font:14px/1.5 ' + FONT + ';color:' + C_SOFT +
           ';padding:4px 0 0;">All ' + s.clients.length +
           ' clients complete. Nothing outstanding.</div>');
  }

  p.push('<div style="padding:20px 0 0;">' + bar(s.totalDone, s.totalApplicable, 8) + '</div>');
  p.push('<div style="font:12px/1.5 ' + FONT + ';color:' + C_SOFT +
         ';padding:8px 0 0;">' + s.totalDone + ' of ' + s.totalApplicable +
         ' collected &nbsp;·&nbsp; ' + pct + '%</div>');

  // ---- what moved ---------------------------------------------------------
  // The only part that differs from yesterday, and the reason to open this.
  if (move) {
    var txt, colour;
    if (move.delta > 0) {
      colour = C_GREEN;
      txt = '&#9650;&nbsp; ' + move.delta + ' report' + (move.delta === 1 ? '' : 's') +
            ' collected since ' + esc(fmtDate(move.since) || move.since);
      if (move.movers.length) {
        txt += ' &mdash; ' + esc(move.movers.map(function (m) {
          return m.name + ' +' + m.gained;
        }).join(', '));
      }
    } else if (move.delta === 0) {
      colour = C_SOFT;
      txt = 'No change since ' + esc(fmtDate(move.since) || move.since);
    } else {
      // Went down: someone corrected the sheet by hand. Say it plainly rather
      // than hide it - it means a status was wrong yesterday.
      colour = C_AMBER;
      txt = (-move.delta) + ' fewer than ' + esc(fmtDate(move.since) || move.since) +
            ' &mdash; a status was corrected in the sheet.';
    }
    p.push('<div style="font:13px/1.6 ' + FONT + ';color:' + colour +
           ';padding:14px 0 0;">' + txt + '</div>');
  }

  // ---- closest to done ----------------------------------------------------
  if (s.almostDone.length) {
    p.push(rule());
    p.push(eyebrow('Closest to done'));
    p.push('<div style="font:13px/1.6 ' + FONT + ';color:' + C_SOFT +
           ';padding:0 0 14px;">A handful of files finishes each of these.</div>');
    p.push('<table width="100%" cellpadding="0" cellspacing="0" border="0" ' +
           'style="background:' + C_CARD + ';border:1px solid ' + C_LINE +
           ';border-radius:12px;"><tr><td style="padding:16px 18px;">');
    s.almostDone.forEach(function (c, i) { p.push(clientRow(c, i === 0)); });
    p.push('</td></tr></table>');
  }

  // ---- by implementer -----------------------------------------------------
  if (s.owners.length) {
    p.push(rule());
    p.push(eyebrow('By implementer'));
    s.owners.forEach(function (o) {
      p.push('<table width="100%" cellpadding="0" cellspacing="0" border="0" ' +
             'style="margin:0 0 12px;border:1px solid ' + C_LINE +
             ';border-radius:12px;"><tr><td style="padding:16px 18px;">');
      p.push('<table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>' +
             '<td style="font:600 13px/1.4 ' + FONT + ';color:' + C_INK +
             ';text-transform:uppercase;letter-spacing:.6px;">' + esc(o.name) +
             '</td><td align="right" style="font:12px/1.4 ' + FONT + ';color:' +
             C_SOFT + ';white-space:nowrap;">' + o.clients.length + ' client' +
             (o.clients.length === 1 ? '' : 's') + ' &nbsp;·&nbsp; ' +
             '<span style="color:' + C_RED + ';font-weight:600;">' + o.pending +
             ' reports</span></td></tr></table>');
      p.push('<div style="border-top:1px solid ' + C_LINE + ';margin:10px 0 14px;"></div>');
      o.clients.forEach(function (c, i) { p.push(clientRow(c, i === 0)); });
      p.push('</td></tr></table>');
    });
  }

  // ---- discovered but not yet tracked -------------------------------------
  // Loud on purpose: these have a Historical Data folder in Drive, so they ARE
  // in scope, but per-report tracking cannot start until the vendor is set.
  if (s.untracked.length) {
    p.push(rule());
    p.push(eyebrow('Found in Drive, not yet tracked'));
    p.push('<table width="100%" cellpadding="0" cellspacing="0" border="0" ' +
           'style="background:#fdeeee;border:1px solid #f5c6c4;border-radius:12px;">' +
           '<tr><td style="padding:14px 16px;">');
    p.push('<div style="font:13px/1.6 ' + FONT + ';color:#8a1f1b;padding-bottom:8px;">' +
           'These clients have a Historical Data folder in Drive but no vendor set ' +
           'in the tracker sheet, so their reports are not being counted yet. ' +
           'Set the Vendor (ADP / Paycom) on the Clients tab and tracking starts ' +
           'on the next run.</div>');
    s.untracked.forEach(function (u) {
      var nm = esc(u.name);
      if (u.folderUrl) {
        nm = '<a href="' + esc(u.folderUrl) + '" style="color:#8a1f1b;">' + nm + '</a>';
      }
      p.push('<div style="font:600 13px/1.8 ' + FONT + ';color:#8a1f1b;">' + nm +
             '<span style="font-weight:400;color:#a8524e;"> &nbsp;' +
             esc(u.implementor) + '</span></div>');
    });
    p.push('</td></tr></table>');
  }

  // ---- complete, one quiet line -------------------------------------------
  if (s.complete.length) {
    p.push(rule());
    p.push(eyebrow('Complete'));
    p.push('<div style="font:13px/1.8 ' + FONT + ';color:' + C_SOFT + ';">' +
           '<span style="color:' + C_GREEN + ';">&#10003;</span> ' +
           esc(s.complete.map(function (c) { return c.name; }).sort().join('  ·  ')) +
           '</div>');
  }

  // ---- notes --------------------------------------------------------------
  if (s.onHoldNames && s.onHoldNames.length) {
    p.push('<div style="margin:22px 0 0;padding:13px 16px;background:#fef7e6;' +
           'border-radius:10px;font:12px/1.6 ' + FONT + ';color:#7a5300;">' +
           '<strong>On hold:</strong> ' + esc(s.onHoldNames.join(', ')) +
           ' &mdash; paused per the onboarding tracker&rsquo;s RAG. They come back ' +
           'into this report automatically when the RAG is active again.</div>');
  }
  if (s.excludedNames && s.excludedNames.length) {
    p.push('<div style="margin:' + (s.onHoldNames && s.onHoldNames.length ? '10px' : '22px') +
           ' 0 0;padding:13px 16px;background:#fef7e6;' +
           'border-radius:10px;font:12px/1.6 ' + FONT + ';color:#7a5300;">' +
           '<strong>Out of scope:</strong> ' + esc(s.excludedNames.join(', ')) +
           ' &mdash; ADP/Paycom access revoked, the historical data can no longer ' +
           'be downloaded. Please do not chase these.</div>');
  }

  // ---- footer -------------------------------------------------------------
  p.push('<div style="padding:24px 0 0;font:13px/1.6 ' + FONT + ';">' +
         '<a href="' + sheetUrl() + '" style="color:' + C_BLUE +
         ';text-decoration:none;font-weight:600;">Open the tracker sheet</a>' +
         '&nbsp;&nbsp;·&nbsp;&nbsp;<a href="' + TRACKER_URL + '" style="color:' +
         C_BLUE + ';text-decoration:none;">Implementation tracker</a></div>');
  p.push('<div style="padding:12px 0 0;font:11px/1.6 ' + FONT + ';color:' + C_FAINT + ';">' +
         'From a nightly scan of each client&rsquo;s Historical Data folder in ' +
         'Drive. A report counts as collected only when the file is actually ' +
         'there. Reports marked not applicable are left out of the totals rather ' +
         'than counted as outstanding.</div>');

  p.push('</div>');
  return p.join('');
}

function buildText(s, snap) {
  var move = movement(s, snap);
  var lines = [];
  lines.push(s.totalPending
    ? s.totalPending + ' REPORTS STILL TO COLLECT across ' + s.gaps.length + ' client(s)'
    : 'EVERYTHING COLLECTED - all ' + s.clients.length + ' clients complete');
  lines.push(s.totalDone + ' of ' + s.totalApplicable + ' collected (' +
             pctOf(s.totalDone, s.totalApplicable) + '%)');
  if (move) {
    if (move.delta > 0) {
      lines.push('+' + move.delta + ' since ' + (fmtDate(move.since) || move.since) +
        (move.movers.length ? ': ' + move.movers.map(function (m) {
          return m.name + ' +' + m.gained; }).join(', ') : ''));
    } else if (move.delta === 0) {
      lines.push('No change since ' + (fmtDate(move.since) || move.since));
    } else {
      lines.push((-move.delta) + ' fewer than ' + (fmtDate(move.since) || move.since) +
                 ' - a status was corrected in the sheet.');
    }
  }

  if (s.almostDone.length) {
    lines.push('', 'CLOSEST TO DONE');
    s.almostDone.forEach(function (c) {
      lines.push('  ' + c.name + ' (' + c.implementor + ')  ' + c.received + '/' +
                 c.applicable + ', ' + c.pending + ' left');
      lines.push('      ' + outstandingLine(c));
    });
  }

  s.owners.forEach(function (o) {
    lines.push('', o.name.toUpperCase() + ' - ' + o.clients.length +
               ' client(s), ' + o.pending + ' reports');
    o.clients.forEach(function (c) {
      lines.push('  ' + c.name + '  ' + c.received + '/' + c.applicable +
                 (c.received === 0 ? '  NOT STARTED' : '  ' + c.pending + ' left') +
                 (c.na ? '  (' + c.na + ' n/a)' : ''));
      lines.push('      ' + (c.received === 0
        ? 'No Historical Data folder in Drive yet.'
        : outstandingLine(c)));
    });
  });

  if (s.untracked.length) {
    lines.push('', 'FOUND IN DRIVE, NOT YET TRACKED (set Vendor on the Clients tab):');
    s.untracked.forEach(function (u) {
      lines.push('  ' + u.name + ' (' + u.implementor + ')');
    });
  }

  if (s.complete.length) {
    lines.push('', 'COMPLETE: ' +
      s.complete.map(function (c) { return c.name; }).sort().join(', '));
  }
  if (s.onHoldNames && s.onHoldNames.length) {
    lines.push('', 'ON HOLD (auto-returns when the tracker RAG is active): ' +
               s.onHoldNames.join(', '));
  }
  if (s.excludedNames && s.excludedNames.length) {
    lines.push('', 'OUT OF SCOPE (do not chase): ' + s.excludedNames.join(', '));
  }
  lines.push('', 'Tracker sheet: ' + sheetUrl(),
             'Implementation tracker: ' + TRACKER_URL);
  return lines.join('\n');
}


/* ======================================================================
 * CRM PUSH
 * ====================================================================== */

/**
 * A read-only copy of the tracker goes to the DSP CRM's Supabase after every
 * daily run, feeding its Data > Historical tab (Phase 3 of the platform
 * merge). The SHEET stays the single source of truth: the CRM copy is wiped
 * and rewritten whole each push, nothing ever flows back, and a push failure
 * costs one log line, never the mail.
 *
 * Setup (once): Project Settings > Script properties > add
 *   CRM_URL          https://<the CRM project>.supabase.co
 *   CRM_SERVICE_KEY  the CRM's secret (service role) key
 * Until both exist every push logs a skip and does nothing.
 */

function crmConf_() {
  var p = PropertiesService.getScriptProperties();
  var url = String(p.getProperty('CRM_URL') || '').trim().replace(/\/+$/, '');
  var key = String(p.getProperty('CRM_SERVICE_KEY') || '').trim();
  return url && key ? { url: url, key: key } : null;
}

function crmFetch_(conf, method, path, body) {
  var res = UrlFetchApp.fetch(conf.url + '/rest/v1/' + path, {
    method: method,
    contentType: 'application/json',
    headers: { apikey: conf.key, Authorization: 'Bearer ' + conf.key,
               Prefer: 'return=minimal' },
    payload: body === undefined ? undefined : JSON.stringify(body),
    muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  if (code >= 300) {
    throw new Error(method + ' ' + path.split('?')[0] + ' -> HTTP ' + code +
                    ': ' + String(res.getContentText()).slice(0, 300));
  }
}

function pushToCrm(data) {
  var conf = crmConf_();
  if (!conf) {
    console.log('CRM push skipped: CRM_URL / CRM_SERVICE_KEY script properties not set.');
    return;
  }
  if (!data) data = loadAll();

  var byId = {};
  data.catalog.forEach(function (c) { byId[c.id] = c; });
  var nameOf = {}, implOf = {};
  data.overview.forEach(function (o) {
    nameOf[o.dsp_short_code] = o.dsp_name;
    implOf[o.dsp_short_code] = o.implementor;
  });

  // One pass over the status rows builds both the per-report copy and the
  // per-client counts, so the two can never disagree.
  var counts = {};
  var statusRows = data.status.map(function (s) {
    var c = byId[s.report_id] || {};
    var n = counts[s.dsp_short_code] =
      counts[s.dsp_short_code] || { received: 0, pending: 0, na: 0 };
    if (s.status === 'Received') n.received++;
    else if (s.status === 'Not applicable') n.na++;
    else n.pending++;
    return { dsp_short_code: s.dsp_short_code, vendor: c.vendor || null,
             category: c.category || null, report_name: c.report_name || null,
             unit_label: s.unit_label || null, status: s.status };
  });

  var clientRows = data.scope.map(function (sc) {
    var n = counts[sc.dsp_short_code] || { received: 0, pending: 0, na: 0 };
    return { dsp_short_code: sc.dsp_short_code,
             dsp_name: nameOf[sc.dsp_short_code] || sc.dsp_short_code,
             vendor: sc.vendor || null,
             implementor: implOf[sc.dsp_short_code] || null,
             folder_url: sc.folder_url, last_scanned: sc.last_scanned,
             received: n.received, pending: n.pending, not_applicable: n.na };
  });

  var exRows = data.excluded.map(function (x) {
    return { dsp_short_code: x.dsp_short_code, dsp_name: x.dsp_name,
             reason: x.reason, notes: x.notes || null };
  });

  [['hist_clients', clientRows],
   ['hist_status', statusRows],
   ['hist_out_of_scope', exRows]].forEach(function (t) {
    crmFetch_(conf, 'delete', t[0] + '?id=gt.0');
    for (var i = 0; i < t[1].length; i += 200) {
      crmFetch_(conf, 'post', t[0], t[1].slice(i, i + 200));
    }
    console.log('CRM push: ' + t[0] + ' = ' + t[1].length + ' rows');
  });
}

/** Run by hand: push the sheet's current state to the CRM, nothing else. */
function pushToCrmOnly() { pushToCrm(null); }


/* ======================================================================
 * MAIN
 * ====================================================================== */

/**
 * Main.gs — entry points.
 *
 *   installTrigger()  run ONCE by hand: schedules runDaily at 17:30 IST
 *   previewOnly()     run by hand: builds the mail, logs it, sends nothing
 *   scanOnly()        run by hand: scans Drive, writes results, no mail
 *   runDaily()        what the trigger calls: scan, then mail
 *
 * Nothing here depends on Claude Code or on any laptop being switched on.
 */

/** Scan Drive, then send the mail. Called by the daily trigger. */
function runDaily() {
  var started = new Date();
  var data = loadAll();

  // Discovery first: Drive decides who is in scope, not the sheet. A client
  // folder with a Historical Data subfolder that the sheet does not know gets
  // added now, so the scan below already covers it. A discovery failure must
  // not cost the mail.
  var disco = { added: [], pending: [], statusRowsCreated: [], log: [] };
  try {
    disco = discoverAndSync(data);
    if (disco.added.length || disco.statusRowsCreated.length || disco.holdChanged) {
      data = loadAll();
    }
  } catch (e) {
    disco.log = ['DISCOVERY FAILED: ' + e.message + ' - continuing with known clients'];
  }
  disco.log.forEach(function (l) { console.log(l); });

  // Scan next so the mail reports today's Drive contents, not yesterday's.
  // A scan failure must not cost the mail: the per-client 'last checked' date
  // makes a skipped scan visible to the reader instead of hiding it.
  var scanLog = [];
  try {
    scanLog = runScan(data);
    // Re-read so the mail reflects what the scan just wrote.
    data = loadAll();
  } catch (e) {
    scanLog = ['SCAN FAILED: ' + e.message + ' - mail sent from existing data'];
  }
  scanLog.forEach(function (l) { console.log(l); });

  var s = summarise(data);
  // Read the previous run's snapshot BEFORE saving this one, so the mail can
  // say what moved. Only this function saves - previewOnly must never consume
  // the delta, or the next real mail would report "no change" wrongly.
  var snap = loadSnapshot();

  var subject = buildSubject(s);
  var html = buildHtml(s, data.excluded, snap);
  var text = buildText(s, snap);

  if (html.length < 500) {
    throw new Error('Generated body is too short (' + html.length +
                    ' chars) - refusing to send.');
  }

  MailApp.sendEmail({
    to: MAIL_TO.join(','),
    subject: subject,
    body: text,
    htmlBody: html
  });

  // Saved only after the send succeeds. If the mail failed, the delta must
  // still be waiting for the next run rather than silently swallowed.
  saveSnapshot(s);

  var secs = Math.round((new Date() - started) / 1000);
  console.log('SENT "' + subject + '" to ' + MAIL_TO.length + ' recipients in ' +
              secs + 's');

  // Last, so a CRM hiccup can never cost the mail or the snapshot.
  try { pushToCrm(data); }
  catch (e) { console.log('CRM PUSH FAILED: ' + e.message); }
}

/** Build and log the mail without sending. Use this to eyeball changes. */
function previewOnly() {
  var data = loadAll();
  var s = summarise(data);
  var snap = loadSnapshot();     // read, never saved - see runDaily
  console.log('SUBJECT: ' + buildSubject(s));
  console.log(buildText(s, snap));
  console.log('--- html length: ' + buildHtml(s, data.excluded, snap).length + ' chars');
  if (!snap) {
    console.log('--- no previous snapshot yet, so the mail has no "what moved" ' +
                'line. It appears from the second real send onwards.');
  }
}

/** Scan Drive and write results, without mailing. */
function scanOnly() {
  var data = loadAll();
  runScan(data).forEach(function (l) { console.log(l); });
}

/** Find new client folders in Drive and add them to the sheet, without
 *  scanning or mailing. Safe to run any time; it never adds a client twice. */
function discoverOnly() {
  var data = loadAll();
  var disco = discoverAndSync(data);
  disco.log.forEach(function (l) { console.log(l); });
  disco.added.forEach(function (a) { console.log('  + ' + a); });
  if (!disco.added.length && !disco.statusRowsCreated.length) {
    console.log('Nothing new - every Drive client with a Historical Data ' +
                'folder is already tracked.');
  }
}

/** Check the sheet wiring without touching Drive or sending anything.
 *  The first thing to run after pasting SHEET_ID. */
function checkSetup() {
  var data = loadAll();
  console.log('Sheet read OK: ' + data.status.length + ' status cells, ' +
              data.catalog.length + ' catalog rows, ' + data.overview.length +
              ' clients, ' + data.excluded.length + ' out of scope.');

  // A client on the Clients tab with no status cells means its name does not
  // match any row in its vendor's status tab - the commonest sheet-edit
  // mistake, and one that would silently drop the client from the mail.
  var seen = {};
  data.status.forEach(function (r) { seen[r.dsp_short_code] = true; });
  var orphans = data.overview.filter(function (o) { return !seen[o.dsp_short_code]; });
  if (orphans.length) {
    console.log('WARNING - these clients have no rows in a status tab, check ' +
                'the name matches exactly: ' +
                orphans.map(function (o) { return o.dsp_name; }).join(', '));
  }

  var s = summarise(data);
  console.log(s.gaps.length + ' clients with gaps, ' + s.complete.length + ' complete.');
  console.log('Mail would go to: ' + MAIL_TO.join(', '));
  console.log('Sheet: ' + sheetUrl());
}

/**
 * Schedule runDaily for 17:30 IST. Safe to re-run: it clears its own previous
 * trigger first, so you never end up with two and two mails a day.
 *
 * Apps Script fires an hourly-anchored trigger inside a window rather than on
 * the exact minute, so expect the mail between about 17:30 and 17:45 IST. The
 * project timezone is set to Asia/Kolkata in appsscript.json - if that is
 * wrong, this lands at 17:30 in some other zone.
 */
function installTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'runDaily') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('runDaily')
    .timeBased()
    .atHour(17)
    .nearMinute(30)
    .everyDays(1)
    .create();
  console.log('Trigger installed: runDaily, daily ~17:30 ' +
              Session.getScriptTimeZone());
}

/** Remove the daily trigger - the off switch. */
function removeTrigger() {
  var n = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'runDaily') { ScriptApp.deleteTrigger(t); n++; }
  });
  console.log('Removed ' + n + ' trigger(s).');
}
