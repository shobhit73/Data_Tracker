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
| `work_locations` | `employer_organization` ⋈ `emp_work_location` | `client_work_locations` | `scripts/populate_work_locations.py` |

Verified against prod on 06 Oct 2026 before any of this was wired up — the
query returned 192 rows in 19ms and the job's mapping reproduced the live
`client_work_locations` table exactly, 0 rows added and 0 removed. One DSP
(KVLO) has a fein but no work locations in prod; that is reported, not an error.

Still to port, all following the same shape: `backfill_fein`,
`populate_data_coverage`, `populate_load_history`, `populate_document_counts`,
`populate_system_activity`, and Step 4b's API activity — which goes to a
*different* backend (`/app/onboarding/query`, header `AuthorizationHeader` with
no `Bearer` prefix and no `X-Auth-Type`). Sending NeuronOps' headers there
returns `401 Invalid API key`.

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
  DASH_URL=https://<our-project-ref>.supabase.co \
  DASH_SERVICE_KEY=sb_secret_...
```

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
