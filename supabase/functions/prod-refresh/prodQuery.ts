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
