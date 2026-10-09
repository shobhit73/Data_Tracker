/**
 * prod-refresh -- the prod half of the DSP Ops refresh, on demand.
 *
 * Deploys into the CRM's Supabase project and writes into ours. It lives in
 * the CRM project for one reason: that is where the login already is. A CRM
 * user's session token is issued by that project, so only a function in that
 * project can check it -- which is what keeps this endpoint from needing a
 * shared secret sitting in the browser.
 *
 * ---------------------------------------------------------------- AUTH ----
 * The platform's verify_jwt gate is OFF for this function (supabase/config.toml
 * says why), so the check below is the ONLY thing guarding it. Weakening it
 * means turning that setting back on in the same commit.
 *
 * The gate had to go because it validates tokens against the keys of the
 * project hosting the function, and our callers sign in to the CRM: every one
 * of them came back 401 UNAUTHORIZED_ASYMMETRIC_JWT before this file ran.
 *
 * Losing it costs less than it sounds, because it was never sufficient on its
 * own: a project's anon/publishable key IS a valid JWT for that project, and
 * it sits in the CRM's frontend where anyone can read it out of devtools. So
 * this resolves the token to an actual user through the CRM's auth.getUser
 * and turns away anything that is not one -- which is strictly the stronger
 * check. Verified against the real anon key on 09 Oct 2026: it answers
 * "sign in to the CRM to run this".
 *
 * Any logged-in CRM user may run it (Shobhit's decision, 06 Oct 2026). The
 * caller's email is logged and returned, because the prod-side audit cannot
 * identify them: every read reaches prod under this function's single
 * NeuronOps account, so ops_query_read_tracker shows that account rather than
 * whoever clicked. The two logs together are what makes a run attributable,
 * which is why the response carries both the email and the queryIds.
 *
 * ------------------------------------------------------------- SECRETS ----
 *   NEURONOPS_USERNAME   prod NeuronOps login
 *   NEURONOPS_PASSWORD
 *   DASH_URL             our dashboard project's URL
 *   DASH_SERVICE_KEY     our project's sb_secret_ key, to write client_* tables
 *   CRM_URL              the CRM project's URL      } push_to_crm only; the
 *   CRM_SERVICE_KEY      the CRM's sb_secret_ key   } other jobs run without
 * Set them with `supabase secrets set`. They are never committed, and nothing
 * here echoes one back -- including in an error.
 *
 * ----------------------------------------------------------------- USE ----
 *   POST /functions/v1/prod-refresh
 *   { "jobs": ["work_locations"], "dryRun": true }
 * `jobs` omitted runs all of them. Jobs are independent: one failing is
 * reported and the rest still run, the same as the Python runner it replaces.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { JOBS, type JobCtx, type JobResult } from './jobs.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

function requiredEnv(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`secret ${name} is not set on this function`);
  return v;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  // --- who is calling -----------------------------------------------------
  const token = (req.headers.get('Authorization') ?? '')
    .replace(/^Bearer\s+/i, '').trim();
  if (!token) return json({ error: 'missing Authorization header' }, 401);

  let email = '';
  try {
    // WHICH PROJECT'S LOGIN COUNTS
    //   A session token is only valid against the project that issued it, so
    //   the check has to point at wherever the CRM's users live -- which is
    //   not necessarily where this function is deployed.
    //
    //   The plan was to host this in the CRM project and use the injected
    //   SUPABASE_* values. That needs membership of the CRM's Supabase org,
    //   which Shobhit's account does not have ("403: your account does not
    //   have the necessary privileges", 09 Oct 2026 -- `projects list` returns
    //   only his own two). Rather than wait on an org invite, CRM_AUTH_URL and
    //   CRM_ANON_KEY let the function live in our project and still validate
    //   CRM sessions: auth.getUser is a call to that project's /auth/v1/user,
    //   and it does not care who is making it.
    //
    //   They fall back to the injected values, so moving this into the CRM
    //   project later means deleting two secrets and nothing else.
    //
    //   The anon key is the right key here and is not a secret worth guarding
    //   -- it is already in the CRM's own frontend. It is also, on its own,
    //   not enough: see the getUser check below.
    const crm = createClient(
      Deno.env.get('CRM_AUTH_URL') || requiredEnv('SUPABASE_URL'),
      Deno.env.get('CRM_ANON_KEY') || requiredEnv('SUPABASE_ANON_KEY'),
    );
    const { data, error } = await crm.auth.getUser(token);
    // The check that matters. The anon key satisfies verify_jwt but resolves
    // to no user, so it lands here rather than running anything.
    if (error || !data?.user) {
      return json({ error: 'sign in to the CRM to run this' }, 401);
    }
    email = data.user.email ?? data.user.id;
  } catch (e) {
    return json({ error: `auth check failed: ${(e as Error).message}` }, 500);
  }

  // --- what to run --------------------------------------------------------
  let body: { jobs?: string[]; dryRun?: boolean } = {};
  try {
    const text = await req.text();
    if (text.trim()) body = JSON.parse(text);
  } catch {
    return json({ error: 'body must be JSON' }, 400);
  }

  const names = body.jobs?.length ? body.jobs : Object.keys(JOBS);
  const unknown = names.filter((n) => !(n in JOBS));
  if (unknown.length) {
    return json({ error: `unknown job(s): ${unknown.join(', ')}`,
                  known: Object.keys(JOBS) }, 400);
  }

  let ctx: JobCtx;
  try {
    ctx = {
      dashUrl: requiredEnv('DASH_URL').replace(/\/+$/, ''),
      dashKey: requiredEnv('DASH_SERVICE_KEY'),
      creds: {
        username: requiredEnv('NEURONOPS_USERNAME'),
        password: requiredEnv('NEURONOPS_PASSWORD'),
      },
      dryRun: body.dryRun === true,
    };
    // Optional, so the NeuronOps jobs still run on a function that has not
    // been given onboarding credentials. api_activity says so itself rather
    // than failing here and taking the other jobs down with it.
    const obUser = Deno.env.get('ONBOARDING_USERNAME');
    const obPass = Deno.env.get('ONBOARDING_PASSWORD');
    const obFein = Deno.env.get('ONBOARDING_FEIN');
    if (obUser && obPass && obFein) {
      ctx.onboarding = { username: obUser, password: obPass, fein: obFein };
    }
    const crmUrl = Deno.env.get('CRM_URL');
    const crmKey = Deno.env.get('CRM_SERVICE_KEY');
    if (crmUrl && crmKey) {
      ctx.crm = { url: crmUrl.replace(/\/+$/, ''), key: crmKey };
    }
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }

  const started = Date.now();
  console.log(`prod-refresh by ${email}: ${names.join(', ')}` +
              (ctx.dryRun ? ' (dry run)' : ''));

  const results: JobResult[] = [];
  for (const name of names) {
    try {
      results.push(await JOBS[name](ctx));
    } catch (e) {
      results.push({ job: name, ok: false, log: [(e as Error).message], queryIds: [] });
    }
  }
  results.forEach((r) => r.log.forEach((l) => console.log(`  [${r.job}] ${l}`)));

  const failed = results.filter((r) => !r.ok);
  return json({
    ranBy: email,
    dryRun: ctx.dryRun,
    tookMs: Date.now() - started,
    ok: failed.length === 0,
    jobs: results,
    // Ties this run to its rows in prod's ops_query_read_tracker.
    queryIds: results.flatMap((r) => r.queryIds),
  }, failed.length ? 207 : 200);
});
