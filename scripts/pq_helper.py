import json, base64, time, urllib.request, sys

MEM = r"C:/Users/shobhit.sharma/.claude/projects/C--Users-shobhit-sharma-Downloads-Uzio-Code/memory"
GATEWAY = "https://api.uzio.com"
CREDS_FILE = MEM + "/_secrets/neuronops-creds.json"
JWT_FILE = MEM + "/_secrets/neuronops-jwt.json"

def post(url, body, headers):
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST")
    req.add_header("Content-Type", "application/json")
    for k, v in headers.items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:800]

def get_jwt():
    try:
        d = json.load(open(JWT_FILE))
        e = d.get('prod', {})
        if e.get('exp', 0) - 60 > time.time():
            return e['token']
    except Exception:
        pass
    c = json.load(open(CREDS_FILE))['prod']
    status, body = post(GATEWAY + "/api/auth/token", {"username": c['username'], "password": c['password']}, {})
    if status != 200:
        print("Token call failed:", status, body); sys.exit(1)
    t = body['token']
    p = t.split('.')[1]; p += '=' * ((4 - len(p) % 4) % 4)
    exp = json.loads(base64.urlsafe_b64decode(p))['exp']
    try: d = json.load(open(JWT_FILE))
    except Exception: d = {}
    d['prod'] = {'token': t, 'exp': exp}
    json.dump(d, open(JWT_FILE, 'w'), indent=2)
    return t

def run(sql, size=200):
    jwt = get_jwt()
    status, body = post(GATEWAY + "/api/neuronops/query", {"sql": sql, "size": size},
                        {"Authorization": "Bearer " + jwt, "X-Auth-Type": "bearer"})
    print("HTTP", status)
    if status == 200:
        rows = body['data']
        print("rows:", len(rows), "tookMs:", body.get('_meta', {}).get('tookMs'), "hasMore:", body.get('hasMore'))
        for r in rows:
            print(json.dumps(r))
    else:
        print(body)
    return status, body

if __name__ == "__main__":
    sql = sys.argv[1] if len(sys.argv) > 1 else "select 1"
    run(sql)
