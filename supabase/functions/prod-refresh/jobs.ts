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
  // The CRM's own Supabase, written by push_to_crm. Absent unless its
  // secrets are set.
  crm?: { url: string; key: string };
  dryRun: boolean;
  // task_evidence's flip cap for THIS call only (body.taskEvidenceCap). The
  // default 60 suits the daily steady state; the first run has months of
  // backlog and legitimately needs more.
  taskEvidenceCap?: number;
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

/**
 * Every row, not the first page. PostgREST caps a response at 1000 rows
 * (max-rows) and says nothing about it except in Content-Range, so a single
 * GET silently drops the rest: task_evidence never saw the CRM's tasks past
 * #1000 (1173 of them on 14 Oct 2026 - Banda's Document Transfer among the
 * missing). Pages need a stable order, so callers reading a table that can
 * pass 1000 rows put an `order=` in `query`.
 */
async function dashSelect(
  ctx: JobCtx,
  table: string,
  query: string,
): Promise<Record<string, unknown>[]> {
  const PAGE = 1000;
  const out: Record<string, unknown>[] = [];
  for (let from = 0; ; from += PAGE) {
    const res = await fetch(`${ctx.dashUrl}/rest/v1/${table}?${query}`, {
      headers: { 'apikey': ctx.dashKey, 'Authorization': `Bearer ${ctx.dashKey}`,
                 'Range-Unit': 'items', 'Range': `${from}-${from + PAGE - 1}`,
                 'Prefer': 'count=exact' },
    });
    if (!res.ok) {
      throw new Error(`GET ${table} -> HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const rows = await res.json() as Record<string, unknown>[];
    out.push(...rows);
    // "0-999/1173": keep going while the total is past what we hold.
    const total = Number((res.headers.get('Content-Range') ?? '').split('/')[1]);
    if (!rows.length || !Number.isFinite(total) || out.length >= total) return out;
    if (from > 200 * PAGE) throw new Error(`GET ${table} paged past 200k rows, refusing to continue`);
  }
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

/* ---------------------------------------------- data coverage (Step 1) ---- */

/**
 * Driving licence arrives through the ADP/Paycom census as a custom field, not
 * as a column on employee: searching the schema finds only the broker tables
 * and utt_cortex_driver, which has no employee_id and so cannot be tied back.
 * The census writes four keys; this is the one to count.
 */
const LICENCE_KEY = 'License Number';

/**
 * Port of scripts/populate_data_coverage.py.
 *
 * How many of each client's employees actually have a payment method, an
 * emergency contact, a licence and a worker-comp code -- the things a payroll
 * cannot run without.
 *
 * Two joins look risky and are not: employee_payment_method and
 * ups_employee_worker_compensation join on employee_code, which is a UUID in
 * prod and therefore globally unique, so neither can pull in another
 * employer's rows.
 *
 * The licence join carries its own blank check. A custom-field row can exist
 * with an empty value, so filtering in the WHERE would count every employee
 * who merely has the key present as having a licence.
 */
async function dataCoverage(ctx: JobCtx): Promise<JobResult> {
  const log: string[] = [];

  const codeByFein = new Map<string, string>();
  for (const r of await dashSelect(ctx, 'client_overview',
                                   'select=dsp_short_code,fein&fein=not.is.null')) {
    codeByFein.set(String(r.fein), String(r.dsp_short_code));
  }
  log.push(`${codeByFein.size} DSPs in client_overview carry a fein`);
  if (!codeByFein.size) {
    return { job: 'data_coverage', ok: true, log: [...log, 'nothing to do'], queryIds: [] };
  }
  const inlist = sqlList([...codeByFein.keys()]);

  const coverSql =
    "select replace(coalesce(eo.fein,''),'-','') as fein_norm, eo.company_name, " +
    'count(distinct e.id) as total_employees, ' +
    'count(distinct case when e.date_of_termination is null then e.id end) as active_employees, ' +
    'count(distinct case when pm.id is not null then e.id end) as total_with_payment, ' +
    'count(distinct case when ec.id is not null then e.id end) as total_with_emergency, ' +
    'count(distinct case when cf.id is not null then e.id end) as total_with_licence, ' +
    'count(distinct case when e.date_of_termination is null and pm.id is not null then e.id end) as active_with_payment, ' +
    'count(distinct case when e.date_of_termination is null and ec.id is not null then e.id end) as active_with_emergency, ' +
    'count(distinct case when e.date_of_termination is null and cf.id is not null then e.id end) as active_with_licence, ' +
    'count(distinct case when wc.id is not null then e.id end) as total_with_worker_comp, ' +
    'count(distinct case when e.date_of_termination is null and wc.id is not null then e.id end) as active_with_worker_comp ' +
    'from employer_organization eo ' +
    'join employee e on e.employer_organization_id = eo.id and e.deleted = 0 ' +
    'left join employee_payment_method pm on pm.employee_code = e.employee_code and pm.deleted = 0 ' +
    'left join emergency_contact ec on ec.employee_id = e.id and ec.deleted = 0 ' +
    'left join employee_custom_fields cf on cf.employee_id = e.id and cf.deleted = 0 ' +
    `  and cf.field_key = '${LICENCE_KEY}' and nullif(trim(cf.field_value), '') is not null ` +
    'left join ups_employee_worker_compensation wc on wc.employee_code = e.employee_code and wc.deleted = 0 ' +
    `where eo.deleted = 0 and replace(coalesce(eo.fein,''),'-','') in (${inlist}) ` +
    'group by 1, 2 order by 1';

  // Its own query, not another aggregate on the one above: a client can carry
  // several codes (Travel Management runs GA-4921 and AL-4921), so this is one
  // row per code, not per employer.
  const wcSql =
    "select replace(coalesce(eo.fein,''),'-','') as fein_norm, " +
    'wc.worker_comp_code, count(distinct e.id) as employees ' +
    'from employer_organization eo ' +
    'join employee e on e.employer_organization_id = eo.id and e.deleted = 0 ' +
    'join ups_employee_worker_compensation wc on wc.employee_code = e.employee_code and wc.deleted = 0 ' +
    'where eo.deleted = 0 and e.date_of_termination is null ' +
    `and replace(coalesce(eo.fein,''),'-','') in (${inlist}) ` +
    'group by 1, 2 order by 1, 3 desc';

  const cov = await prodQuery(coverSql, { ...ctx.creds, size: 2000 });
  const wc = await prodQuery(wcSql, { ...ctx.creds, size: 2000 });
  const queryIds = [...cov.queryIds, ...wc.queryIds];
  log.push(`prod returned ${cov.rows.length} employer aggregates, ` +
           `${wc.rows.length} worker-comp code rows`);

  const codesByFein = new Map<string, string[]>();
  for (const r of wc.rows) {
    const f = String(r.fein_norm);
    // Prod has an assignment with no code on it (ANEM, 1 employee). The
    // Python interpolated it straight in, so the dashboard has been showing
    // the literal string "None (1)" to people; this would have shown
    // "null (1)", which is the same bug in a different language. The row is
    // still worth seeing -- an employee IS assigned worker comp, nobody wrote
    // down which class -- so it is labelled rather than dropped.
    const raw = r.worker_comp_code;
    const code = (raw === null || raw === undefined || String(raw).trim() === '')
      ? '(no code)' : String(raw).trim();
    (codesByFein.get(f) ?? codesByFein.set(f, []).get(f)!)
      .push(`${code} (${r.employees})`);
  }

  const n = (v: unknown) => Number(v ?? 0) || 0;
  const send = [], gaps: string[] = [];
  for (const r of cov.rows) {
    const code = codeByFein.get(String(r.fein_norm));
    if (!code) continue;
    const active = n(r.active_employees);
    const codes = codesByFein.get(String(r.fein_norm));
    send.push({
      dsp_short_code: code, fein: r.fein_norm, company_name: r.company_name,
      total_employees: n(r.total_employees), active_employees: active,
      total_with_payment_method: n(r.total_with_payment),
      total_with_emergency_contact: n(r.total_with_emergency),
      total_with_licence: n(r.total_with_licence),
      active_with_payment_method: n(r.active_with_payment),
      active_with_emergency_contact: n(r.active_with_emergency),
      active_with_licence: n(r.active_with_licence),
      total_with_worker_comp: n(r.total_with_worker_comp),
      active_with_worker_comp: n(r.active_with_worker_comp),
      worker_comp_codes: codes && codes.length ? codes.join(' · ') : null,
      checked_date: new Date().toISOString().slice(0, 10),
    });
    // Staff on the books and nothing loaded for them is a real gap, not a
    // rounding error, so it is named rather than left to a percentage.
    const missing = [];
    if (active > 0 && n(r.active_with_payment) === 0) missing.push('payment');
    if (active > 0 && n(r.active_with_emergency) === 0) missing.push('emergency');
    if (active > 0 && n(r.active_with_licence) === 0) missing.push('licence');
    if (missing.length) gaps.push(`${code} (${active} active): no ${missing.join(', ')}`);
  }

  log.push(`${send.length} client(s) matched`);
  gaps.slice(0, 20).forEach((g) => log.push(`  ! ${g}`));
  if (gaps.length > 20) log.push(`  ! ... and ${gaps.length - 20} more`);

  if (ctx.dryRun) {
    log.push(`DRY RUN - ${send.length} row(s) would be upserted, nothing sent.`);
    return { job: 'data_coverage', ok: true, log, queryIds };
  }
  if (!send.length) throw new Error('no coverage rows built - refusing to write nothing');
  for (let i = 0; i < send.length; i += 200) {
    await dash(ctx, 'POST', 'client_data_coverage?on_conflict=dsp_short_code',
               send.slice(i, i + 200), 'resolution=merge-duplicates');
  }
  log.push(`upserted ${send.length} row(s) into client_data_coverage`);
  return { job: 'data_coverage', ok: true, log, queryIds };
}

/* ------------------------------------------------ load history (Step 1) --- */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-/i;

/**
 * employee.created_by is three different things, and the chart has to name a
 * person: an email for Uzio staff, the literal 'SYSTEM' for API writes, and a
 * UUID for client-side logins. The UUIDs are resolved through user_data; the
 * domain is stripped from staff emails so the label matches
 * api_activity_runs.run_by exactly.
 */
function classifyActor(actor: unknown, resolved: Map<string, string>): [string, string] {
  if (actor === null || actor === undefined || actor === '') return ['-', 'n/a'];
  if (typeof actor !== 'string') return [String(actor), 'other'];
  if (actor === 'SYSTEM') return ['SYSTEM', 'system'];
  if (actor.endsWith('@uzio.com')) return [actor.slice(0, -'@uzio.com'.length), 'staff'];
  if (UUID_RE.test(actor)) return [resolved.get(actor) ?? 'Client user', 'client'];
  return [actor, 'other'];
}

/**
 * Port of scripts/populate_load_history.py.
 *
 * api_activity_runs records one last_run_date per module, and that single date
 * hides the shape of a load: Stave's census log says 08 Aug, but 982 of its
 * 989 employees landed on 29 Jul and only 7 came on the 8th. Inferring the
 * "real" date from prod got to 69-76% agreement and no further -- the honest
 * fix is not a better guess, it is showing the whole history.
 *
 * Terminations are scoped to on-or-after the client's first load. Without
 * that, the census's imported history puts departures back to 2018 on the
 * chart -- 19,159 client-day pairs that predate Uzio ever holding the client,
 * against 1,609 real ones.
 */
async function loadHistory(ctx: JobCtx): Promise<JobResult> {
  const log: string[] = [];

  const codeByFein = new Map<string, string>();
  for (const r of await dashSelect(ctx, 'client_overview',
                                   'select=dsp_short_code,fein&fein=not.is.null')) {
    codeByFein.set(String(r.fein), String(r.dsp_short_code));
  }
  log.push(`${codeByFein.size} DSPs with a fein`);
  if (!codeByFein.size) {
    return { job: 'load_history', ok: true, log: [...log, 'nothing to do'], queryIds: [] };
  }
  const inlist = sqlList([...codeByFein.keys()]);
  const queryIds: string[] = [];

  const addedSql =
    "select replace(coalesce(eo.fein,''),'-','') as fein_norm, " +
    'cast(e.created_date as date) as event_date, e.created_by as actor, count(*) as employees ' +
    'from employer_organization eo ' +
    'join employee e on e.employer_organization_id = eo.id and e.deleted = 0 ' +
    'where eo.deleted = 0 and e.created_date is not null ' +
    `and replace(coalesce(eo.fein,''),'-','') in (${inlist}) ` +
    'group by 1,2,3 order by 1,2,3';

  const termSql =
    "select replace(coalesce(eo.fein,''),'-','') as fein_norm, " +
    'cast(e.date_of_termination as date) as event_date, count(*) as employees ' +
    'from employer_organization eo ' +
    'join employee e on e.employer_organization_id = eo.id and e.deleted = 0 ' +
    'join (select employer_organization_id as oid, min(cast(created_date as date)) as first_load ' +
    '      from employee where deleted = 0 group by 1) f on f.oid = eo.id ' +
    'where eo.deleted = 0 and e.date_of_termination is not null ' +
    'and e.date_of_termination >= f.first_load ' +
    `and replace(coalesce(eo.fein,''),'-','') in (${inlist}) ` +
    'group by 1,2 order by 1,2';

  const all: { fein: string; day: string; kind: string; actor: unknown; n: number }[] = [];
  for (const [kind, sql] of [['added', addedSql], ['terminated', termSql]] as const) {
    const q = await prodQuery(sql, { ...ctx.creds, size: 5000 });
    queryIds.push(...q.queryIds);
    log.push(`  ${kind}: ${q.rows.length} rows from prod`);
    for (const r of q.rows) {
      all.push({ fein: String(r.fein_norm), day: String(r.event_date).slice(0, 10),
                 kind, actor: r.actor ?? null, n: Number(r.employees ?? 0) || 0 });
    }
  }

  // Resolve client-side UUIDs to usernames, chunked because the identifiers
  // go into an IN clause.
  const uuids = [...new Set(all.map((r) => r.actor)
    .filter((a): a is string => typeof a === 'string' && UUID_RE.test(a)))].sort();
  const resolved = new Map<string, string>();
  for (let i = 0; i < uuids.length; i += 200) {
    const q = await prodQuery(
      'select user_identifier, username from user_data where user_identifier in (' +
      sqlList(uuids.slice(i, i + 200)) + ') order by user_identifier',
      { ...ctx.creds, size: 2000 });
    queryIds.push(...q.queryIds);
    for (const r of q.rows) resolved.set(String(r.user_identifier), String(r.username));
  }
  log.push(`resolved ${resolved.size} of ${uuids.length} client-side UUIDs to usernames`);

  // Two raw actors can normalise to one label (two unresolved UUIDs both
  // become "Client user"), so sum rather than let the primary key reject the
  // second row.
  const merged = new Map<string, { row: Record<string, unknown>; n: number }>();
  for (const r of all) {
    const code = codeByFein.get(r.fein);
    if (!code) continue;
    const [actor, actorType] = classifyActor(r.actor, resolved);
    const k = `${code}|${r.day}|${r.kind}|${actor}`;
    const hit = merged.get(k);
    if (hit) { hit.n += r.n; continue; }
    merged.set(k, { n: r.n, row: { dsp_short_code: code, event_date: r.day,
                                   kind: r.kind, actor, actor_type: actorType } });
  }
  const send = [...merged.values()].map((m) => ({ ...m.row, employees: m.n }));
  const codes = [...new Set(send.map((r) => String(r.dsp_short_code)))];
  log.push(`${send.length} event row(s) across ${codes.length} client(s)`);

  if (ctx.dryRun) {
    log.push(`DRY RUN - ${send.length} row(s) would replace the slice for ` +
             `${codes.length} client(s), nothing sent.`);
    return { job: 'load_history', ok: true, log, queryIds };
  }
  if (!send.length) throw new Error('no load events built - refusing to delete the table');

  // Fully derived, so each client's slice is rebuilt rather than merged -- a
  // stale event row would otherwise survive forever. Prod is read in full
  // before anything is deleted, so a failed read leaves the table alone.
  for (let i = 0; i < codes.length; i += 100) {
    await dash(ctx, 'DELETE',
      'client_load_events?dsp_short_code=in.(' +
      codes.slice(i, i + 100).map((c) => `"${c}"`).join(',') + ')');
  }
  for (let i = 0; i < send.length; i += 500) {
    await dash(ctx, 'POST', 'client_load_events', send.slice(i, i + 500));
  }
  log.push(`replaced ${send.length} row(s) in client_load_events`);
  return { job: 'load_history', ok: true, log, queryIds };
}

/* --------------------------------------------- system activity (Step 1) --- */

/** Prod hands back timestamps; these columns are dates. */
const day10 = (v: unknown) => (v === null || v === undefined || v === '')
  ? null : String(v).slice(0, 10);

/**
 * Port of scripts/populate_system_activity.py.
 *
 * Whether each client is actually USING time tracking and payroll, as opposed
 * to having been set up for them. Four queries rather than one join, because
 * they aggregate over different grains and joining them would multiply.
 *
 * Two distinctions the columns exist to keep:
 *   IMPORT/SYSTEM attendance rows are migrated history, not someone punching a
 *   clock, so tt_first_live_date excludes them while tt_first_entry_date does
 *   not. PRIOR paychecks are migration loads of the old vendor's payrolls;
 *   only NORMAL means the client is running payroll on Uzio.
 */
async function systemActivity(ctx: JobCtx): Promise<JobResult> {
  const log: string[] = [];

  const codeByFein = new Map<string, string>();
  for (const r of await dashSelect(ctx, 'client_overview',
                                   'select=dsp_short_code,fein&fein=not.is.null')) {
    codeByFein.set(String(r.fein), String(r.dsp_short_code));
  }
  log.push(`${codeByFein.size} DSPs with a known fein`);
  if (!codeByFein.size) {
    return { job: 'system_activity', ok: true, log: [...log, 'nothing to do'], queryIds: [] };
  }
  const inlist = sqlList([...codeByFein.keys()]);
  const queryIds: string[] = [];

  const ttSql =
    "select replace(coalesce(eo.fein,''),'-','') as fein_norm, " +
    "min(case when a.source not in ('IMPORT','SYSTEM') then a.day end) as first_live, " +
    'min(a.day) as first_any, max(a.day) as last_any, ' +
    "count(distinct case when a.source not in ('IMPORT','SYSTEM') then a.employee_code end) as emps_punched, " +
    "count(case when a.source not in ('IMPORT','SYSTEM') then 1 end) as live_entries, " +
    "count(case when a.source in ('IMPORT','SYSTEM') then 1 end) as imported_entries " +
    'from employer_organization eo ' +
    'join utt_employee_attendance a on a.ein = eo.ein and a.deleted = 0 and coalesce(a.discarded, 0) = 0 ' +
    `where eo.deleted = 0 and replace(coalesce(eo.fein,''),'-','') in (${inlist}) ` +
    'group by 1 order by 1';

  // utt_employee has no employer column, so enrollment goes through
  // employee.employee_code.
  const setupSql =
    "select replace(coalesce(eo.fein,''),'-','') as fein_norm, eo.company_name, " +
    'max(coalesce(s.is_completed, 0)) as setup_completed, ' +
    'count(distinct ue.employee_code) as enrolled ' +
    'from employer_organization eo ' +
    'left join utt_employer_setting s on s.employer_ein = eo.ein and s.deleted = 0 ' +
    'left join employee e on e.employer_organization_id = eo.id and e.deleted = 0 ' +
    'left join utt_employee ue on ue.employee_code = e.employee_code and ue.deleted = 0 ' +
    `where eo.deleted = 0 and replace(coalesce(eo.fein,''),'-','') in (${inlist}) ` +
    'group by 1, 2 order by 1';

  const payrollSql =
    "select replace(coalesce(d.fein,''),'-','') as fein_norm, " +
    "min(case when d.paycheck_type = 'NORMAL' then d.pay_date end) as first_normal, " +
    "max(case when d.paycheck_type = 'NORMAL' then d.pay_date end) as last_normal, " +
    "count(case when d.paycheck_type = 'NORMAL' then 1 end) as normal_runs, " +
    "count(case when d.paycheck_type = 'PRIOR' then 1 end) as prior_loads " +
    'from ups_employer_paycheck_detail d ' +
    "where d.deleted = 0 and d.status = 'APPROVED' and coalesce(d.payroll_status,'') <> 'VOIDED' " +
    `and replace(coalesce(d.fein,''),'-','') in (${inlist}) ` +
    'group by 1 order by 1';

  // A window function keeps the most-recent-run lookup to one SELECT, which
  // is all the NeuronOps guard allows.
  const lastRunSql =
    'select fein_norm, employee_count from (' +
    "  select replace(coalesce(d.fein,''),'-','') as fein_norm, d.employee_count, " +
    "  row_number() over (partition by replace(coalesce(d.fein,''),'-','') " +
    '    order by d.pay_date desc, d.id desc) as rn ' +
    '  from ups_employer_paycheck_detail d ' +
    "  where d.deleted = 0 and d.status = 'APPROVED' " +
    "  and coalesce(d.payroll_status,'') <> 'VOIDED' and d.paycheck_type = 'NORMAL' " +
    `  and replace(coalesce(d.fein,''),'-','') in (${inlist}) ` +
    ') t where rn = 1 order by fein_norm';

  const byFein = async (sql: string, size = 2000) => {
    const q = await prodQuery(sql, { ...ctx.creds, size });
    queryIds.push(...q.queryIds);
    const m = new Map<string, Record<string, unknown>>();
    for (const r of q.rows) m.set(String(r.fein_norm), r);
    return m;
  };

  const setup = await byFein(setupSql);
  const tt = await byFein(ttSql);
  const pr = await byFein(payrollSql);
  let lastEmp = new Map<string, Record<string, unknown>>();
  try {
    lastEmp = await byFein(lastRunSql);
  } catch (e) {
    // The only non-flat SELECT here. If the guard ever rejects it, the rest of
    // the refresh still lands and the column goes null rather than stale.
    log.push(`last-run employee-count query rejected (${(e as Error).message.slice(0, 80)}) ` +
             '- leaving that column null');
  }
  log.push(`prod rows: setup=${setup.size} tt=${tt.size} payroll=${pr.size} ` +
           `last-run=${lastEmp.size}`);

  const n = (v: unknown) => Number(v ?? 0) || 0;
  const send = [];
  for (const [fein, code] of codeByFein) {
    const s = setup.get(fein), t = tt.get(fein), p = pr.get(fein);
    if (!s && !t && !p) continue;        // nothing to say about this client
    const le = lastEmp.get(fein);
    send.push({
      dsp_short_code: code, fein, company_name: s ? s.company_name : null,
      // is_completed is a smallint in prod, not a boolean.
      tt_setup_completed: Boolean(s && n(s.setup_completed)),
      tt_enrolled_employees: s ? n(s.enrolled) : 0,
      tt_first_live_date: t ? day10(t.first_live) : null,
      tt_first_entry_date: t ? day10(t.first_any) : null,
      tt_last_entry_date: t ? day10(t.last_any) : null,
      tt_employees_punched: t ? n(t.emps_punched) : 0,
      tt_live_entries: t ? n(t.live_entries) : 0,
      tt_imported_entries: t ? n(t.imported_entries) : 0,
      pr_first_normal_date: p ? day10(p.first_normal) : null,
      pr_last_normal_date: p ? day10(p.last_normal) : null,
      pr_normal_runs: p ? n(p.normal_runs) : 0,
      pr_last_run_employees: le ? n(le.employee_count) : null,
      pr_prior_loads: p ? n(p.prior_loads) : 0,
      checked_date: new Date().toISOString().slice(0, 10),
    });
  }

  const ttLive = send.filter((r) => r.tt_first_live_date).length;
  const prLive = send.filter((r) => r.pr_first_normal_date).length;
  log.push(`${send.length} client(s): ${ttLive} live on time tracking, ` +
           `${prLive} running payroll on Uzio`);

  if (ctx.dryRun) {
    log.push(`DRY RUN - ${send.length} row(s) would be upserted, nothing sent.`);
    return { job: 'system_activity', ok: true, log, queryIds };
  }
  if (!send.length) throw new Error('no system activity rows built - refusing to write nothing');
  for (let i = 0; i < send.length; i += 200) {
    await dash(ctx, 'POST', 'client_system_activity?on_conflict=dsp_short_code',
               send.slice(i, i + 200), 'resolution=merge-duplicates');
  }
  log.push(`upserted ${send.length} row(s) into client_system_activity`);
  return { job: 'system_activity', ok: true, log, queryIds };
}

/* ---------------------------------------------- payroll health ----------- */

const DAY_MS = 86400000;
const toMs = (iso: string) => Date.parse(iso.slice(0, 10) + 'T00:00:00Z');
const fromMs = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const addDays = (iso: string, n: number) => fromMs(toMs(iso) + n * DAY_MS);
const spanDays = (a: string, b: string) => Math.round((toMs(b) - toMs(a)) / DAY_MS) + 1;

/** Overlapping or day-adjacent ranges collapsed into one. */
function mergeRanges(ivs: [string, string][]): [string, string][] {
  const out: [string, string][] = [];
  const sorted = [...ivs].sort((x, y) => x[0] < y[0] ? -1 : x[0] > y[0] ? 1
                                       : x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0);
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    // + one day, so 31 Jan..1 Feb counts as continuous rather than a gap of
    // nothing.
    if (last && toMs(s) <= toMs(last[1]) + DAY_MS) {
      if (toMs(e) > toMs(last[1])) last[1] = e;
    } else {
      out.push([s, e]);
    }
  }
  return out;
}

/** The stretches of [lo, hi] that `covered` does not touch. */
function findGaps(covered: [string, string][], lo: string, hi: string): [string, string][] {
  const res: [string, string][] = [];
  let cur = lo;
  for (const [s, e] of covered) {
    if (toMs(e) < toMs(lo) || toMs(s) > toMs(hi)) continue;
    if (toMs(s) > toMs(cur)) {
      const end = addDays(s, -1);
      res.push([cur, toMs(end) < toMs(hi) ? end : hi]);
    }
    const next = addDays(e, 1);
    if (toMs(next) > toMs(cur)) cur = next;
    if (toMs(cur) > toMs(hi)) break;
  }
  if (toMs(cur) <= toMs(hi)) res.push([cur, hi]);
  return res;
}

/**
 * Port of scripts/populate_payroll_health.py.
 *
 * Does every pay period that has already run have payroll behind it in Uzio,
 * and where does the handover from the old vendor sit.
 *
 * INTERVALS, NOT COUNTS. Prior payroll does not arrive one row per pay period:
 * Lazo's whole pre-go-live year came as four consolidated rows, one spanning
 * 2025-12-14 to 2026-03-21. Counting rows against the weekly calendar invents
 * gaps — the first version of this check reported 23 missing periods for a
 * client that was fully covered. Coverage is the union of the ranges the rows
 * span, and a gap is a stretch of days none of them touch.
 *
 * The handover is where PRIOR ends and NORMAL begins. A gap there is a week
 * neither system owns, invisible from either side alone — it is how North Star
 * and Spelman each lost one.
 */
async function payrollHealth(ctx: JobCtx): Promise<JobResult> {
  const log: string[] = [];
  const YEAR_START = '2026-01-01';

  const clients = new Map<string, { code: string; name: string; prev: string }>();
  for (const r of await dashSelect(
      ctx, 'client_overview',
      'select=dsp_short_code,fein,dsp_name,previous_system&fein=not.is.null')) {
    clients.set(String(r.fein), { code: String(r.dsp_short_code),
      name: String(r.dsp_name), prev: String(r.previous_system ?? '') });
  }
  log.push(`${clients.size} DSPs with a fein`);
  if (!clients.size) {
    return { job: 'payroll_health', ok: true, log: [...log, 'nothing to do'], queryIds: [] };
  }
  const inlist = sqlList([...clients.keys()]);

  // The last period whose payroll date has already passed: the end of the
  // window anyone can fairly be held to.
  const calSql =
    "select replace(coalesce(eo.fein,''),'-','') as fein, " +
    'max(cast(pd.pay_period_end_date as date)) as last_end ' +
    'from employer_organization eo ' +
    'join employer_payroll_info epi on epi.employer_organization_id = eo.id ' +
    'join payroll_dates pd on pd.employer_payroll_info_id = epi.id and pd.deleted = 0 ' +
    'where eo.deleted = 0 and pd.payroll_date <= current_date ' +
    "and pd.pay_period_start_date >= '2025-01-01' " +
    `and replace(coalesce(eo.fein,''),'-','') in (${inlist}) group by 1 order by 1`;

  const rowsSql =
    "select replace(coalesce(fein,''),'-','') as fein, paycheck_type, " +
    'cast(payperiod_start_date as date) as s, cast(payperiod_end_date as date) as e ' +
    'from ups_employer_paycheck_detail ' +
    "where deleted = 0 and paycheck_type in ('PRIOR','NORMAL') " +
    "and payperiod_end_date >= '2025-11-01' and payperiod_start_date <= current_date " +
    `and replace(coalesce(fein,''),'-','') in (${inlist}) order by 1, 3, 4`;

  const calQ = await prodQuery(calSql, { ...ctx.creds, size: 5000 });
  const rowQ = await prodQuery(rowsSql, { ...ctx.creds, size: 5000 });
  const queryIds = [...calQ.queryIds, ...rowQ.queryIds];

  const cal = new Map<string, string>();
  for (const r of calQ.rows) cal.set(String(r.fein), String(r.last_end).slice(0, 10));
  const byFein = new Map<string, Record<string, [string, string][]>>();
  for (const r of rowQ.rows) {
    const f = String(r.fein);
    const d = byFein.get(f) ?? byFein.set(f, {}).get(f)!;
    (d[String(r.paycheck_type)] ??= []).push(
      [String(r.s).slice(0, 10), String(r.e).slice(0, 10)]);
  }
  log.push(`${rowQ.rows.length} payroll rows from prod, ${cal.size} clients with a calendar`);

  const send = [], problems: string[] = [];
  for (const [fein, c] of clients) {
    const hi = cal.get(fein);
    const d = byFein.get(fein);
    if (!hi || !d) continue;              // nothing has run yet, nothing to judge
    const prior = mergeRanges(d.PRIOR ?? []);
    const normal = mergeRanges(d.NORMAL ?? []);
    const g = findGaps(mergeRanges([...(d.PRIOR ?? []), ...(d.NORMAL ?? [])]), YEAR_START, hi);
    const gapDays = g.reduce((n, [s, e]) => n + spanDays(s, e), 0);
    const handover = Boolean(prior.length && normal.length &&
      toMs(normal[0][0]) > toMs(prior[prior.length - 1][1]) + DAY_MS);
    // A client new to the platform has no previous system to load payroll
    // from, so an empty pre-go-live stretch is correct rather than a gap.
    // Without this, 12 of the 21 flagged clients were false alarms.
    const isNew = c.prev.trim().toLowerCase() === 'new';
    const status = !g.length ? 'Covered' : isNew ? 'New to platform'
                 : handover ? 'Handover gap' : 'Gap';
    const ranges = g.map(([s, e]) => `${s}..${e}`).join('; ');

    send.push({
      dsp_short_code: c.code, fein, company_name: c.name,
      target_from: YEAR_START, target_to: hi,
      prior_from: prior.length ? prior[0][0] : null,
      prior_to: prior.length ? prior[prior.length - 1][1] : null,
      prior_rows: (d.PRIOR ?? []).length,
      normal_from: normal.length ? normal[0][0] : null,
      normal_to: normal.length ? normal[normal.length - 1][1] : null,
      normal_rows: (d.NORMAL ?? []).length,
      handover_gap: handover, gap_days: gapDays,
      gap_ranges: ranges || null,
      previous_system: c.prev || null, status,
      checked_date: new Date().toISOString().slice(0, 10),
    });
    if (g.length && !isNew) {
      problems.push(`${c.name} — ${status}, ${gapDays} day(s): ${ranges}`);
    }
  }

  log.push(`${send.length} client(s) judged, ${problems.length} with uncovered days`);
  problems.slice(0, 15).forEach((p) => log.push(`  ! ${p}`));
  if (problems.length > 15) log.push(`  ! ... and ${problems.length - 15} more`);

  if (ctx.dryRun) {
    log.push(`DRY RUN - ${send.length} row(s) would be upserted, nothing sent.`);
    return { job: 'payroll_health', ok: true, log, queryIds };
  }
  if (!send.length) throw new Error('no payroll health rows built - refusing to write nothing');
  for (let i = 0; i < send.length; i += 200) {
    await dash(ctx, 'POST', 'payroll_health?on_conflict=dsp_short_code',
               send.slice(i, i + 200), 'resolution=merge-duplicates');
  }
  log.push(`upserted ${send.length} row(s) into payroll_health`);
  return { job: 'payroll_health', ok: true, log, queryIds };
}

/* ------------------------------------------------- push to the CRM -------- */

// [ours, theirs, columns to strip]. client_overview lands as client_profile:
// 'overview' is our view's name, 'profile' is what it is to the Client 360
// page. The stripped columns are identities and keys that are ours, not
// theirs, and would collide on insert.
const CRM_DATA_VIEWS: [string, string, string[]][] = [
  ['api_activity_runs', 'api_activity_runs', ['id']],
  ['payroll_health', 'payroll_health', []],
  ['client_data_coverage', 'client_data_coverage', []],
  ['document_transfer', 'document_transfer', ['id', 'source_message_id']],
  ['client_document_counts', 'client_document_counts', []],
  ['client_overview', 'client_profile', []],
  ['client_system_activity', 'client_system_activity', []],
  ['client_work_locations', 'client_work_locations', ['id']],
];

/**
 * Copy our reporting tables into the CRM's.
 *
 * WHY A REFRESH BUTTON NEEDS THIS
 *   Every other job here writes OUR Supabase, and the CRM reads its OWN. Apps
 *   Script bridges the two at 17:30. So without this step a "Refresh" button
 *   on the CRM's Data page would run, succeed, and change nothing the person
 *   pressing it can see until the evening — which is worse than no button.
 *
 * A full replace per table is right here and nowhere else: these are
 * read-only reporting copies, nothing in the CRM writes to them, and there is
 * no per-row history on that side to lose. The historical tables are a
 * different matter — they carry file names and human notes — and are not in
 * this list.
 *
 * Run it LAST. It copies whatever is in our Supabase at that moment.
 */
async function pushToCrm(ctx: JobCtx): Promise<JobResult> {
  const log: string[] = [];
  if (!ctx.crm) {
    throw new Error('CRM_URL / CRM_SERVICE_KEY are not set on this function');
  }
  const crm = { dashUrl: ctx.crm.url, dashKey: ctx.crm.key, creds: ctx.creds,
                dryRun: ctx.dryRun } as JobCtx;

  let copied = 0;
  for (const [from, to, strip] of CRM_DATA_VIEWS) {
    const rows = (await dashSelect(ctx, from, 'select=*')).map((r) => {
      const o = { ...r };
      for (const c of strip) delete o[c];
      return o;
    });
    if (ctx.dryRun) { log.push(`  ${from} -> ${to}: ${rows.length} row(s)`); continue; }
    if (!rows.length) {
      // Replacing a populated CRM table with nothing is never what was meant.
      log.push(`  ${from} -> ${to}: SKIPPED, our table is empty`);
      continue;
    }
    // Read ours in full first, so a failed read cannot leave the CRM empty.
    await dash(crm, 'DELETE', `${to}?id=gt.0`);
    for (let i = 0; i < rows.length; i += 500) {
      await dash(crm, 'POST', to, rows.slice(i, i + 500));
    }
    log.push(`  ${from} -> ${to}: ${rows.length} row(s)`);
    copied += rows.length;
  }

  log.push(ctx.dryRun
    ? 'DRY RUN - nothing written to the CRM.'
    : `copied ${copied} row(s) into the CRM`);
  return { job: 'push_to_crm', ok: true, log, queryIds: [] };
}

/* ------------------------------------------------------------ task_evidence */

/**
 * Flip CRM onboarding tasks to Done when prod itself proves the work happened.
 *
 * The rules below only cover tasks whose completion IS a data fact (an API ran
 * ok, prod holds the rows). Judgment tasks are deliberately absent — evidence
 * can say "the data is loaded", never "a human reviewed it": Tax Review,
 * PTO Balance Move, Prior Pay Info Transfer & Approval (the "& Approval" half
 * is a sign-off). Audit tasks stay with the audit-sheet sync.
 *
 * Guards:
 *   - only template tasks currently Open / In Progress are considered;
 *   - a task a human has touched (app_touched) is never flipped — it gets ONE
 *     "[task_evidence]" note so the evidence is visible and the human decides;
 *   - every flip carries a note naming its evidence, and lands in the
 *     activity log as "sync" via the existing triggers;
 *   - more than 60 planned flips aborts the run: that is a broken rule, not a
 *     productive afternoon.
 */
async function taskEvidence(ctx: JobCtx): Promise<JobResult> {
  const log: string[] = [];
  if (!ctx.crm) {
    throw new Error('CRM_URL / CRM_SERVICE_KEY are not set on this function');
  }
  const crm = { dashUrl: ctx.crm.url, dashKey: ctx.crm.key, creds: ctx.creds,
                dryRun: ctx.dryRun } as JobCtx;

  // Evidence, from our project...
  const [cov, sys, api, docT, docC, overview] = await Promise.all([
    dashSelect(ctx, 'client_data_coverage',
      'select=dsp_short_code,fein,active_employees,total_employees,active_with_payment_method'),
    dashSelect(ctx, 'client_system_activity',
      'select=dsp_short_code,tt_setup_completed,tt_employees_punched'),
    dashSelect(ctx, 'api_activity_runs',
      'select=fein,module_key,run_status,last_ok_date,last_ok_success,last_ok_total'),
    dashSelect(ctx, 'document_transfer', 'select=client_name,status,transfer_date,total_docs'),
    dashSelect(ctx, 'client_document_counts', 'select=dsp_short_code,documents,employees_with_docs'),
    dashSelect(ctx, 'client_overview', 'select=dsp_short_code,fein'),
  ]);
  // ...and the state of play in the CRM.
  const [clients, tasks, hist] = await Promise.all([
    dashSelect(crm, 'clients', 'select=id,dsp_name,short_code'),
    dashSelect(crm, 'tasks', 'select=id,client_id,title,status,app_touched&template_id=not.is.null&order=id'),
    dashSelect(crm, 'hist_clients', 'select=dsp_short_code,received,pending'),
  ]);

  const byCode = <T extends Record<string, unknown>>(rows: T[], key = 'dsp_short_code') => {
    const m = new Map<string, T>();
    rows.forEach((r) => { const k = r[key] as string; if (k) m.set(k, r); });
    return m;
  };
  const covBy = byCode(cov), sysBy = byCode(sys), histBy = byCode(hist), docCBy = byCode(docC);
  const feinBy = byCode(overview);
  const apiBy = new Map<string, Record<string, Record<string, unknown>>>();
  api.forEach((r) => {
    const f = r.fein as string;
    if (!apiBy.has(f)) apiBy.set(f, {});
    apiBy.get(f)![r.module_key as string] = r;
  });
  const norm = (t: unknown) => String(t ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const docTBy = new Map<string, Record<string, unknown>>();
  docT.forEach((r) => {
    if (r.status === 'Complete') docTBy.set(norm(r.client_name), r);
  });

  const today = new Date().toISOString().slice(0, 10);
  // What proves each template task, keyed by normalized title.
  const evidenceFor = (code: string, name: string): Record<string, string | null> => {
    const c = covBy.get(code), s = sysBy.get(code), h = histBy.get(code), d = docCBy.get(code);
    const fein = (feinBy.get(code)?.fein as string) || (c?.fein as string) || '';
    const A = apiBy.get(fein) ?? {};
    const ok = (m: string) => A[m] && A[m].run_status === 'ok' ? A[m] : null;
    const apiNote = (m: string, label: string) => {
      const r = ok(m);
      return r ? `${label} API ok ${r.last_ok_date} (${r.last_ok_success}/${r.last_ok_total})` : null;
    };
    const payPct = c && (c.active_employees as number) > 0
      ? Math.round((c.active_with_payment_method as number) / (c.active_employees as number) * 100) : null;
    const tr = docTBy.get(norm(name));
    const fed = apiNote('FedTaxWithholding', 'Fed tax'), st = apiNote('StateTaxWithholding', 'State tax');
    return {
      [norm('Company Setup')]: c ? `employer is live in prod (${c.total_employees} employees on record)` : null,
      [norm('Census Transfer')]: apiNote('EmployeeCensus', 'Census')
        ?? (c && (c.total_employees as number) >= 20
            ? `prod holds ${c.total_employees} employees (loaded outside the Census API)` : null),
      [norm('Time Tracking Setup (Kiosk/Mobile/Web)')]: s && s.tt_setup_completed
        ? `TT setup completed in prod${s.tt_employees_punched ? `; ${s.tt_employees_punched} employees have punched` : ''}` : null,
      [norm('Payment Method Transfer')]: apiNote('PaymentMethodSetup', 'Payment method')
        ?? (payPct !== null && payPct >= 90 ? `${payPct}% of active employees hold a payment method in prod` : null),
      [norm('Federal/State Withholding')]: fed && st ? `${fed}; ${st}` : null,
      [norm("Worker's Compensation")]: apiNote('WorkerCompensation', 'Worker comp'),
      [norm('Historical Data Download')]: h && (h.pending as number) === 0 && (h.received as number) > 0
        ? `historical tracker complete: ${h.received}/${h.received} reports received` : null,
      [norm('Document Transfer')]: tr
        ? `document transfer complete ${tr.transfer_date} (${tr.total_docs ?? '?'} docs)`
        : (d && (d.documents as number) >= 100
           ? `${d.documents} documents in prod across ${d.employees_with_docs} employees` : null),
    };
  };

  type Plan = { task: Record<string, unknown>; client: Record<string, unknown>; note: string; nudge: boolean };
  const plans: Plan[] = [];
  const clientById = new Map(clients.map((c) => [c.id, c]));
  for (const t of tasks) {
    if (t.status !== 'Open' && t.status !== 'In Progress') continue;
    const cl = clientById.get(t.client_id);
    if (!cl || !cl.short_code) continue;
    const ev = evidenceFor(cl.short_code as string, cl.dsp_name as string)[norm(t.title)];
    if (!ev) continue;
    plans.push({ task: t, client: cl, note: ev, nudge: t.app_touched === true });
  }

  const flips = plans.filter((p) => !p.nudge);
  const cap = ctx.taskEvidenceCap ?? 60;
  if (flips.length > cap) {
    log.push(`REFUSING: ${flips.length} planned flips is above the sanity cap of ${cap} - a rule is likely wrong.`);
    flips.slice(0, 15).forEach((p) =>
      log.push(`  would flip ${p.client.short_code} "${p.task.title}" (${p.note})`));
    return { job: 'task_evidence', ok: false, log, queryIds: [] };
  }

  // One "[task_evidence]" note per touched task, ever - look up what exists.
  const nudges = plans.filter((p) => p.nudge);
  let alreadyNudged = new Set<unknown>();
  if (nudges.length) {
    const ids = nudges.map((p) => p.task.id).join(',');
    const notes = await dashSelect(crm, 'task_notes', `select=task_id,note&task_id=in.(${ids})`);
    alreadyNudged = new Set(notes.filter((n) => String(n.note).includes('[task_evidence]'))
                                 .map((n) => n.task_id));
  }

  let flipped = 0, nudged = 0;
  for (const p of plans) {
    const label = `${p.client.short_code} "${p.task.title}"`;
    if (p.nudge) {
      if (alreadyNudged.has(p.task.id)) continue;
      log.push(`  note only (human-touched): ${label} - ${p.note}`);
      if (!ctx.dryRun) {
        await dash(crm, 'POST', 'task_notes', [{ task_id: p.task.id,
          note: `[task_evidence] Evidence says this is done: ${p.note}. Left as-is because a human last touched it.` }]);
      }
      nudged++;
      continue;
    }
    log.push(`  flip -> Done: ${label} - ${p.note}`);
    if (!ctx.dryRun) {
      await dash(crm, 'PATCH', `tasks?id=eq.${p.task.id}`, { status: 'Done', done_date: today });
      await dash(crm, 'POST', 'task_notes', [{ task_id: p.task.id,
        note: `[task_evidence] ${p.note} - auto-verified from Uzio prod` }]);
    }
    flipped++;
  }

  log.push(ctx.dryRun
    ? `DRY RUN - would flip ${flipped} task(s), nudge ${nudged}.`
    : `flipped ${flipped} task(s) to Done, nudged ${nudged} human-touched task(s).`);
  return { job: 'task_evidence', ok: true, log, queryIds: [] };
}

/* ------------------------------------------------------------- ewa_status */

/**
 * Earned-wage-access providers per live client: DailyPay and ZayZoon are
 * flags on employer_organization; PayActiv has no flag and is recognised by
 * its SFTP report (destination path or description says payactiv), with the
 * report's scheduler status and file-delivery start date. Query from Sanya
 * (14 Oct 2026), unchanged; only the Amazon filter is applied here.
 *
 * Written straight into the CRM's client_ewa (full replace): nothing on the
 * dashboard side reads it, so a copy in our project would only be a second
 * thing to keep in step.
 */
const EWA_SQL = `
with emp as (
  select eo.ein, eo.company_name, eo.client_code, eo.company_identifier, eo.live_status, eo.exchange_id,
         eo.zayzoon_sync_enabled, eo.zayzoon_sftp_start_date,
         eo.dailypay_sync_enabled, eo.dailypay_sftp_start_date
  from employer_organization eo
  where eo.deleted = 0 and eo.live_status in ('LIVE','LIVE_PARTIAL')
),
pa as (
  select c.criteria_value as ein,
         string_agg(distinct coalesce(se.status, 'NO_SCHEDULE'), ',') as payactiv_schedule,
         max(c2.criteria_value) as payactiv_start
  from sftp_report sr
  join sftp_report_criteria c on c.sftp_report_id = sr.id and c.deleted = 0 and c.criteria_key = 'employerOrgEin'
  left join sftp_report_criteria c2 on c2.sftp_report_id = sr.id and c2.deleted = 0 and c2.criteria_key = 'fileDeliveryStartDate'
  left join scheduler_events se on se.payload = sr.id::text and se.deleted = 0
  where sr.deleted = 0
    and (lower(coalesce(sr.destination_s3_path,'')) like '%payactiv%' or lower(sr.report_description) like '%payactiv%')
  group by c.criteria_value
)
select d.client_code as dsp_code, d.company_name, d.live_status,
       case when d.dailypay_sync_enabled = 1 then 'YES' else '' end as dailypay,
       to_char(d.dailypay_sftp_start_date, 'YYYY-MM-DD') as dailypay_start,
       case when d.zayzoon_sync_enabled = 1 then 'YES' else '' end as zayzoon,
       to_char(d.zayzoon_sftp_start_date, 'YYYY-MM-DD') as zayzoon_start,
       case when pa.ein is not null then 'YES' else '' end as payactiv,
       pa.payactiv_schedule, pa.payactiv_start,
       d.company_identifier, d.exchange_id
from emp d
left join pa on pa.ein = d.ein
where (d.client_code is not null and d.client_code <> '')
   or d.dailypay_sync_enabled = 1 or d.zayzoon_sync_enabled = 1 or pa.ein is not null
order by d.client_code nulls last, d.company_name`;

/** "02/22/2026" (the criteria value's format) or ISO -> ISO; anything else -> null. */
function isoDate(v: unknown): string | null {
  const s = String(v ?? '').trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : null;
}

async function ewaStatus(ctx: JobCtx): Promise<JobResult> {
  const log: string[] = [];
  if (!ctx.crm) throw new Error('CRM_URL / CRM_SERVICE_KEY are not set on this function');
  const crm = { dashUrl: ctx.crm.url, dashKey: ctx.crm.key, creds: ctx.creds, dryRun: ctx.dryRun } as JobCtx;

  const { rows, queryIds, tookMs } = await prodQuery(EWA_SQL, ctx.creds);
  const amz = rows.filter((r) => r.exchange_id === AMAZON_EXCHANGE);
  log.push(`prod returned ${rows.length} live employer(s) in ${tookMs}ms; ${amz.length} on the Amazon exchange`);
  const today = new Date().toISOString().slice(0, 10);
  const send = amz.map((r) => ({
    dsp_short_code: String(r.dsp_code ?? '').trim() || null,
    company_name: r.company_name ?? null,
    live_status: r.live_status ?? null,
    dailypay: r.dailypay === 'YES',
    dailypay_start: isoDate(r.dailypay_start),
    zayzoon: r.zayzoon === 'YES',
    zayzoon_start: isoDate(r.zayzoon_start),
    payactiv: r.payactiv === 'YES',
    payactiv_schedule: r.payactiv_schedule ?? null,
    payactiv_start: isoDate(r.payactiv_start),
    company_identifier: r.company_identifier ?? null,
    checked_date: today,
  }));
  const n = (k: 'dailypay' | 'zayzoon' | 'payactiv') => send.filter((r) => r[k]).length;
  log.push(`DailyPay ${n('dailypay')} · ZayZoon ${n('zayzoon')} · PayActiv ${n('payactiv')}`);
  const unparsed = amz.filter((r) => r.payactiv_start && !isoDate(r.payactiv_start));
  if (unparsed.length) log.push(`! ${unparsed.length} PayActiv start date(s) in an unknown format, stored blank`);

  if (ctx.dryRun) {
    log.push(`DRY RUN - ${send.length} row(s) would replace client_ewa in the CRM.`);
    return { job: 'ewa_status', ok: true, log, queryIds };
  }
  if (!send.length) throw new Error('no Amazon rows came back - refusing to empty client_ewa');
  await dash(crm, 'DELETE', 'client_ewa?id=gt.0');
  for (let i = 0; i < send.length; i += 500) await dash(crm, 'POST', 'client_ewa', send.slice(i, i + 500));
  log.push(`replaced client_ewa in the CRM with ${send.length} row(s)`);
  return { job: 'ewa_status', ok: true, log, queryIds };
}

/* ---------------------------------------------------------- payroll_setup */

/**
 * Company-level payroll setup for every Amazon-exchange employer: the earnings,
 * deductions, contributions and taxes configured in Uzio, each with its
 * settings. Asked for by Shobhit (16 Oct 2026) for the CRM's Data page.
 *
 * Tables (PayrollKit entities, all keyed on employer_org_ein = employer_organization.ein):
 *   UPS_COMPANY_EARNING_DETAIL    CompanyEarningDetail
 *   UPS_COMPANY_DEDUCTION         CompanyDeduction  (+ UPS_MASTER_DEDUCTION_TYPE for pre/post tax)
 *   ups_Company_Contritbution     CompanyContribution (sic - Uzio's spelling)
 *   UPS_TAX_DETAIL                CompanyTaxDetail  (federal: filing form, deposit schedule, exemptions)
 *   UPS_STATE_TAXATION_DETAILS    StateTaxationDetails (key/value per state + tax type)
 *
 * State tax ACCOUNT numbers are tax identifiers: they are masked to the last
 * four characters HERE, so the full number never reaches the CRM. Amounts are
 * UzioCurrency (cents) and are shown in dollars.
 *
 * One flat row per item into the CRM's client_pay_setup, settings as a small
 * label -> value object for display. Full replace, written straight to the CRM.
 */
type Row = Record<string, unknown>;

/** `from <table> x` joined to its Amazon-exchange employer, plus optional extra joins. */
const psFrom = (table: string, joins = '') =>
  `from ${table} x join employer_organization eo on eo.ein = x.employer_org_ein ` +
  `and eo.exchange_id = '${AMAZON_EXCHANGE}' and eo.deleted = 0 ${joins} ` +
  `where coalesce(x.deleted, 0) != 1`;
const PS_SQL = {
  earnings: `select eo.client_code, eo.company_name, x.*, e.earning_type, e.taxability_type, e.paid_earning, ` +
    `e.time_bounded, e.wage_determination_factor, e.amount_multiplier as master_mult ` +
    psFrom('ups_company_earning_detail', 'left join ups_earning_detail e on e.id = x.earning_id') +
    ` order by eo.client_code, x.display_order, x.id`,
  deductions: `select eo.client_code, eo.company_name, t.display_name as ded_type, m.name as master_name, x.* ` +
    psFrom('ups_company_deduction', 'left join ups_master_deduction_type t on t.id = x.master_ded_type_identifier ' +
           'left join ups_master_deduction m on m.id = x.master_ded_identifier') +
    ` order by eo.client_code, x.id`,
  // The match tiers of a FORMULA contribution ("100% of first 1%; 50% of next 4%").
  formulas: `select f.contribution_id, f.formula_order, f.company_contribution_limit, f.ee_contribution_limit, ` +
    `f.formula_value_type from ups_company_formula_detail f join ups_company_contritbution c on c.id = f.contribution_id ` +
    `join employer_organization eo on eo.ein = c.employer_org_ein and eo.exchange_id = '${AMAZON_EXCHANGE}' ` +
    `and eo.deleted = 0 where coalesce(f.deleted, 0) != 1 order by f.contribution_id, f.formula_order`,
  contributions: `select eo.client_code, eo.company_name, cd.display_name as linked_deduction, x.* ` +
    psFrom('ups_company_contritbution', 'left join ups_company_deduction cd on cd.id = x.company_deduction_id') +
    ` order by eo.client_code, x.id`,
  federal: `select eo.client_code, eo.company_name, x.* ${psFrom('ups_tax_detail')} order by eo.client_code, x.id`,
  state: `select eo.client_code, eo.company_name, x.state, x.master_tax_type, x.key, x.value, x.effective_date, ` +
    `x.updated_date ${psFrom('ups_state_taxation_details')} order by eo.client_code, x.state, x.master_tax_type, x.id`,
};

const yes = (v: unknown) => v === true || v === 1 || v === '1' || v === 'true';
const money = (v: unknown) => (v == null || v === '' || Number(v) === 0 ? null : `$${(Number(v) / 100).toFixed(2)}`);
const pct = (v: unknown) => (v == null || v === '' || Number(v) === 0 ? null : `${Number(v)}%`);
const words = (v: unknown) => v == null || v === '' ? null
  : String(v).toLowerCase().replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
const day = (v: unknown) => (v ? String(v).slice(0, 10) : null);
const mask = (v: unknown) => { const s = String(v ?? '').trim(); return !s ? null : s.length <= 4 ? '****' : `****${s.slice(-4)}`; };
/** Settings object: drops empty values so the UI shows only what is set. */
function settings(pairs: [string, unknown][]) {
  const o: Record<string, string> = {};
  for (const [k, v] of pairs) {
    if (v === null || v === undefined || v === '' || v === false) continue;
    o[k] = v === true ? 'Yes' : String(v);
  }
  return o;
}
const w2 = (box: unknown, label: unknown) =>
  !box || box === 'NOT_REQUIRED' ? null : `${String(box).replace('BOX', 'Box ')}${label ? ' ' + label : ''}`;

/* Setup Helper layout: the same columns, in the same order and wording, as the
   Earnings / Deductions / Contributions sheets of Shobhit's Setup Helper output
   (e.g. "Your Express_UZIO_Setup.xlsx"). Type Code / Type Description there
   are the source vendor's (ADP/Paycom) codes, which Uzio does not keep; here
   they carry Uzio's own code and name. Stored as [column, value] pairs so the
   CRM can render and export them without knowing the layout. */
const yn = (v: unknown) => (v == null || v === '' ? '' : yes(v) ? 'Yes' : 'No');
const enumLabel = (v: unknown) => words(v) ?? '';
const W2 = (box: unknown, label: unknown) =>
  !box || box === 'NOT_REQUIRED' ? 'Not Required' : `${String(box).replace('BOX', 'Box ')}${label ? ' - ' + label : ''}`;
// The Setup Helper sheet speaks of retirement plans by their tax treatment.
const TAX_SIDE: Record<string, string> = { '401k': 'Pre-tax', 'Roth 401k': 'Post Tax', 'Roth IRA': 'Post Tax', 'HSA': 'Pre-tax' };
const METHOD: Record<string, string> = {
  FIXED_DOLLAR: 'Fixed $', PERCENT_OF_GROSS_PAY: '% of Gross Pay', PERCENT_OF_NET_PAY: '% of Net Pay',
  PERCENT_OF_DISPOSABLE_NET_PAY: '% of Disposable Net Pay', FIXED_AMOUNT: 'Fixed $',
  PERCENTAGE_OF_GROSS_PAY: '% of Gross Pay', FORMULA: 'Formula',
};
const RATE_FACTOR: Record<string, string> = { MULTIPLY_OF_RW: 'Multiples of Regular Wage Rate' };
const num = (v: unknown) => (v == null || v === '' ? '' : String(Number(v)));

function helperEarning(r: Row): [string, string][] {
  const hourly = yes(r.time_bounded);
  return [
    ['Type Code', String(r.earning_code ?? '')], ['Type Description', String(r.name ?? '')],
    ['Earning Type', enumLabel(r.earning_type)], ['Earning Name', String(r.name ?? '')],
    ['Display Order', num(r.display_order)], ['Paid Earning', yn(r.paid_earning)],
    ['Hourly Based Earning', yn(r.time_bounded)],
    ['Rate Determination Factor', hourly ? (RATE_FACTOR[String(r.wage_determination_factor)] ?? enumLabel(r.wage_determination_factor)) : ''],
    ['Rate', hourly ? num(r.amount_multiplier ?? r.master_mult) : ''],
    ['Subject to garnishment disposable income', yn(r.disposable)], ['Subject to Workers Compensation', yn(r.subject_to_wc)],
    ['Taxability Type', r.taxability_type === 'NON_TAXABLE' ? 'Non-Taxable' : enumLabel(r.taxability_type)],
    ['Include Bonus in Overtime Calculation', r.earning_type === 'BONUS' ? yn(r.include_in_overtime) : ''],
    ['Time Off Policy', r.policy_identifier ? 'Linked' : ''], ['W-2 Box', W2(r.w2_box, r.w2_label)],
  ];
}

function helperDeduction(r: Row): [string, string][] {
  const amount = r.deduction_method === 'FIXED_DOLLAR' ? money(r.amount_per_pay) : pct(r.amount_per_pay_percent);
  // Garnishments carry no schedule in Uzio; they are taken every paycheck.
  const sched = r.schedule_for_weekly ?? r.schedule_for_biweekly ?? r.schedule_for_semimonthly ?? 'All';
  const side = TAX_SIDE[String(r.ded_type)] ?? String(r.ded_type ?? '');
  return [
    ['Type Code', String(r.deduction_code ?? '')], ['Type Description', String(r.display_name ?? '')],
    ['Pre/Post Tax', side], ['UZIO Master Deductions List', String(r.master_name ?? '')],
    ['UZIO Deduction Type', side], ['UZIO Deduction Name', String(r.display_name ?? '')],
    ['UZIO Method', METHOD[String(r.deduction_method)] ?? enumLabel(r.deduction_method)],
    ['Amount per pay', amount ?? ''], ['Auto-Sync from Uzio Benefits', yn(r.sync_from_benefit)],
    ['Assign to all employees', yn(r.auto_assign_to_ee)],
    ['Deduction Schedule', sched === 'All' ? 'Every Paycheck' : String(sched ?? '')],
    ['Track arrears', yn(r.arrears_applicable)],
    ['Arrears Processing Method', yes(r.arrears_applicable) ? enumLabel(r.arrears_processing_method) : ''],
    ['W-2 Box', W2(r.w2_box, r.w2_label)],
  ];
}

function helperContribution(r: Row, tierRows: Row[]): [string, string][] {
  const formula = tierRows.map((t, i) =>
    `${num(t.company_contribution_limit)}% of ${i === 0 ? 'first' : 'next'} ${num(t.ee_contribution_limit)}%`).join('; ');
  const method = String(r.contritbution_method ?? '');
  return [
    ['Type Code', String(r.contribution_code ?? '')], ['Type Description', String(r.name ?? '')],
    ['Contribution Name', String(r.name ?? '')], ['Link to Company Deduction', yn(r.link_contribution)],
    ['Linked Deduction', String(r.linked_deduction ?? '')], ['Method', METHOD[method] ?? enumLabel(method)],
    ['Formula', method === 'FORMULA' ? formula
      : method === 'FIXED_AMOUNT' ? (money(r.contritbution_value) ?? '') : (pct(r.contritbution_percent_value) ?? '')],
    ['Monthly Limit', money(r.monthly_limit) ?? ''], ['Annual Limit', money(r.annual_limit) ?? ''],
    ['W-2 Box', W2(r.w2_box, r.w2_label)], ['Assign to all employees', yn(r.auto_assign_to_ee)],
  ];
}

async function payrollSetup(ctx: JobCtx): Promise<JobResult> {
  const log: string[] = [];
  if (!ctx.crm) throw new Error('CRM_URL / CRM_SERVICE_KEY are not set on this function');
  const crm = { dashUrl: ctx.crm.url, dashKey: ctx.crm.key, creds: ctx.creds, dryRun: ctx.dryRun } as JobCtx;
  const queryIds: string[] = [];
  const read = async (k: keyof typeof PS_SQL) => {
    const r = await prodQuery(PS_SQL[k], ctx.creds);
    queryIds.push(...r.queryIds);
    return r.rows;
  };
  const [E, D, C, F, S, FM] = [await read('earnings'), await read('deductions'), await read('contributions'),
                               await read('federal'), await read('state'), await read('formulas')];
  const tiers = new Map<string, Row[]>();
  for (const f of FM) {
    const k = String(f.contribution_id);
    tiers.set(k, [...(tiers.get(k) ?? []), f]);
  }
  log.push(`prod: ${E.length} earnings, ${D.length} deductions, ${C.length} contributions, ` +
           `${F.length} federal tax setups, ${S.length} state tax settings`);
  const today = new Date().toISOString().slice(0, 10);
  const base = (r: Row) => ({ dsp_short_code: String(r.client_code ?? '').trim() || null,
                              company_name: r.company_name ?? null, checked_date: today });
  const send: Record<string, unknown>[] = [];

  for (const r of E) send.push({ ...base(r), category: 'Earning', name: r.name, code: r.earning_code ?? null,
    active: true, updated_date: day(r.updated_date), helper: helperEarning(r),
    settings: settings([
      ['Subject to federal tax', r.subject_to_federal_tax == null ? null : yes(r.subject_to_federal_tax) ? 'Yes' : 'No'],
      ['Subject to WC', yes(r.subject_to_wc)], ['Include in overtime', yes(r.include_in_overtime)],
      ['Part of other earning', yes(r.part_of_other_earning)], ['Disposable', yes(r.disposable)],
      ['Amount multiplier', r.amount_multiplier ? String(r.amount_multiplier) : null],
      ['W-2', w2(r.w2_box, r.w2_label)], ['Default', yes(r.is_default)], ['Editable', yes(r.is_editable)],
      ['Linked earning', r.linked_earning ?? null],
    ]) });

  for (const r of D) send.push({ ...base(r), category: 'Deduction', name: r.display_name, code: r.deduction_code ?? null,
    active: !yes(r.discarded), updated_date: day(r.updated_date), helper: helperDeduction(r),
    settings: settings([
      ['Type', r.ded_type ?? null], ['Method', words(r.deduction_method)],
      ['Amount per pay', money(r.amount_per_pay)], ['Percent per pay', pct(r.amount_per_pay_percent)],
      ['W-2', w2(r.w2_box, r.w2_label)], ['Auto-assign to employees', yes(r.auto_assign_to_ee)],
      ['Weekly schedule', r.schedule_for_weekly ?? null], ['Biweekly schedule', r.schedule_for_biweekly ?? null],
      ['Semimonthly schedule', r.schedule_for_semimonthly ?? null],
      ['Paycheck minimum', yes(r.assign_paycheck_limit) ? money(r.paycheck_minimum) : null],
      ['Paycheck maximum', yes(r.assign_paycheck_limit) ? money(r.paycheck_maximum) : null],
      ['Arrears', yes(r.arrears_applicable) ? (words(r.arrears_processing_method) ?? 'Yes') : null],
      ['Garnishment type', words(r.garnishment_type) ?? r.other_garnishment_type ?? null],
      ['Plan type', words(r.plan_type)], ['Plan ID', r.plan_id ?? null],
      ['Synced from benefits', yes(r.sync_from_benefit)], ['System seeded', yes(r.system_seeded)],
    ]) });

  for (const r of C) send.push({ ...base(r), category: 'Contribution', name: r.name, code: r.contribution_code ?? null,
    active: !yes(r.discarded), updated_date: day(r.updated_date),
    helper: helperContribution(r, tiers.get(String(r.id)) ?? []),
    settings: settings([
      ['Method', words(r.contritbution_method)], ['Amount', money(r.contritbution_value)],
      ['Percent', pct(r.contritbution_percent_value)], ['Monthly limit', money(r.monthly_limit)],
      ['Annual limit', money(r.annual_limit)], ['W-2', w2(r.w2_box, r.w2_label)],
      ['Linked deduction', r.linked_deduction ?? null], ['Linked', yes(r.link_contribution)],
      ['Auto-assign to employees', yes(r.auto_assign_to_ee)], ['Applies to S-corp', yes(r.applicable_s_corp)],
    ]) });

  for (const r of F) send.push({ ...base(r), category: 'Federal tax', name: 'Federal tax setup', code: null,
    active: true, updated_date: day(r.updated_date),
    settings: settings([
      ['Company type', r.company_type ?? null],
      ['Filing form', r.filing_form ? `${r.filing_form}${r.ff_effective_date ? ' from ' + day(r.ff_effective_date) : ''}` : null],
      ['Deposit schedule', r.tax_deposite_schedule ? `${words(r.tax_deposite_schedule)}${r.tds_effective_date ? ' from ' + day(r.tds_effective_date) : ''}` : null],
      ['FUTA exempt', yes(r.is_futa_exempted_x)], ['Social Security exempt', yes(r.sst_exemption_x)],
      ['Medicare exempt', yes(r.medicare_exemption_x)], ['S-corp shareholders', yes(r.has_scorp_shareholders)],
      ['Executive employees', yes(r.has_executive_employees)], ['Receives W-2 copy', yes(r.receive_w2_copy)],
      ['Last check number', r.last_check_number ? String(r.last_check_number) : null],
    ]) });

  // State taxes are key/value rows; one item per company + state + tax type.
  const groups = new Map<string, { r: Row; kv: [string, unknown][]; eff: string | null; upd: string | null }>();
  for (const r of S) {
    const k = `${r.client_code}|${r.company_name}|${r.state}|${r.master_tax_type}`;
    const g = groups.get(k) ?? { r, kv: [], eff: null, upd: null };
    const key = String(r.key ?? '');
    const secret = /ACCOUNT|NUMBER|_ID$|^ID$|EIN|PIN|PASSWORD/i.test(key);
    g.kv.push([words(key) ?? key, secret ? mask(r.value) : r.value]);
    const e = day(r.effective_date), u = day(r.updated_date);
    if (e && (!g.eff || e > g.eff)) g.eff = e;
    if (u && (!g.upd || u > g.upd)) g.upd = u;
    groups.set(k, g);
  }
  for (const g of groups.values()) send.push({ ...base(g.r), category: 'State tax',
    // SUTA / POP / SDI are acronyms; longer codes read as words.
    name: `${g.r.state ?? '?'} · ${String(g.r.master_tax_type ?? '').length <= 4 ? String(g.r.master_tax_type ?? '')
      : words(g.r.master_tax_type) ?? ''}`.trim(), code: String(g.r.master_tax_type ?? '') || null,
    active: true, updated_date: g.upd,
    settings: settings([...g.kv.map(([k, v]) => [k, v === 'true' ? 'Yes' : v === 'false' ? 'No' : v] as [string, unknown]),
                        ['Effective', g.eff]]) });

  const companies = new Set(send.map((r) => r.dsp_short_code)).size;
  log.push(`${send.length} item(s) across ${companies} companies`);
  if (ctx.dryRun) {
    log.push(`DRY RUN - would replace client_pay_setup in the CRM.`);
    return { job: 'payroll_setup', ok: true, log, queryIds };
  }
  if (!send.length) throw new Error('no setup rows came back - refusing to empty client_pay_setup');
  await dash(crm, 'DELETE', 'client_pay_setup?id=gt.0');
  for (let i = 0; i < send.length; i += 500) await dash(crm, 'POST', 'client_pay_setup', send.slice(i, i + 500));
  log.push(`replaced client_pay_setup in the CRM`);
  return { job: 'payroll_setup', ok: true, log, queryIds };
}

/* ------------------------------------------------------------- the registry */

export const JOBS: Record<string, (ctx: JobCtx) => Promise<JobResult>> = {
  // backfill_fein runs first: everything keyed on fein below is only as
  // complete as client_overview.fein is at the moment it reads.
  backfill_fein: backfillFein,
  work_locations: workLocations,
  data_coverage: dataCoverage,
  load_history: loadHistory,
  document_counts: documentCounts,
  system_activity: systemActivity,
  payroll_health: payrollHealth,
  api_activity: apiActivity,
  // Writes the CRM directly, so it does not depend on push_to_crm's order.
  ewa_status: ewaStatus,
  payroll_setup: payrollSetup,
  // Last: it copies whatever is in our Supabase at that moment, so anything
  // written after it would not reach the CRM until Apps Script's 17:30 run.
  push_to_crm: pushToCrm,
  // After push_to_crm (it reads the CRM's hist_clients, which Apps Script
  // refreshes at 17:30 - its own cron slot runs later still).
  task_evidence: taskEvidence,
};
