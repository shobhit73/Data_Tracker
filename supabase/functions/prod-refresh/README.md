# prod-refresh

An HTTP endpoint that pulls the prod half of the DSP Ops refresh and writes it
into our Supabase. Meant to be called from a button in the CRM, and schedulable
with `pg_cron` as well.

It replaces, for the jobs it covers, the part of the 12:30 routine that still
needed a laptop.

## It never needed the VPN

That is the whole premise, and it was checked rather than assumed:

```
api.uzio.com                          13.35.78.20/.72/.87/.96   AWS CloudFront, public
neuron-all-qa-01.internal.hcphix.com  10.40.32.90               private, VPN only
POST https://api.uzio.com/api/auth/token   ->  HTTP 400 in 1.15s, off the VPN
```

Only `*.internal.hcphix.com` is private. The task doc claimed these steps needed
the VPN for a long time; they did not. What they needed was somewhere to keep a
credential, which is what this function is.

## Where it lives, and why

| | |
|---|---|
| Function runs in | **our dashboard** project |
| Verifies logins against | the **CRM** project, via `CRM_AUTH_URL` / `CRM_ANON_KEY` |
| Writes into | **our dashboard** project |

The first plan was to host this in the CRM project, because that is where the
login is. Deploying there needs membership of the CRM's Supabase org, and
Shobhit's account does not have it — `supabase functions deploy` answers *403:
your account does not have the necessary privileges*, and `projects list`
returns only his own two projects (09 Oct 2026).

It turns out not to matter. A session token is validated by calling the issuing
project's `/auth/v1/user`, and nothing says the caller has to live there. So the
function runs in our project and points its auth check at the CRM's with two
extra secrets. Two things improve as a result:

- our `sb_secret_` key stays in our own project instead of becoming a secret on
  a function in someone else's
- nobody has to wait on an org invite

If the CRM org does add us later, delete `CRM_AUTH_URL` and `CRM_ANON_KEY` and
redeploy there; the code falls back to the injected `SUPABASE_*` values on its
own.

The CRM frontend then calls this function cross-origin, which the CORS headers
already allow.

## Auth: the platform gate is off, and `getUser` is the whole guard

`supabase/config.toml` sets `verify_jwt = false` for this function. It had to:
that gate validates tokens against the keys of the project hosting the
function, and our callers sign in to the CRM, so every real user was refused
before the code ran —

```
401 {"code":"UNAUTHORIZED_ASYMMETRIC_JWT","message":"Invalid JWT"}
```

Losing it costs less than it sounds, because it was never sufficient anyway:

> A Supabase project's anon/publishable key **is itself a valid JWT** for that
> project. It sits in the CRM's frontend, where anyone can read it out of
> devtools. A function relying on `verify_jwt` alone is open to the public.

`index.ts` resolves the caller's token to a real user through the CRM's
`auth.getUser()` and rejects anything that does not resolve — strictly the
stronger check. **It is now the only one.** Weakening it means setting
`verify_jwt = true` in the same commit.

Both paths were checked against the live function on 09 Oct 2026:

```
no Authorization header   -> {"error":"missing Authorization header"}
the CRM's real anon key   -> {"error":"sign in to the CRM to run this"}
```

Any logged-in CRM user may run it (decided 06 Oct 2026).

## Attribution

Every prod read is audited server-side into `ops_query_read_tracker`. Because
this function carries one NeuronOps account, that audit shows **the account, not
the person who clicked**. The function therefore logs the caller's email and
returns it alongside the `queryId`s — the two together are what make a run
attributable. If that is not good enough, the fix is a NeuronOps account per
caller, not a change here.

## Files

| File | |
|---|---|
| `index.ts` | HTTP entry point: auth, dispatch, response |
| `prodQuery.ts` | token + `/api/neuronops/query`, paged |
| `jobs.ts` | the jobs; add one here and `index.ts` does not change |

## Jobs

| Job | Reads | Writes | Port of |
|---|---|---|---|
| `work_locations` | `employer_organization` ⋈ `emp_work_location` | `client_work_locations` | `populate_work_locations.py` |
| `api_activity` | `onboarding_automation_history` | `api_activity_runs` | `rebuild_matrix_from_prod.py` + `load_api_activity.py` |

**`work_locations`**, verified against prod 06 Oct 2026: 192 rows in 19ms, and
the mapping reproduced the live table exactly — 0 added, 0 removed. One DSP
(KVLO) has a fein but no work locations in prod; reported, not an error.

**`api_activity`**, verified 08 Oct 2026 by running the real job with only
`fetch` stubbed, over all 1467 prod runs, and diffing against what the Python
pipeline had put in the table:

```
rows: job 344  |  table 349
only in job   : 1   844786770|EmployeeCensus     <- the YEXP fix
only in table : 6   ...|SocCode                  <- stale, see below
field diffs on shared rows: 0
```

It also drops the two TSV files the Python passed between its halves. Those
existed because the data used to come from a hand-downloaded CSV export; going
straight from prod to Supabase removes the whole "the file on disk is stale"
class of problem.

The 6 leftover `SocCode` rows predate this and are harmless: that module was
deliberately dropped from the display, and `site/index.html` keeps its own
module list, so they are invisible on the dashboard. Nothing here deletes them.

Still to port, all the same shape: `backfill_fein`, `populate_data_coverage`,
`populate_load_history`, `populate_document_counts`, `populate_system_activity`.

## Who the prod audit records

Each prod read is audited server-side into `ops_query_read_tracker` under the
function's own account, not the person who pressed the button.

The intended design was the one in the audit tool's `utils/neuronops_client.py`
— each user signs in with their own credentials, so their name is what the audit
records and no shared credential exists anywhere. It does not work here, and the
reason is worth writing down so nobody re-tries it:

```
OPTIONS /api/neuronops/query   -> 200, allows authorization + x-auth-type
OPTIONS /app/onboarding/query  -> 403
OPTIONS /app/onboarding/token  -> 403
```

NeuronOps permits a browser preflight; the onboarding backend refuses it. API
activity lives on the onboarding backend, so that half must run server-side
under one account. The compensation is that `index.ts` records the caller's
email on every run — prod's audit says *what* was read, ours says *who* asked —
and the upside is that the button works for people with no Uzio ops login at
all, which is what it was asked to do.

## Deploy

No local install needed — `npx` is enough, and the "Docker is not running"
warning the CLI prints is not the deploy failing. Run from the repo root, where
`supabase/functions/` lives.

```bash
npx supabase@latest login
npx supabase@latest functions deploy prod-refresh --project-ref <our-project-ref>
```

Then the secrets, which are never committed:

```bash
npx supabase@latest secrets set --project-ref <our-project-ref> \
  NEURONOPS_USERNAME=... \
  NEURONOPS_PASSWORD=... \
  ONBOARDING_USERNAME=... \
  ONBOARDING_PASSWORD=... \
  ONBOARDING_FEIN=... \
  DASH_URL=https://<our-project-ref>.supabase.co \
  DASH_SERVICE_KEY=sb_secret_... \
  CRM_AUTH_URL=https://<crm-project-ref>.supabase.co \
  CRM_ANON_KEY=<the CRM's anon/publishable key>
```

`CRM_AUTH_URL` and `CRM_ANON_KEY` are what let the function run here and still
accept CRM logins — see **Where it lives**. The anon key is not a secret worth
guarding; it is already in the CRM's own frontend, and on its own it does not
get past the `getUser` check.

The `ONBOARDING_*` three are a separate login for a separate system — the
values in `_secrets/onboarding-creds.json`, not the NeuronOps ones. Any valid
fein works for `ONBOARDING_FEIN`; the token endpoint wants one but it does not
scope or filter results. Leave all three out and the NeuronOps jobs still run —
`api_activity` then fails on its own and says which secrets are missing,
without taking the other jobs down.

`SUPABASE_URL` and `SUPABASE_ANON_KEY` are injected by the platform — do not set
them yourself.

The deploy is also the first real typecheck: this was written without Deno or
the Supabase CLI on the machine, so a type error will surface there rather than
earlier.

## Use

```bash
# dry run first - reads prod, writes nothing
curl -X POST 'https://<our-project-ref>.supabase.co/functions/v1/prod-refresh' \
  -H "Authorization: Bearer $CRM_USER_SESSION_JWT" \
  -H 'Content-Type: application/json' \
  -d '{"jobs":["work_locations"],"dryRun":true}'
```

Drop `dryRun` to write. `jobs` omitted runs everything.

From the CRM frontend the session token is already to hand:

```js
// NOT CONFIG.SUPABASE_URL. The session comes from the CRM's project, the
// function is deployed in ours, and the call goes to ours.
const PROD_REFRESH = 'https://<our-project-ref>.supabase.co/functions/v1/prod-refresh'

const { data: { session } } = await supabase.auth.getSession()
const res = await fetch(PROD_REFRESH, {
  method: 'POST',
  headers: { Authorization: `Bearer ${session.access_token}`,
             'Content-Type': 'application/json' },
  body: JSON.stringify({ jobs: ['api_activity'] }),
})
```

A partial failure answers **207** with the per-job detail, not 500: one job
failing must not hide the ones that worked.

## Two things that are deliberate

- **The token is not cached.** NeuronOps allows a single session per account, so
  caching would mean parking a live prod-read bearer token at rest to save about
  one second. The side effect is real: every run evicts the token cached by the
  local `pq_helper`, which simply re-mints. A separate NeuronOps account for
  this function removes the collision.
- **A job refuses to empty its table on an empty prod result.** PostgREST gives
  no transaction, so `work_locations` reads all of prod before deleting
  anything. An empty read is far more likely to be a changed schema than every
  client losing every location on the same day, so it raises instead.
