/**
 * The NeuronOps /query endpoint, from Deno.
 *
 * Port of scripts/pq_helper.py. The whole reason this is possible is that
 * `api.uzio.com` is public CloudFront (13.35.78.x) and answers without the
 * VPN -- only `*.internal.hcphix.com` (10.40.x) is private. The task doc said
 * these steps "need the VPN" for a year; they never did.
 *
 * READ-ONLY BY CONTRACT, not by our good manners. The server runs QueryGuard
 * plus a Postgres read-only transaction and rejects anything that is not a
 * single SELECT/WITH, so no SQL sent through here can write to prod whatever
 * it says. That is a property of the endpoint, not of this file.
 *
 * WHAT THIS FILE CANNOT PROMISE
 *   The credential is a NeuronOps login, and /query is only one of the things
 *   NeuronOps exposes. "Read-only" is true of this endpoint; it is not a
 *   statement about everything that account can reach. Worth confirming once
 *   with whoever owns NeuronOps rather than assuming.
 *
 * EVERY READ IS AUDITED. The server logs who/sql/rowcount/data to
 * ops_query_read_tracker and returns a queryId. Because this function holds
 * one set of credentials, every read triggered from the CRM is attributed to
 * THAT account, whoever clicked. The response carries the queryIds so a run
 * can be tied back to its rows.
 */

const GATEWAY = 'https://api.uzio.com';

export interface QueryResult {
  rows: Record<string, unknown>[];
  queryIds: string[];
  tookMs: number;
}

/**
 * Mint a fresh token. Deliberately NOT cached.
 *
 * NeuronOps allows a single session per (user, env): a fresh token evicts the
 * previous one for the same account. Caching it would mean parking a live
 * prod-read bearer token at rest somewhere, to save one ~1s call. Not worth
 * it. The side effect is real and worth knowing: every run here evicts the
 * token cached by the local prod-query tooling, which simply re-mints. A
 * separate NeuronOps account for this function removes the collision.
 */
async function mintToken(username: string, password: string): Promise<string> {
  const res = await fetch(`${GATEWAY}/api/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    // Never echo the body: a failed auth response can repeat what was sent.
    throw new Error(`NeuronOps token call failed: HTTP ${res.status}`);
  }
  const body = await res.json();
  if (!body?.token) throw new Error('NeuronOps token call returned no token');
  return body.token as string;
}

/**
 * Run one SELECT and return every row.
 *
 * Pages until hasMore is false. The server wraps the SQL in its own
 * LIMIT/OFFSET and cannot inject an ORDER BY, so a query without one has
 * undefined page boundaries -- every SQL passed here carries its own.
 */
export async function prodQuery(
  sql: string,
  opts: { username: string; password: string; size?: number } ,
): Promise<QueryResult> {
  const size = Math.min(opts.size ?? 1000, 5000);   // server hard-caps at 5000
  const token = await mintToken(opts.username, opts.password);

  const rows: Record<string, unknown>[] = [];
  const queryIds: string[] = [];
  let tookMs = 0;

  for (let page = 0; ; page++) {
    const res = await fetch(`${GATEWAY}/api/neuronops/query`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        // Mandatory. Without it the request falls into the Phix API-key
        // filter and comes back 401 "Invalid API key" rather than anything
        // that points at the real problem.
        'X-Auth-Type': 'bearer',
      },
      body: JSON.stringify({ sql, page, size }),
    });

    if (!res.ok) {
      const text = (await res.text()).slice(0, 300);
      throw new Error(`prod-query page ${page} -> HTTP ${res.status}: ${text}`);
    }
    const body = await res.json();
    rows.push(...(body.data ?? []));
    if (body?._meta?.queryId) queryIds.push(body._meta.queryId);
    tookMs += body?._meta?.tookMs ?? 0;

    if (!body.hasMore) return { rows, queryIds, tookMs };
    if (page > 200) throw new Error('prod-query paged past 200 pages, refusing to continue');
  }
}

/** `'` doubled, for building an IN list. The endpoint also takes positional
 *  `?` params, but not inside an IN list of unknown length. */
export function sqlList(values: string[]): string {
  return values.map((v) => `'${String(v).replace(/'/g, "''")}'`).join(',');
}

/* ======================================================================
 * The ONBOARDING /query endpoint (PHIX-98714)
 *
 * A sibling of the above, not the same thing, and copying the NeuronOps
 * headers here returns `401 Invalid API key` -- which is how an hour went
 * missing the first time. Three differences, all load-bearing:
 *
 *   * path    /app/onboarding/...        not /api/neuronops/...
 *   * header  AuthorizationHeader: <jwt> raw, no "Bearer ", no X-Auth-Type
 *   * /token  wants a `fein` as well as username and password. Any valid fein
 *             for the env works; it does NOT scope or filter the results.
 *
 * It also answers HTTP 200 with {"token": null, "error": ...} on bad
 * credentials, so a 200 is not success -- the token has to be there.
 *
 * WHY THIS CANNOT USE THE CALLER'S OWN LOGIN
 *   The plan was for each CRM user to sign in with their own Uzio credentials,
 *   so prod's audit would record the actual person (the pattern in the audit
 *   tool's utils/neuronops_client.py). A browser cannot reach this backend:
 *
 *       OPTIONS /api/neuronops/query   -> 200, allows authorization + x-auth-type
 *       OPTIONS /app/onboarding/query  -> 403
 *       OPTIONS /app/onboarding/token  -> 403
 *
 *   NeuronOps allows the preflight; onboarding refuses it. So this half has to
 *   run server-side under one account, and who pressed the button is recorded
 *   on our side (index.ts logs the caller) rather than in prod's audit. The
 *   upside is that it works for people with no Uzio ops login at all, which is
 *   what the button was asked to do.
 *
 * Tables live in the `prod_onboarding_db` schema, which is the search_path, so
 * unqualified names work. `deleted` is NULL rather than 0 on every row -- a
 * `where deleted = 0` silently returns nothing.
 * ====================================================================== */

async function onboardingToken(
  username: string, password: string, fein: string,
): Promise<string> {
  const res = await fetch(`${GATEWAY}/app/onboarding/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, fein }),
  });
  if (!res.ok) throw new Error(`onboarding token call failed: HTTP ${res.status}`);
  const body = await res.json();
  // 200 with a null token is how this endpoint says "wrong credentials".
  if (!body?.token) throw new Error('onboarding token call returned no token');
  return body.token as string;
}

export async function onboardingQuery(
  sql: string,
  opts: { username: string; password: string; fein: string; size?: number },
): Promise<QueryResult> {
  const size = Math.min(opts.size ?? 500, 5000);
  const token = await onboardingToken(opts.username, opts.password, opts.fein);

  const rows: Record<string, unknown>[] = [];
  const queryIds: string[] = [];
  let tookMs = 0;

  for (let page = 0; ; page++) {
    const res = await fetch(`${GATEWAY}/app/onboarding/query`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'AuthorizationHeader': token,   // raw, no Bearer -- see the header above
      },
      body: JSON.stringify({ sql, page, size }),
    });
    if (!res.ok) {
      const text = (await res.text()).slice(0, 300);
      throw new Error(`onboarding query page ${page} -> HTTP ${res.status}: ${text}`);
    }
    const body = await res.json();
    rows.push(...(body.data ?? []));
    if (body?._meta?.queryId) queryIds.push(body._meta.queryId);
    tookMs += body?._meta?.tookMs ?? 0;

    if (!body.hasMore) return { rows, queryIds, tookMs };
    if (page > 200) throw new Error('onboarding query paged past 200 pages, stopping');
  }
}
