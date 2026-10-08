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
  work_locations: workLocations,
  api_activity: apiActivity,
};
