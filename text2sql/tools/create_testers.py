"""Create accounts for a trial group from a spreadsheet (CSV) - companies, people, roles and a shared AI model.

    py -3.14 tools\\create_testers.py testers.csv --url http://127.0.0.1:8000 --admin you@example.com
    py -3.14 tools\\create_testers.py testers.csv --dry-run            (shows the plan, changes nothing)

testers.csv has a header row and these columns (only email is required):
    email,name,company,role,results_only
    ana@partner.example,Ana Partner,Partner Trial,admin,
    ben@partner.example,Ben Partner,Partner Trial,analyst,yes
    cara@other.example,Cara Other,,analyst,           <- blank company = your own company

  company       created (with the sample data models) if it does not exist yet. Needs a platform administrator.
  role          analyst (default), steward or admin
  results_only  yes = the person sees results only, never SQL or code (analysts only)

Run it on the machine that hosts AskData, against the LOCAL address (http://127.0.0.1:8000), not through the public
address: a tunnel with an access gate in front of it will rightly refuse a script. It writes
testers-credentials-<date>.csv with each person's one-time password - give each person theirs privately, then delete the file.
Only the Python standard library is used; nothing is installed. Running it twice is safe: people who exist are skipped.
"""
import argparse
import csv
import datetime as dt
import getpass
import json
import os
import sys
import urllib.error
import urllib.request

ROLES = ("analyst", "steward", "admin")


class ApiError(Exception):
    def __init__(self, status, detail):
        super().__init__(f"{status}: {detail}")
        self.status, self.detail = status, detail


class HttpApi:
    """Talks to a running AskData over HTTP. Cookies are handled by hand so that a server started with
    T2S_COOKIE_SECURE=1 still works over http://127.0.0.1 (the usual way to run this on the server itself)."""

    def __init__(self, base):
        self.base, self.cookies = base.rstrip("/"), {}

    def call(self, method, path, body=None):
        req = urllib.request.Request(self.base + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                     headers={"X-Requested-With": "fetch", "Content-Type": "application/json",
                                              "Cookie": "; ".join(f"{k}={v}" for k, v in self.cookies.items())})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                for raw in r.headers.get_all("Set-Cookie") or []:
                    name, _, rest = raw.partition("=")
                    value = rest.split(";", 1)[0]
                    if value in ("", '""') or "Max-Age=0" in raw:
                        self.cookies.pop(name, None)
                    else:
                        self.cookies[name] = value
                text = r.read().decode()
                return json.loads(text) if text else {}
        except urllib.error.HTTPError as e:
            try:
                detail = json.loads(e.read().decode()).get("detail", "")
            except Exception:
                detail = ""
            raise ApiError(e.code, detail or e.reason)
        except urllib.error.URLError as e:
            raise SystemExit(f"Cannot reach {self.base} - is AskData running? ({e.reason})")


def sign_in(api, email, password, code=None):
    out = api.call("POST", "/api/auth/login", {"email": email, "password": password})
    if out.get("step") == "mfa":
        api.call("POST", "/api/auth/mfa", {"code": code or input("Your two-factor code (or a recovery code): ").strip()})
    me = api.call("GET", "/api/auth/me")
    if me.get("role") != "admin":
        raise SystemExit("This account is not an administrator.")
    return me


def read_rows(path):
    """Validated rows from the CSV; raises ValueError with a line number for the first problem."""
    rows, seen = [], set()
    with open(path, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        if not reader.fieldnames or "email" not in [h.strip().lower() for h in reader.fieldnames]:
            raise ValueError("The first row must be a header with at least the column: email")
        for n, raw in enumerate(reader, start=2):
            r = {(k or "").strip().lower(): (v or "").strip() for k, v in raw.items()}
            if not any(r.values()):
                continue
            email = r.get("email", "").lower()
            if "@" not in email or " " in email:
                raise ValueError(f"Line {n}: '{email}' is not an email address")
            if email in seen:
                raise ValueError(f"Line {n}: {email} appears twice")
            seen.add(email)
            role = (r.get("role") or "analyst").lower()
            if role not in ROLES:
                raise ValueError(f"Line {n}: role must be one of {', '.join(ROLES)} (got '{role}')")
            results_only = (r.get("results_only") or "").lower() in ("yes", "y", "true", "1", "x")
            if results_only and role != "analyst":
                raise ValueError(f"Line {n}: results_only only applies to analysts")
            rows.append({"email": email, "name": r.get("name", ""), "company": r.get("company", ""), "role": role, "results_only": results_only})
    if not rows:
        raise ValueError("The file has no people in it")
    return rows


def provision(api, rows, share_model=None, dry_run=False, log=print):
    """Create what is missing. api needs .call(method, path, body) raising ApiError. Returns one result dict per row."""
    me = api.call("GET", "/api/auth/me") if not dry_run else {"is_platform_admin": True, "company": {"id": 0, "name": "your own company"}}
    own = (me.get("company") or {}).get("name", "your own company")
    wanted = sorted({r["company"] for r in rows if r["company"]}, key=str.lower)
    if wanted and not me.get("is_platform_admin"):
        raise SystemExit("Companies can only be created by a platform administrator. Sign in as one, or leave the company column blank.")
    companies = {}
    if not dry_run and wanted:
        companies = {c["name"].lower(): c for c in api.call("GET", "/api/admin/companies")}
    for name in wanted:
        if name.lower() in companies:
            log(f"company  {name}: exists")
        elif dry_run:
            log(f"company  {name}: would be created, with the sample data models")
        else:
            made = api.call("POST", "/api/admin/companies", {"name": name, "samples": True})
            companies[name.lower()] = made
            log(f"company  {name}: created")
    results = []
    for r in rows:
        where = r["company"] or own
        res = {**r, "company": where, "status": "", "temporary_password": ""}
        if dry_run:
            res["status"] = "would be created"
        else:
            body = {"email": r["email"], "name": r["name"], "role": r["role"], "show_sql": not r["results_only"]}
            try:
                if r["company"]:
                    out = api.call("POST", f"/api/admin/companies/{companies[r['company'].lower()]['id']}/users", body)
                else:
                    out = api.call("POST", "/api/admin/users", body)
                res["status"], res["temporary_password"] = "created", out.get("temporary_password", "")
            except ApiError as e:
                res["status"] = "skipped - already exists" if "already exists" in e.detail else f"FAILED - {e.detail}"
        results.append(res)
        log(f"person   {r['email']:<36} {where:<24} {r['role']:<8}{' results only' if r['results_only'] else ''}  -> {res['status']}")
    for name in wanted:                                     # every company needs somebody who can manage it
        if not any(r["company"] == name and r["role"] == "admin" for r in rows):
            log(f"note     {name} has no administrator in this file (only you, as platform administrator, can manage it)")
    if share_model:
        models = (api.call("GET", "/api/admin/models") if not dry_run else {"platform": [{"id": 0, "name": share_model, "shared_companies": [], "share_all": False}]}).get("platform", [])
        model = next((m for m in models if m["name"].lower() == share_model.lower()), None)
        if not model:
            raise SystemExit(f"No shared (platform) AI model named '{share_model}'. Add one under Admin > AI models > Platform models first.")
        if dry_run:
            log(f"model    '{share_model}' would be shared with {', '.join(wanted) or 'no new company'}")
        elif model.get("share_all"):
            log(f"model    '{share_model}' is already shared with all companies")
        else:
            ids = sorted(set(model.get("shared_companies") or []) | {companies[n.lower()]["id"] for n in wanted})
            api.call("PUT", f"/api/admin/models/{model['id']}/sharing", {"share_all": False, "company_ids": ids})
            log(f"model    '{share_model}' shared with {len(ids)} company(ies) in total")
    return results


def write_credentials(results, sign_in_url, folder="."):
    path = os.path.join(folder, f"testers-credentials-{dt.date.today().isoformat()}.csv")
    made = [r for r in results if r["temporary_password"]]
    if not made:
        return None
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["email", "name", "company", "role", "temporary_password", "sign_in_url"])
        for r in made:
            w.writerow([r["email"], r["name"], r["company"], r["role"], r["temporary_password"], sign_in_url])
    return path


def main(argv=None):
    p = argparse.ArgumentParser(description="Create accounts for a trial group from a CSV file.")
    p.add_argument("csv", help="the people to create (see the top of this file)")
    p.add_argument("--url", default="http://127.0.0.1:8000", help="where AskData runs; use the local address (default %(default)s)")
    p.add_argument("--admin", help="your administrator email")
    p.add_argument("--code", help="your two-factor code, if you do not want to be asked")
    p.add_argument("--share-model", metavar="NAME", help="share this platform AI model with the companies in the file")
    p.add_argument("--public-url", default="", help="the address testers use, written into the credentials file")
    p.add_argument("--dry-run", action="store_true", help="show what would happen and change nothing")
    a = p.parse_args(argv)
    try:
        rows = read_rows(a.csv)
    except (OSError, ValueError) as e:
        sys.exit(f"{a.csv}: {e}")
    api = HttpApi(a.url)
    if not a.dry_run:
        email = a.admin or input("Your administrator email: ").strip()
        password = os.environ.get("T2S_ADMIN_PASSWORD") or getpass.getpass("Your password (nothing shows as you type): ")
        try:
            sign_in(api, email, password, a.code)
        except ApiError as e:
            sys.exit(f"Could not sign in: {e.detail}")
    try:
        results = provision(api, rows, a.share_model, a.dry_run)
    except ApiError as e:
        sys.exit(f"Stopped: {e.detail}")
    if a.dry_run:
        print("\nDry run - nothing was changed.")
        return
    path = write_credentials(results, a.public_url or a.url + "/")
    print(f"\n{sum(r['status'] == 'created' for r in results)} created, {sum(r['status'].startswith('skipped') for r in results)} skipped, "
          f"{sum(r['status'].startswith('FAILED') for r in results)} failed.")
    if path:
        print(f"One-time passwords are in {path}\nGive each person theirs privately (not all in one message), then DELETE that file.")


if __name__ == "__main__":
    main()
