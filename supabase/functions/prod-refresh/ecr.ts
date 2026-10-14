/**
 * Employee Profile Change Report — the data half, for the CRM.
 *
 * Port of the data access in the Streamlit tool (Deduction Tool/utils/
 * change_report.py: find_employees, fetch_versions, fetch_contacts,
 * resolve_users). The workbook itself is built in the browser
 * (site/ecr.js), one employee per call, so a large batch never meets this
 * function's wall-clock limit.
 *
 * Every read runs under the READER'S own NeuronOps sign-in (ops_login), never
 * this function's service account: employee history is personal data, and
 * prod's audit (ops_query_read_tracker) should name whoever looked. The
 * password is used once to mint a token and is never stored or logged.
 *
 *   ops_login     { username, password }        -> { token, user }
 *   ecr_find      { feins: [], ids: [] , obToken } -> { companies, employees }
 *   ecr_versions  { employeeCode, obToken }     -> { versions, contacts }
 *
 * Read-only by contract: the NeuronOps endpoint runs one SELECT in a read-only
 * transaction. Every value that reaches SQL is either digits-only, matched
 * against a strict pattern, or quoted through sqlList.
 */
import { mintToken, prodQuery, sqlList } from './prodQuery.ts';

type Ops = { token: string };
type Row = Record<string, unknown>;

const q = (ops: Ops, sql: string) => prodQuery(sql, { token: ops.token, size: 2000 });
const fein9 = (v: unknown) => { const d = String(v ?? '').replace(/\D/g, ''); return d.length === 9 ? d : ''; };
const idSafe = (v: unknown) => String(v ?? '').trim().slice(0, 64);
const codeSafe = (v: unknown) => String(v ?? '').replace(/[^A-Za-z0-9-]/g, '');
const digitsOnly = (vals: unknown[]) => vals.map(String).filter((s) => /^\d+$/.test(s));

export async function opsLogin(username: unknown, password: unknown) {
  const u = String(username ?? '').trim(), p = String(password ?? '');
  if (!u || !p) throw new Error('enter your Uzio username and password');
  try {
    return { token: await mintToken(u, p), user: u };
  } catch {
    // mintToken never echoes the response body, so nothing typed can leak.
    throw new Error('Uzio sign-in refused - check the username and password');
  }
}

export async function ecrFind(ops: Ops, feinsIn: unknown, idsIn: unknown) {
  const feins = [...new Set((Array.isArray(feinsIn) ? feinsIn : [feinsIn]).map(fein9).filter(Boolean))];
  const ids = [...new Set((Array.isArray(idsIn) ? idsIn : []).map(idSafe).filter(Boolean))].slice(0, 2000);
  if (!feins.length && !ids.length) throw new Error('give a company FEIN or at least one Employee ID');
  const queryIds: string[] = [];
  const run = async (sql: string) => { const r = await q(ops, sql); queryIds.push(...r.queryIds); return r.rows; };

  let companies: Row[] = [];
  let scope = '';
  if (feins.length) {
    companies = await run('select id, ein, fein, company_name, client_code from employer_organization ' +
                          `where fein in (${sqlList(feins)}) and deleted = 0`);
    if (!companies.length) return { companies, employees: [], unknownFeins: feins, queryIds };
    scope = `employer_organization_id in (${digitsOnly(companies.map((c) => c.id)).join(',')})`;
  }
  const where = [scope, ids.length ? `(ext_employee_code in (${sqlList(ids)}))` : ''].filter(Boolean).join(' and ');
  const cols = 'employee_code, ext_employee_code, full_name, status, employer_organization_id, date_of_hire, date_of_termination';
  const rows = await run(`select ${cols} from employee where ${where} and deleted = 0 order by full_name, employee_code`);

  // An ID Uzio has since replaced (1020 -> BH0KS5HPZ) only lives in the history.
  if (ids.length && feins.length) {
    const seen = new Set(rows.map((r) => String(r.ext_employee_code)));
    const missing = ids.filter((i) => !seen.has(i));
    const eins = companies.map((c) => c.ein).filter(Boolean).map(String);
    if (missing.length && eins.length) {
      const hist = await run('select distinct employee_code, ext_employee_code from employee_history ' +
                             `where ext_employee_code in (${sqlList(missing)}) and ein in (${sqlList(eins)}) and deleted = 0`);
      const known = new Set(rows.map((r) => r.employee_code));
      const was = new Map<string, string>();
      for (const h of hist) if (!known.has(h.employee_code)) was.set(String(h.employee_code), String(h.ext_employee_code));
      if (was.size) {
        const found = await run(`select ${cols} from employee where employee_code in (${sqlList([...was.keys()])}) and deleted = 0`);
        for (const f of found) { f.found_via = `was ${was.get(String(f.employee_code))}`; rows.push(f); }
      }
    }
  }

  const orgIds = digitsOnly([...new Set(rows.map((r) => r.employer_organization_id).filter(Boolean))]);
  const orgs = new Map<string, Row>();
  if (orgIds.length) {
    for (const o of await run(`select id, fein, company_name from employer_organization where id in (${orgIds.join(',')})`)) {
      orgs.set(String(o.id), o);
    }
  }
  for (const r of rows) {
    const o = orgs.get(String(r.employer_organization_id)) ?? {};
    r.company_name = o.company_name ?? '';
    r.fein = o.fein ?? '';
  }
  const unknownFeins = feins.filter((f) => !companies.some((c) => String(c.fein) === f));
  return { companies, employees: rows, unknownFeins, queryIds };
}

const USER_TYPE: Record<string, string> = { EMPLOYEE: 'EE', EMPLOYER: 'ER', BROKER: 'BR', SUBBROKER: 'BR',
  ADMIN: 'CSR', BROKERAGENCY: 'BR' };

/** {login -> "Tobias Conner (Employer Administrator)"}, as populateWhoChanged builds it. */
async function resolveUsers(run: (s: string) => Promise<Row[]>, logins: string[]) {
  const wanted = [...new Set(logins.map((l) => String(l ?? '').trim()).filter((l) => l && l !== 'System' && l !== 'SCRIPT'))];
  if (!wanted.length) return {} as Record<string, string>;
  const list = sqlList(wanted);
  const rows = await run('select u.username, u.user_identifier, p.id as profile_id, p.user_type, ' +
    'p.first_name, p.middle_name, p.last_name, r.name as role_name from user_data u ' +
    'join user_profile p on p.user_id = u.id and p.deleted = 0 ' +
    'left join USER_ROLE_MAPPING m on m.user_profile_id = p.id and m.deleted = 0 ' +
    'left join USER_ROLES r on r.id = m.role_id ' +
    `where u.username in (${list}) or u.user_identifier in (${list})`);
  const profiles = new Map<string, { key: string; pid: number; row: Row; roles: string[] }>();
  for (const row of rows) {
    for (const key of [row.username, row.user_identifier]) {
      if (!key || !wanted.includes(String(key))) continue;
      const id = `${key}\u0000${row.profile_id}`;
      const p = profiles.get(id) ?? { key: String(key), pid: Number(row.profile_id) || 0, row, roles: [] };
      if (row.role_name && !p.roles.includes(String(row.role_name))) p.roles.push(String(row.role_name));
      profiles.set(id, p);
    }
  }
  const labels: Record<string, string> = {};
  // Where a user has several profiles, the oldest wins - what Uzio's export showed.
  for (const p of [...profiles.values()].sort((a, b) => a.pid - b.pid)) {
    if (p.key in labels) continue;
    const name = [p.row.first_name, p.row.middle_name, p.row.last_name].filter(Boolean).join(' ');
    const ut = String(p.row.user_type ?? '');
    const suffix = ut === 'EMPLOYER' && p.roles.length ? p.roles.join(',') : (USER_TYPE[ut] ?? ut);
    labels[p.key] = name && suffix ? `${name} (${suffix})` : name || p.key;
  }
  return labels;
}

export async function ecrVersions(ops: Ops, employeeCode: unknown) {
  const code = codeSafe(employeeCode);
  if (!code) throw new Error('employeeCode is required');
  const queryIds: string[] = [];
  const run = async (sql: string) => { const r = await q(ops, sql); queryIds.push(...r.queryIds); return r.rows; };

  const versions = await run(`select * from employee_history where employee_code = '${code}' and deleted = 0 order by created_date, id`);
  if (!versions.length) return { versions, contacts: {}, queryIds };

  const groups = [...new Set(versions.map((r) => r.pay_group_identifier).filter(Boolean).map(String))];
  const groupName = new Map<string, unknown>();
  if (groups.length) {
    for (const r of await run('select pay_group_identifier, pay_group_name from EMPLOYER_PAY_GROUP ' +
                              `where pay_group_identifier in (${sqlList(groups)})`)) {
      groupName.set(String(r.pay_group_identifier), r.pay_group_name);
    }
  }
  const managers = [...new Set(versions.map((r) => r.reporting_to).filter(Boolean).map(String))];
  const managerName = new Map<string, unknown>();
  if (managers.length) {
    for (const r of await run(`select employee_code, full_name from employee where employee_code in (${sqlList(managers)})`)) {
      managerName.set(String(r.employee_code), r.full_name);
    }
  }
  let people: Record<string, string> = {};
  try {
    people = await resolveUsers(run, versions.map((r) => String(r.created_by ?? '')));
  } catch { /* fall back to the login itself, as the Streamlit tool does */ }

  const out = versions.map((r) => {
    const v: Row = {};
    for (const k of VERSION_COLS) v[k] = r[k] ?? null;
    // Ciphertext never leaves this function: the report only says whether a
    // value is there, so a presence flag is all the browser gets.
    for (const k of ENCRYPTED_COLS) v[k] = r[k] == null || r[k] === '' ? null : 1;
    // hours is a double: Uzio's export prints 40.0, and JSON would hand the
    // browser a bare 40.
    if (typeof r.hours === 'number') v.hours = Number.isInteger(r.hours) ? r.hours.toFixed(1) : String(r.hours);
    v.who_changed = people[String(r.created_by ?? '').trim()] ?? '';
    v.pay_group_name = groupName.get(String(r.pay_group_identifier)) ?? '';
    v.reporting_to_name = managerName.get(String(r.reporting_to)) ?? '';
    // The work-week-schedule lookup is not exposed by the query endpoint.
    v.work_week_schedule_name = '';
    return v;
  });

  const ids = digitsOnly(versions.map((v) => v.id));
  const contacts: Record<string, Row[]> = {};
  if (ids.length) {
    for (const c of await run(`select * from emergency_contact_history where employee_history_id in (${ids.join(',')}) and deleted = 0 order by id`)) {
      const k: Row = {};
      for (const col of CONTACT_COLS) k[col] = c[col] ?? null;
      (contacts[String(c.employee_history_id)] ??= []).push(k);
    }
  }
  return { versions: out, contacts, queryIds };
}

/** Exactly the history columns the report prints or needs (site/ecr.js FIELDS). */
const VERSION_COLS = ['id', 'employee_code', 'created_date', 'created_by', 'ip_address', 'source',
  'job_effective_dates', 'salary_effective_date', 'custom_field',
  'salutation', 'first_name', 'middle_name', 'last_name', 'name_suffix', 'date_of_birth', 'gender',
  'marital_status', 'is_smoker', 'ext_employee_code', 'status', 'date_of_hire', 'adjusted_service_date',
  'date_of_termination', 'termination_type', 'employment_type', 'other_employment_type', 'pay_type',
  'hours', 'class_name', 'designation', 'department', 'employment_type_two',
  'employment_classification_one', 'employment_classification_two', 'work_location', 'division',
  'special_hire_flag', 'protected_veteran_status', 'disability_status', 'eeo_job_category',
  'race_ethnicity', 'original_doh', 'email', 'emailofficial', 'phone', 'address_line1',
  'address_line2', 'city', 'zip', 'state', 'county'];
const ENCRYPTED_COLS = ['ssn', 'annual_salary', 'hourly_rate', 'bonus', 'commission'];
const CONTACT_COLS = ['id', 'employee_history_id', 'emergency_contact_identifier', 'name', 'relationship',
  'address_line1', 'address_line2', 'city', 'zip', 'county', 'state', 'email', 'phone',
  'detention_arrest_consent'];
