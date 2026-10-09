/**
 * The refresh jobs. Each one reads prod and writes one table in OUR Supabase.
 *
 * Ports of the scripts/ files of the same name. Adding the next job is adding
 * one entry to JOBS -- index.ts does not change.
 *
 * The shape every job follows, and the reason for it:
 *
 *   1. read what we need from our Supabase
 *   2. read prod            <- everything that can fail, fails here
 *   3. write our Supabase
 *
 * PostgREST gives no transaction, so a delete-then-insert job cannot be
 * atomic the way the Python was (psycopg2 held both in one commit). Fetching
 * all of prod BEFORE deleting anything shrinks the window where the table is
 * empty to the length of the insert, and means a prod failure leaves the old
 * data in place rather than an empty table.
 */
import { onboardingQuery, prodQuery, sqlList } from './prodQuery.ts';
import { FEIN_NAME } from './feinNames.ts';

export interface JobCtx {
  dashUrl: string;
  dashKey: string;
  creds: { username: string; password: string };
  // The onboarding backend is a different system with its own login; see the
  // second half of prodQuery.ts. Absent unless its secrets are set.
  onboarding?: { username: string; password: string; fein: string };
  dryRun: boolean;
}

export interface JobResult {
  job: string;
  ok: boolean;
  log: string[];
  queryIds: string[];
}

/* ---------------------------------------------------------------- helpers */

async function dash(
  ctx: JobCtx,
  method: string,
  path: string,
  body?: unknown,
  prefer?: string,
): Promise<Response> {
  const res = await fetch(`${ctx.dashUrl}/rest/v1/${path}`, {
    method,
    headers: {
      'apikey': ctx.dashKey,
      'Authorization': `Bearer ${ctx.dashKey}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal' + (prefer ? `,${prefer}` : ''),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const text = (await res.text()).slice(0, 300);
    // A 403 with code 42501 here is a missing GRANT on service_role, not a
    // bad key -- our tables were created through raw psycopg2. See
    // scripts/grant_service_role.py.
    throw new Error(`${method} ${path.split('?')[0]} -> HTTP ${res.status}: ${text}`);
  }
  return res;
}

async function dashSelect(
  ctx: JobCtx,
  table: string,
  query: string,
): Promise<Record<string, unknown>[]> {
  const res = await fetch(`${ctx.dashUrl}/rest/v1/${table}?${query}`, {
    headers: { 'apikey': ctx.dashKey, 'Authorization': `Bearer ${ctx.dashKey}` },
  });
  if (!res.ok) {
    throw new Error(`GET ${table} -> HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return await res.json();
}

async function dashInsertChunked(
  ctx: JobCtx,
  table: string,
  rows: unknown[],
  chunk = 500,
): Promise<void> {
  for (let i = 0; i < rows.length; i += chunk) {
    await dash(ctx, 'POST', table, rows.slice(i, i + chunk));
  }
}

/* ------------------------------------------------- work locations (Step 1) */

/**
 * Port of scripts/populate_work_locations.py.
 *
 * fein is matched with the dashes stripped on BOTH sides: prod stores it
 * either way and client_overview holds the normalised form.
 */
async function workLocations(ctx: JobCtx): Promise<JobResult> {
  const log: string[] = [];

  const overview = await dashSelect(
    ctx, 'client_overview', 'select=dsp_short_code,fein&fein=not.is.null');
  const codeByFein = new Map<string, string>();
  for (const r of overview) {
    codeByFein.set(String(r.fein), String(r.dsp_short_code));
  }
  log.push(`${codeByFein.size} DSPs with a known fein`);
  if (!codeByFein.size) {
    return { job: 'work_locations', ok: true, log: [...log, 'nothing to do'], queryIds: [] };
  }

  const sql =
    "select replace(coalesce(eo.fein,''),'-','') as fein_norm, " +
    'wl.work_location_name, wl.address_line1, wl.address_line2, ' +
    'wl.city, wl.state, wl.zip_code, wl.primary_location ' +
    'from employer_organization eo ' +
    'join emp_work_location wl on wl.employer_organization_id = eo.id ' +
    `where replace(coalesce(eo.fein,''),'-','') in (${sqlList([...codeByFein.keys()])}) ` +
    'and eo.deleted=0 and wl.deleted=0 ' +
    'order by eo.company_name, wl.primary_location desc, wl.work_location_name';

  const { rows, queryIds, tookMs } = await prodQuery(sql, { ...ctx.creds, size: 2000 });
  log.push(`prod returned ${rows.length} work location rows in ${tookMs}ms`);

  const seen = new Set<string>();
  const out = [];
  for (const r of rows) {
    const code = codeByFein.get(String(r.fein_norm));
    if (!code) continue;            // a prod employer we do not track
    seen.add(String(r.fein_norm));
    out.push({
      dsp_short_code: code,
      work_location_name: r.work_location_name,
      address_line1: r.address_line1,
      address_line2: r.address_line2,
      city: r.city,
      state: r.state,
      zip_code: r.zip_code,
      is_primary: Boolean(r.primary_location),
    });
  }

  const noLocations = [...codeByFein.entries()]
    .filter(([fein]) => !seen.has(fein)).map(([, code]) => code);
  if (noLocations.length) {
    log.push(`${noLocations.length} DSP(s) have a fein but no work locations in prod: ` +
             noLocations.slice(0, 20).join(', ') + (noLocations.length > 20 ? ' ...' : ''));
  }

  if (ctx.dryRun) {
    log.push(`DRY RUN - would replace client_work_locations with ${out.length} row(s)`);
    return { job: 'work_locations', ok: true, log, queryIds };
  }

  // Refuse to empty the table on an empty read. A prod query that returns
  // nothing is far more likely to be a changed schema or a bad fein list than
  // 58 clients genuinely losing every work location on the same day.
  if (!out.length) {
    throw new Error('prod returned no matching work locations - refusing to ' +
                    'delete the existing table on an empty result');
  }

  // No transaction available, so prod is fully read before anything is
  // deleted -- see the file header.
  await dash(ctx, 'DELETE', 'client_work_locations?dsp_short_code=not.is.null');
  await dashInsertChunked(ctx, 'client_work_locations', out);
  log.push(`replaced client_work_locations with ${out.length} row(s)`);

  return { job: 'work_locations', ok: true, log, queryIds };
}

/* ------------------------------------------------- fein backfill (Step 1) - */

// Legal suffixes dropped before matching, so "Lazo Logistics LLC" and
// "LAZO LOGISTICS, L.L.C." land on the same key.
const FEIN_SUFFIXES = /\b(LLC|L L C|INC|CORP|CORPORATION|CO|LTD|LP)\.?\b/g;

function feinNormalizeName(name: unknown): string {
  return String(name ?? '').toUpperCase()
    .replace(/[.,]/g, ' ')
    .replace(FEIN_SUFFIXES, ' ')
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Port of scripts/backfill_fein.py.
 *
 * Matches client_overview rows that have no fein against prod's DSP-tagged
 * employers, on the normalised company name. Exactly one candidate is a match;
 * several is ambiguous and is reported rather than guessed, because picking
 * the wrong employer silently attaches a client to someone else's data.
 *
 * This is the job that shrinks feinNames.ts: five clients are pinned there
 * only because they have no fein here.
 */
async function backfillFein(ctx: JobCtx): Promise<JobResult> {
  const log: string[] = [];

  const targets = await dashSelect(
    ctx, 'client_overview', 'select=dsp_short_code,dsp_name&fein=is.null');
  log.push(`${targets.length} client(s) in client_overview have no fein`);
  if (!targets.length) {
    return { job: 'backfill_fein', ok: true, log, queryIds: [] };
  }

  const sql =
    'select company_name, company_identifier, ' +
    "replace(coalesce(fein,''),'-','') as fein_norm, live_status " +
    'from employer_organization ' +
    "where deleted=0 and company_identifier like 'DSP%' " +
    'order by company_name';
  const { rows, queryIds, tookMs } = await prodQuery(sql, { ...ctx.creds, size: 2000 });
  log.push(`prod returned ${rows.length} DSP-tagged employers in ${tookMs}ms`);

  const byName = new Map<string, Record<string, unknown>[]>();
  for (const r of rows) {
    const k = feinNormalizeName(r.company_name);
    if (!k) continue;
    (byName.get(k) ?? byName.set(k, []).get(k)!).push(r);
  }

  // A fein already on another row would violate the UNIQUE on client_overview
  // .fein. Python let the whole transaction fail; naming the collision is more
  // use than a 409 nobody can place.
  const taken = new Set<string>();
  for (const r of await dashSelect(ctx, 'client_overview',
                                   'select=fein&fein=not.is.null')) {
    taken.add(String(r.fein));
  }

  const matched: { code: string; fein: string; name: string }[] = [];
  const ambiguous: string[] = [], unmatched: string[] = [], collisions: string[] = [];

  for (const t of targets) {
    const code = String(t.dsp_short_code);
    const cands = byName.get(feinNormalizeName(t.dsp_name)) ?? [];
    if (cands.length > 1) {
      ambiguous.push(`${code} / ${t.dsp_name} -> ` +
        cands.map((c) => `${c.company_name} (${c.fein_norm})`).join(' | '));
      continue;
    }
    if (!cands.length) { unmatched.push(`${code}: ${t.dsp_name}`); continue; }
    const fein = String(cands[0].fein_norm || '');
    if (!fein) { unmatched.push(`${code}: ${t.dsp_name} (prod employer has no fein)`); continue; }
    if (taken.has(fein)) {
      collisions.push(`${code} / ${t.dsp_name} -> ${fein}, already on another client`);
      continue;
    }
    taken.add(fein);
    matched.push({ code, fein, name: String(t.dsp_name) });
  }

  log.push(`matched ${matched.length} | ambiguous ${ambiguous.length} | ` +
           `unmatched ${unmatched.length} | collisions ${collisions.length}`);
  matched.forEach((m) => log.push(`  + ${m.code} ${m.fein}  ${m.name}`));
  ambiguous.forEach((a) => log.push(`  ? ${a}`));
  collisions.forEach((c) => log.push(`  ! ${c}`));
  unmatched.slice(0, 20).forEach((u) => log.push(`  - ${u}`));
  if (unmatched.length > 20) log.push(`  - ... and ${unmatched.length - 20} more`);

  if (ctx.dryRun) {
    log.push(`DRY RUN - ${matched.length} fein(s) would be set, nothing written.`);
    return { job: 'backfill_fein', ok: true, log, queryIds };
  }
  // One PATCH per row: this sets a single column on a handful of rows, and an
  // upsert would have to resend every NOT NULL column to do it.
  for (const m of matched) {
    await dash(ctx, 'PATCH',
      `client_overview?dsp_short_code=eq.${encodeURIComponent(m.code)}`,
      { fein: m.fein, updated_at: new Date().toISOString() });
  }
  log.push(`set fein on ${matched.length} client(s)`);

  return { job: 'backfill_fein', ok: true, log, queryIds };
}

/* ---------------------------------------------- document counts (Step 1) -- */

const AMAZON_EXCHANGE = 'EX-20243277-1b50-4035-821d-d0fcd9b895a9';

/**
 * Port of scripts/populate_document_counts.py.
 *
 * Counts the employee documents actually in Uzio, rather than trusting the
 * transfer-completion mails -- several of those say "completed successfully"
 * with no count at all, one reported Success=0 and corrected itself minutes
 * later, and none can say what is in the system NOW rather than what was
 * uploaded that day.
 *
 * Employee documents are rows in `form` with category = 'EMPLOYEE_DOC', joined
 * on form.user_organization_id = employee.employee_code (a varchar UUID, not
 * the numeric employee.id). Not employee_document, which is empty across all
 * of prod. See .claude/docs/prod-table-lookup-gotchas.md.
 *
 * The two queries stay separate on purpose: joining headcount into the
 * document count would multiply one by the other, and an inner join would drop
 * every client with no documents yet -- exactly the ones worth seeing.
 */
async function documentCounts(ctx: JobCtx): Promise<JobResult> {
  const log: string[] = [];
  const ex = AMAZON_EXCHANGE;

  const docsSql =
    "select replace(coalesce(eo.fein,''),'-','') as fein_norm, eo.company_name, " +
    'count(*) as documents, ' +
    'count(distinct f.user_organization_id) as employees_with_docs ' +
    'from employer_organization eo ' +
    'join employee e on e.employer_organization_id = eo.id and e.deleted = 0 ' +
    'join form f on f.user_organization_id = e.employee_code ' +
    "           and f.category = 'EMPLOYEE_DOC' and f.deleted = 0 " +
    `where eo.exchange_id = '${ex}' and eo.deleted = 0 ` +
    'group by 1, 2 order by 1';

  const staffSql =
    "select replace(coalesce(eo.fein,''),'-','') as fein_norm, eo.company_name, " +
    'count(*) as total_employees, ' +
    'count(*) filter (where e.date_of_termination is null) as active_employees ' +
    'from employer_organization eo ' +
    'join employee e on e.employer_organization_id = eo.id and e.deleted = 0 ' +
    `where eo.exchange_id = '${ex}' and eo.deleted = 0 ` +
    'group by 1, 2 order by 1';

  const d = await prodQuery(docsSql, { ...ctx.creds, size: 2000 });
  const s = await prodQuery(staffSql, { ...ctx.creds, size: 2000 });
  const queryIds = [...d.queryIds, ...s.queryIds];

  const docs = new Map<string, Record<string, unknown>>();
  for (const r of d.rows) if (r.fein_norm) docs.set(String(r.fein_norm), r);
  const staff = new Map<string, Record<string, unknown>>();
  for (const r of s.rows) if (r.fein_norm) staff.set(String(r.fein_norm), r);
  log.push(`prod: ${staff.size} employers on the Amazon exchange, ` +
           `${docs.size} of them with documents`);

  const codeByFein = new Map<string, string>();
  for (const r of await dashSelect(ctx, 'client_overview',
                                   'select=dsp_short_code,fein&fein=not.is.null')) {
    codeByFein.set(String(r.fein).replace(/-/g, ''), String(r.dsp_short_code));
  }

  const send = [], unmatched: string[] = [];
  for (const [fein, st] of staff) {
    const code = codeByFein.get(fein);
    if (!code) {
      const n = Number((docs.get(fein) ?? {}).documents ?? 0);
      unmatched.push(`${fein} ${String(st.company_name).slice(0, 44)} (${n} docs)`);
      continue;
    }
    const dd = docs.get(fein) ?? {};
    send.push({
      dsp_short_code: code, fein, company_name: st.company_name,
      documents: Number(dd.documents ?? 0),
      employees_with_docs: Number(dd.employees_with_docs ?? 0),
      total_employees: Number(st.total_employees ?? 0),
      active_employees: Number(st.active_employees ?? 0),
      checked_at: new Date().toISOString(),
    });
  }

  log.push(`${send.length} client(s) matched to a DSP row`);
  if (unmatched.length) {
    log.push(`${unmatched.length} prod employer(s) with no matching DSP row ` +
             `(no fein on the tracker side, or a test employer): ` +
             unmatched.slice(0, 12).join(', '));
  }

  if (ctx.dryRun) {
    log.push(`DRY RUN - ${send.length} row(s) would be upserted, nothing sent.`);
    return { job: 'document_counts', ok: true, log, queryIds };
  }
  if (!send.length) {
    throw new Error('no document counts built - refusing to write nothing');
  }
  // A count is a snapshot, not a verdict: the upload API runs for hours, so a
  // client can legitimately be half-loaded. checked_at is what makes the
  // number readable, and employees_with_docs next to the total is what shows a
  // run that stopped early.
  for (let i = 0; i < send.length; i += 200) {
    await dash(ctx, 'POST', 'client_document_counts?on_conflict=dsp_short_code',
               send.slice(i, i + 200), 'resolution=merge-duplicates');
  }
  log.push(`upserted ${send.length} row(s) into client_document_counts`);

  return { job: 'document_counts', ok: true, log, queryIds };
}

/* ---------------------------------------------- API activity (Step 4b) ---- */

/**
 * The onboarding modules the dashboard shows, in display order.
 *
 * SocCode, CompanyJobTitle and W2DeliveryMethod are deliberately absent:
 * nobody runs those APIs (the latter two have zero runs on record, SocCode
 * six), so including them made every client read as having a gap.
 */
const API_MODULES = [
  'EmployeeCensus', 'PriorPayroll', 'PaymentMethodSetup', 'FedTaxWithholding',
  'StateTaxWithholding', 'EmployeeDeductions', 'WorkerCompensation',
  'EmployeeContributions',
];

const API_SQL =
  'select fein, vendor, created_by, created_date, error_messages, ' +
  'optional_validations, response_body ' +
  'from onboarding_automation_history order by id';

function parseJsonObject(raw: unknown): Record<string, unknown> | null {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  try {
    const o = JSON.parse(s);
    return o && typeof o === 'object' && !Array.isArray(o)
      ? o as Record<string, unknown> : null;
  } catch { return null; }
}

/** Which modules a run touched: the top-level keys of its two JSON blobs. */
function runSections(row: Record<string, unknown>): string[] {
  const out = new Set<string>();
  for (const col of ['error_messages', 'optional_validations']) {
    const o = parseJsonObject(row[col]);
    if (o) for (const k of Object.keys(o)) out.add(k);
  }
  return [...out];
}

/**
 * Per-module (total, success, failed) from response_body.
 *
 * A run with no response_body crashed or never finished. That is NOT the same
 * as "0 succeeded", and the two must not collapse: the first is `no_result`,
 * the second is a real failure someone has to act on.
 */
function runCounts(row: Record<string, unknown>): Record<string, [number, number, number]> {
  const body = parseJsonObject(row.response_body);
  if (!body) return {};
  const tm = (body.TotalMap ?? {}) as Record<string, unknown>;
  const sm = (body.SuccessMap ?? {}) as Record<string, unknown>;
  const fm = (body.FailureMap ?? {}) as Record<string, unknown>;
  const out: Record<string, [number, number, number]> = {};
  for (const k of Object.keys(tm)) {
    out[k] = [Number(tm[k] ?? 0) || 0, Number(sm[k] ?? 0) || 0, Number(fm[k] ?? 0) || 0];
  }
  return out;
}

interface Cell {
  created: string;            // full ISO, for comparing runs
  day: string;                // yyyy-mm-dd, what the dashboard shows
  who: string;
  last: [number, number, number] | null;
  ok: { day: string; who: string; total: number; success: number } | null;
}

/**
 * Port of rebuild_matrix_from_prod.py + load_api_activity.py, minus the two
 * TSV files they passed between them. Those existed because the data used to
 * come from a CSV export someone downloaded by hand; going straight from prod
 * to Supabase removes a whole class of "the file on disk is stale" problem.
 *
 * THE CLIENT LIST IS THE UNION OF client_overview AND feinNames.ts.
 *   load_api_activity iterates a hardcoded 61-fein map, so a client with real
 *   runs that nobody had added was silently dropped -- gen_matrix's own
 *   comments record that happening three times (Express Package System, BTK
 *   Rush, Banda), and 844786770 (Your Express Solutions) is the fourth,
 *   invisible for as long as it has had runs.
 *
 *   Replacing the map with client_overview outright looked like the fix and
 *   is not: five of its clients have no fein in client_overview, and dropping
 *   them would have been the same bug pointing the other way. feinNames.ts
 *   explains which five. So: union, client_overview for growth, the map as a
 *   floor that only shrinks.
 */
async function apiActivity(ctx: JobCtx): Promise<JobResult> {
  const log: string[] = [];
  if (!ctx.onboarding) {
    throw new Error('ONBOARDING_USERNAME / ONBOARDING_PASSWORD / ONBOARDING_FEIN ' +
                    'are not set on this function');
  }

  const overview = await dashSelect(
    ctx, 'client_overview', 'select=fein,dsp_name&fein=not.is.null');
  const nameByFein = new Map<string, string>();
  for (const r of overview) nameByFein.set(String(r.fein), String(r.dsp_name));
  const fromOverview = nameByFein.size;
  // The floor goes in second and wins on name: these were cleaned by hand,
  // where the sheet still carries prod's all-caps spelling.
  let onlyInMap = 0;
  for (const [fein, name] of Object.entries(FEIN_NAME)) {
    if (!nameByFein.has(fein)) onlyInMap++;
    nameByFein.set(fein, name);
  }
  log.push(`${nameByFein.size} clients: ${fromOverview} from client_overview, ` +
           `${onlyInMap} only in feinNames.ts (they have no fein in client_overview)`);

  const { rows, queryIds, tookMs } = await onboardingQuery(API_SQL, ctx.onboarding);
  log.push(`prod returned ${rows.length} onboarding runs in ${tookMs}ms`);

  const cells = new Map<string, Cell>();            // "fein|module"
  const vendorVotes = new Map<string, Map<string, number>>();
  const unknownFeins = new Map<string, number>();

  for (const row of rows) {
    const fein = String(row.fein ?? '').trim();
    const created = String(row.created_date ?? '').trim();
    if (!fein || !created) continue;

    if (!nameByFein.has(fein)) {
      // Sandbox employers, and anything genuinely new. Counted and reported
      // rather than dropped in silence -- that silence is the bug above.
      unknownFeins.set(fein, (unknownFeins.get(fein) ?? 0) + 1);
      continue;
    }

    const vendor = String(row.vendor ?? '').trim().toUpperCase();
    if (vendor) {
      const v = vendorVotes.get(fein) ?? new Map<string, number>();
      v.set(vendor, (v.get(vendor) ?? 0) + 1);
      vendorVotes.set(fein, v);
    }

    // Prod hands back ISO-8601; the old CSV used a space. Splitting on both
    // keeps the day the same 10 characters whichever path the data took.
    const day = created.replace('T', ' ').split(' ')[0];
    const who = String(row.created_by ?? '').trim().split('@')[0];
    const counts = runCounts(row);

    for (const sec of runSections(row)) {
      const key = `${fein}|${sec}`;
      const c = cells.get(key) ?? { created: '', day: '', who: '', last: null, ok: null };
      // String compare is safe: these are ISO-8601 from the same column.
      if (!c.created || created > c.created) {
        c.created = created; c.day = day; c.who = who;
      }
      const n = counts[sec];
      if (!c.last || created >= c.created) c.last = n ?? null;
      if (n && n[1] > 0 && (!c.ok || day >= c.ok.day)) {
        c.ok = { day, who, total: n[0], success: n[1] };
      }
      cells.set(key, c);
    }
  }

  const send = [];
  for (const [fein, name] of nameByFein) {
    const votes = vendorVotes.get(fein);
    let vendor = 'ADP';   // the historical default when prod never said
    if (votes) {
      let best = '', n = -1;
      for (const [v, c] of votes) if (c > n) { best = v; n = c; }
      vendor = best === 'ADP' ? 'ADP' : 'Paycom';
    }
    for (const mod of API_MODULES) {
      const c = cells.get(`${fein}|${mod}`);
      if (!c) continue;        // this client never ran this module
      send.push({
        fein, client_name: name, vendor, module_key: mod,
        last_run_date: c.day,
        run_by: c.who || null,
        run_status: !c.last ? 'no_result'
                  : c.last[1] > 0 ? 'ok'
                  : c.ok ? 'last_failed' : 'never_ok',
        last_total: c.last ? c.last[0] : null,
        last_success: c.last ? c.last[1] : null,
        last_failed: c.last ? c.last[2] : null,
        last_ok_date: c.ok ? c.ok.day : null,
        last_ok_by: c.ok ? c.ok.who : null,
        last_ok_total: c.ok ? c.ok.total : null,
        last_ok_success: c.ok ? c.ok.success : null,
      });
    }
  }

  const byStatus: Record<string, number> = {};
  send.forEach((r) => { byStatus[r.run_status] = (byStatus[r.run_status] ?? 0) + 1; });
  log.push(`${send.length} rows across ${new Set(send.map((r) => r.fein)).size} clients  ` +
           Object.entries(byStatus).map(([k, v]) => `${k} ${v}`).join(' | '));

  if (unknownFeins.size) {
    const list = [...unknownFeins.entries()]
      .sort((a, b) => b[1] - a[1]).map(([f, n]) => `${f} (${n})`);
    log.push(`${unknownFeins.size} fein(s) have runs but are not in client_overview ` +
             `- sandbox employers, unless one of these is a real client: ` +
             list.slice(0, 20).join(', '));
  }

  if (ctx.dryRun) {
    log.push(`DRY RUN - ${send.length} row(s) would be upserted, nothing sent.`);
    return { job: 'api_activity', ok: true, log, queryIds };
  }
  if (!send.length) {
    throw new Error('no API activity rows built - refusing to write nothing');
  }

  // Upsert, not replace: api_activity_runs carries a unique (fein, module_key)
  // and a row only ever moves forward. Nothing here deletes.
  for (let i = 0; i < send.length; i += 200) {
    await dash(ctx, 'POST', 'api_activity_runs?on_conflict=fein,module_key',
               send.slice(i, i + 200), 'resolution=merge-duplicates');
  }
  log.push(`upserted ${send.length} row(s) into api_activity_runs`);

  return { job: 'api_activity', ok: true, log, queryIds };
}

/* ------------------------------------------------------------- the registry */

export const JOBS: Record<string, (ctx: JobCtx) => Promise<JobResult>> = {
  // backfill_fein runs first: everything keyed on fein below is only as
  // complete as client_overview.fein is at the moment it reads.
  backfill_fein: backfillFein,
  work_locations: workLocations,
  document_counts: documentCounts,
  api_activity: apiActivity,
};
