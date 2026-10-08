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
| Function runs in | the **CRM** project |
| Writes into | **our dashboard** project |

The function sits in the CRM project because that is where the login already
is. A CRM user's session token is issued by that project, so only a function in
that project can verify it. Putting the function in our project instead would
mean turning `verify_jwt` off and inventing a shared secret for the CRM frontend
to hold — a secret in a browser, which is the thing this arrangement avoids.

The cost of that choice, stated plainly: **our `sb_secret_` key lives as a
secret on a function in the CRM project.** Anyone who administers that project
can read it.

## Auth: `verify_jwt` alone is not enough

The trap worth knowing before anyone changes this file:

> A Supabase project's anon/publishable key **is itself a valid JWT** for that
> project. It sits in the CRM's frontend, where anyone can read it out of
> devtools. A function that relies only on `verify_jwt` is open to the public.

So `index.ts` resolves the caller's token to a real user with `auth.getUser()`
and rejects anything that does not resolve. The anon key passes `verify_jwt` and
fails *that*. Do not remove it.

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

Needs the Supabase CLI and access to the CRM project.

```bash
supabase functions deploy prod-refresh --project-ref <crm-project-ref>
```

Then the secrets, which are never committed:

```bash
supabase secrets set --project-ref <crm-project-ref> \
  NEURONOPS_USERNAME=... \
  NEURONOPS_PASSWORD=... \
  ONBOARDING_USERNAME=... \
  ONBOARDING_PASSWORD=... \
  ONBOARDING_FEIN=... \
  DASH_URL=https://<our-project-ref>.supabase.co \
  DASH_SERVICE_KEY=sb_secret_...
```

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
curl -X POST 'https://<crm-project-ref>.supabase.co/functions/v1/prod-refresh' \
  -H "Authorization: Bearer $CRM_USER_SESSION_JWT" \
  -H 'Content-Type: application/json' \
  -d '{"jobs":["work_locations"],"dryRun":true}'
```

Drop `dryRun` to write. `jobs` omitted runs everything.

From the CRM frontend the session token is already to hand:

```js
const { data: { session } } = await supabase.auth.getSession()
const res = await fetch(`${SUPABASE_URL}/functions/v1/prod-refresh`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${session.access_token}`,
             'Content-Type': 'application/json' },
  body: JSON.stringify({ jobs: ['work_locations'] }),
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
