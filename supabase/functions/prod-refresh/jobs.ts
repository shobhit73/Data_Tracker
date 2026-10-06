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
import { prodQuery, sqlList } from './prodQuery.ts';

export interface JobCtx {
  dashUrl: string;
  dashKey: string;
  creds: { username: string; password: string };
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

/* ------------------------------------------------------------- the registry */

export const JOBS: Record<string, (ctx: JobCtx) => Promise<JobResult>> = {
  work_locations: workLocations,
};
