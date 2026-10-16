/**
 * Onboarding API run logs, on demand -- the CRM's port of the Streamlit
 * "Onboarding API Run Logs" tool (Deduction Tool/apps/common/onboarding_logs.py,
 * parsing from utils/onboarding_query.py).
 *
 * Two read-only actions, neither of which writes anywhere:
 *   api_runs        { fein }   every run for one client, newest first, with
 *                              per-module counts and a status -- no blobs
 *   api_run_detail  { runId }  one run's per-employee errors and warnings,
 *                              grouped by reason, plus the raw rows (capped)
 *
 * Like the Streamlit tool, every read runs under the READER'S own Uzio login,
 * not this function's service account: the CRM sign-in and the Uzio sign-in
 * are different accounts, and prod's audit should name whoever looked. A
 * browser cannot call the onboarding backend itself (prodQuery.ts explains the
 * 403 preflight), so this function relays it:
 *   ob_login        { username, password, fein? } -> { token }
 *                   The password is used once to mint a token and is never
 *                   stored or logged. The token goes back to the browser,
 *                   which keeps it in sessionStorage and sends it with each
 *                   read below.
 * The FEIN the token endpoint demands does not scope the results; the client's
 * own FEIN is tried first, then the function's configured one.
 */
import { onboardingQuery, onboardingToken } from './prodQuery.ts';

type Ob = { token: string };
type Row = Record<string, unknown>;

export async function obLogin(username: unknown, password: unknown, feins: string[]) {
  const u = String(username ?? '').trim(), p = String(password ?? '');
  if (!u || !p) throw new Error('enter your Uzio username and password');
  let last = '';
  for (const f of feins.filter(Boolean)) {
    try {
      return { token: await onboardingToken(u, p, f), user: u };
    } catch (e) { last = (e as Error).message; }
  }
  // onboardingToken never echoes the response body, so this cannot leak input.
  throw new Error(`Uzio sign-in refused (${last || 'no FEIN to sign in against'})`);
}

const TABLE = 'onboarding_automation_history';
// error_messages / optional_validations stay out of the listing: one row can
// carry megabytes of them, and response_body already holds the counts.
const LIGHT = 'id, vendor, fein, start_time, end_time, created_by, response_body';
const RAW_ROW_CAP = 3000;

function parseJson(raw: unknown): unknown {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  try { return JSON.parse(s); } catch { return s; }
}

function utc(v: unknown): Date | null {
  const s = String(v ?? '').trim();
  if (!s) return null;
  // The columns are UTC without a zone; say so before parsing.
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(' ', 'T') + 'Z');
  return isNaN(d.getTime()) ? null : d;
}

function summarize(row: Row) {
  const body = parseJson(row.response_body);
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, Record<string, unknown>>;
  const tm = b.TotalMap ?? {}, sm = b.SuccessMap ?? {}, fm = b.FailureMap ?? {};
  const modules: Record<string, [number, number, number]> = {};
  for (const k of Object.keys(tm)) {
    modules[k] = [Number(tm[k] ?? 0) || 0, Number(sm[k] ?? 0) || 0, Number(fm[k] ?? 0) || 0];
  }
  const processed = Object.values(modules).reduce((a, m) => a + m[0], 0);
  const failed = Object.values(modules).reduce((a, m) => a + m[2], 0);
  const start = utc(row.start_time), end = utc(row.end_time);
  let status: string;
  if (end) {
    // Finished having processed nobody is not a pass.
    status = processed === 0 ? 'NOTHING' : failed === 0 ? 'OK' : 'FAIL';
  } else {
    const min = start ? Math.floor((Date.now() - start.getTime()) / 60000) : 0;
    status = min <= 120 ? 'RUNNING' : 'NO_RESULT';   // two hours in, it died
  }
  return {
    id: row.id, vendor: row.vendor ?? null,
    by: String(row.created_by ?? '').split('@')[0],
    start: start ? start.toISOString() : null,
    end: end ? end.toISOString() : null,
    tookSec: start && end ? Math.round((end.getTime() - start.getTime()) / 1000) : null,
    modules, processed, failed, status,
  };
}

function digits(v: unknown, len = 9): string {
  const d = String(v ?? '').replace(/\D/g, '');
  return d.length === len ? d : '';
}

export async function apiRuns(ob: Ob, fein: unknown) {
  const f = digits(fein);
  if (!f) throw new Error('fein must be 9 digits');
  const { rows, queryIds } = await onboardingQuery(
    `select ${LIGHT} from ${TABLE} where fein = '${f}' order by id desc limit 300`,
    { ...ob, size: 300 });
  return { fein: f, runs: rows.map(summarize), queryIds };
}

interface Issue { module: string; row: unknown; employeeId: unknown; type: unknown; reason: string }

function issueRows(blob: unknown): Issue[] {
  const parsed = parseJson(blob);
  const out: Issue[] = [];
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    for (const [module, items] of Object.entries(parsed as Record<string, unknown>)) {
      for (const it of (Array.isArray(items) ? items : [])) {
        if (it && typeof it === 'object') {
          const o = it as Row;
          out.push({ module, row: o.rowNumber ?? null, employeeId: o.employeeId ?? null,
                     type: o.errorType ?? null, reason: String(o.errorDetails ?? '').trim() });
        } else {
          out.push({ module, row: null, employeeId: null, type: null, reason: String(it) });
        }
      }
    }
  } else if (parsed) {
    // The API sometimes writes a plain sentence when it could not serialise.
    out.push({ module: '', row: null, employeeId: null, type: null, reason: String(parsed) });
  }
  return out;
}

/** The same reason hit by 200 employees is one line, not 200. */
function group(issues: Issue[]) {
  const m = new Map<string, { module: string; type: unknown; reason: string; count: number; sample: string[] }>();
  for (const i of issues) {
    const k = `${i.module}\u0000${i.type}\u0000${i.reason}`;
    const g = m.get(k) ?? { module: i.module, type: i.type, reason: i.reason, count: 0, sample: [] };
    g.count++;
    if (i.employeeId != null && g.sample.length < 3) g.sample.push(String(i.employeeId));
    m.set(k, g);
  }
  return [...m.values()].sort((a, b) => b.count - a.count);
}

export async function apiRunDetail(ob: Ob, runId: unknown) {
  const id = Number(runId);
  if (!Number.isInteger(id) || id <= 0) throw new Error('runId must be a positive integer');
  const { rows, queryIds } = await onboardingQuery(
    `select id, vendor, fein, start_time, end_time, created_by, response_body, ` +
    `error_messages, optional_validations from ${TABLE} where id = ${id}`, { ...ob, size: 1 });
  if (!rows.length) throw new Error(`no run with id ${id}`);
  const row = rows[0];
  const errors = issueRows(row.error_messages);
  const warnings = issueRows(row.optional_validations);
  return {
    run: { ...summarize(row), fein: row.fein ?? null },
    errors: { total: errors.length, grouped: group(errors), rows: errors.slice(0, RAW_ROW_CAP) },
    warnings: { total: warnings.length, grouped: group(warnings), rows: warnings.slice(0, RAW_ROW_CAP) },
    rawCap: RAW_ROW_CAP,
    queryIds,
  };
}

/**
 * Live progress of one run, from onboarding_automation_api_call_history --
 * the onboarding service writes one row per outbound Uzio call as it happens
 * (HttpCallAuditAspect), long before response_body gets its TotalMap.
 * Counts only: request/response bodies carry employee PII and never leave.
 * "posted" = POST calls, i.e. rows actually pushed into prod (PriorPayroll:
 * one paystub save per employee per pay date; Census: one employee create).
 */
export async function apiRunProgress(ob: Ob, runId: unknown) {
  const id = Number(runId);
  if (!Number.isInteger(id) || id <= 0) throw new Error('runId must be a positive integer');
  const [calls, run] = await Promise.all([
    onboardingQuery(
      `select process, count(*) calls, ` +
      `sum(case when http_method = 'POST' then 1 else 0 end) posted, ` +
      `sum(case when response_status >= 400 or error_reason is not null then 1 else 0 end) failed, ` +
      `count(distinct substring(request_uri from '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')) employees, ` +
      `min(start_time) first_call, max(coalesce(end_time, start_time)) last_call ` +
      `from onboarding_automation_api_call_history where automation_id = ${id} group by process`,
      { ...ob, size: 20 }),
    onboardingQuery(`select id, start_time, end_time, response_body from ${TABLE} where id = ${id}`,
      { ...ob, size: 1 }),
  ]);
  if (!run.rows.length) throw new Error(`no run with id ${id}`);
  const n = (v: unknown) => Number(v ?? 0) || 0;
  const per = calls.rows.map((r) => ({
    process: String(r.process ?? ''), calls: n(r.calls), posted: n(r.posted), failed: n(r.failed),
    employees: n(r.employees),
    first: utc(r.first_call)?.toISOString() ?? null, last: utc(r.last_call)?.toISOString() ?? null,
  }));
  const sum = (k: 'calls' | 'posted' | 'failed' | 'employees') => per.reduce((a, p) => a + p[k], 0);
  const lasts = per.map((p) => p.last).filter(Boolean).sort();
  return {
    run: summarize(run.rows[0]),
    progress: { calls: sum('calls'), posted: sum('posted'), failed: sum('failed'), employees: sum('employees'),
                lastCall: lasts.length ? lasts[lasts.length - 1] : null, byProcess: per },
    asOf: new Date().toISOString(),
    queryIds: [...calls.queryIds, ...run.queryIds],
  };
}

/**
 * Every failure/warning one employee hit across this client's runs. The
 * search text narrows the SQL with LIKE (so megabyte blobs of other runs stay
 * on the server), then the parsed rows are filtered again so only that
 * employee's lines come back. Only [A-Za-z0-9 ._@-] survive -- it goes into SQL.
 */
const SEARCH_RUN_CAP = 40;
export async function apiEmployeeSearch(ob: Ob, fein: unknown, query: unknown) {
  const f = digits(fein);
  if (!f) throw new Error('fein must be 9 digits');
  const q = String(query ?? '').replace(/[^A-Za-z0-9 ._@-]/g, '').trim().slice(0, 40);
  if (q.length < 2) throw new Error('type at least 2 letters or digits of the employee ID or name');
  const like = q.toLowerCase();
  const { rows, queryIds } = await onboardingQuery(
    `select id, vendor, fein, start_time, end_time, created_by, response_body, error_messages, optional_validations ` +
    `from ${TABLE} where fein = '${f}' and (lower(coalesce(error_messages, '')) like '%${like}%' ` +
    `or lower(coalesce(optional_validations, '')) like '%${like}%') order by id desc limit ${SEARCH_RUN_CAP}`,
    { ...ob, size: SEARCH_RUN_CAP });
  const hit = (i: Issue) => String(i.employeeId ?? '').toLowerCase().includes(like) || i.reason.toLowerCase().includes(like);
  const matches: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    const s = summarize(row);
    const add = (kind: string, list: Issue[]) => {
      for (const i of list.filter(hit)) {
        matches.push({ runId: s.id, start: s.start, by: s.by, runStatus: s.status, kind,
                       module: i.module, row: i.row, employeeId: i.employeeId, type: i.type, reason: i.reason });
      }
    };
    add('error', issueRows(row.error_messages));
    add('warning', issueRows(row.optional_validations));
  }
  return { fein: f, query: q, runsSearched: rows.length, runCap: SEARCH_RUN_CAP,
           matches: matches.slice(0, 500), total: matches.length, queryIds };
}
