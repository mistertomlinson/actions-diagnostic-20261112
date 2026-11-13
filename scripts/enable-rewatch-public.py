#!/usr/bin/env python3
"""Open only the existing Nuvio replay site after pinned-service checks.

Requires root on the user's VPS and REWATCH_ALLOWED_CLIENT_IDS, a comma-separated
list of public Simkl OAuth application IDs. Does not read or print tokens.
Backs up Caddy and restores both service config and site on failure.
"""
import os
import re
import pathlib
import shutil
import tempfile
import datetime
import subprocess as sp

HOST = "nuviorewatch.duckdns.org"
SERVICE = "nuvio-rewatch-staging.service"
CADDY = pathlib.Path("/etc/caddy/Caddyfile")
DROP = pathlib.Path(
    "/etc/systemd/system/nuvio-rewatch-staging.service.d/30-simkl-bootstrap.conf"
)
DB = "/var/lib/nuvio-rewatch-staging/simkl-replay-tokens.json"

class Stop(Exception):
    pass

def run(*args):
    p = sp.run(args, capture_output=True, text=True)
    if p.returncode:
        raise Stop(f"COMMAND_FAILED={args[0]}:{args[1] if len(args) > 1 else ''}")
    return p.stdout.strip()

def status(url, body=None, local_caddy=False):
    args = ["curl", "--noproxy", "*", "-sS", "--max-time", "8",
            "-o", "/dev/null", "-w", "%{http_code}"]
    if local_caddy:
        args += ["--resolve", f"{HOST}:443:127.0.0.1"]
    if body is not None:
        args += ["-H", "Content-Type: application/json", "--data", body]
    return run(*(args + [url]))

def replace_guard(source):
    pat = re.compile(
        r"(?m)^[ \t]*(?:https://)?nuviorewatch\.duckdns\.org[ \t]*\{[ \t]*(?:#.*)?$"
    )
    matches = list(pat.finditer(source))
    if len(matches) != 1:
        raise Stop(f"CADDY_SITE_COUNT={len(matches)}")
    m = matches[0]
    brace = source.index("{", m.start(), m.end())
    depth = 0
    end = None
    for pos in range(brace, len(source)):
        if source[pos] == "{":
            depth += 1
        elif source[pos] == "}":
            depth -= 1
            if depth == 0:
                end = pos + 1
                break
    if end is None:
        raise Stop("CADDY_SITE_UNCLOSED")
    body = source[brace + 1:end - 1]
    actual = [line.strip() for line in body.splitlines()
              if line.strip() and not line.lstrip().startswith("#")]
    if len(actual) != 1 or not re.fullmatch(
        r'respond\s+(?:503|"[^"\n]+"\s+503)', actual[0]
    ):
        raise Stop("CADDY_SITE_NOT_SIMPLE_503_GUARD")
    replacement = """nuviorewatch.duckdns.org {
    @rewatch_api path /v1/rewatches /v1/rewatches/* /v1/simkl/bootstrap /v1/simkl/revoke
    handle @rewatch_api {
        reverse_proxy 127.0.0.1:8765
    }
    handle {
        respond 404
    }
}"""
    return source[:m.start()] + replacement + source[end:]

backup = None
unit_changed = False
site_changed = False
completed = False
prepared = None
try:
    if os.geteuid() != 0:
        raise Stop("RUN_AS_ROOT_WITH_SUDO")
    ids = os.environ.get("REWATCH_ALLOWED_CLIENT_IDS", "").split(",")
    if not ids or any(not re.fullmatch(r"[A-Za-z0-9_-]{6,200}", x) for x in ids):
        raise Stop("MISSING_OR_INVALID_SIMKL_APP_IDS")
    if len(ids) != len(set(ids)):
        raise Stop("DUPLICATE_SIMKL_APP_IDS")
    if run("systemctl", "is-active", SERVICE) != "active":
        raise Stop("SERVICE_NOT_ACTIVE")
    if run("systemctl", "is-enabled", SERVICE) != "disabled":
        raise Stop("SERVICE_AUTOSTART_UNEXPECTED")
    if run("systemctl", "show", SERVICE, "-p", "User", "--value") != "nuvio-rewatch":
        raise Stop("SERVICE_USER_UNEXPECTED")
    if run("systemctl", "show", SERVICE, "-p", "WorkingDirectory", "--value") != \
            "/opt/nuvio-rewatch-staging/services/rewatch-sync":
        raise Stop("SERVICE_WORKDIR_UNEXPECTED")
    if run("systemctl", "is-active", "caddy") != "active":
        raise Stop("CADDY_NOT_ACTIVE")
    if CADDY.is_symlink() or not CADDY.is_file():
        raise Stop("CADDYFILE_UNEXPECTED")
    if DROP.exists():
        raise Stop("SIMKL_DROPIN_ALREADY_EXISTS")
    if "REWATCH_SIMKL_BOOTSTRAP=1" in run(
        "systemctl", "show", SERVICE, "-p", "Environment", "--value"
    ):
        raise Stop("BOOTSTRAP_ALREADY_ENABLED")
    local = "http://127.0.0.1:8765/v1/rewatches"
    public = f"https://{HOST}/v1/rewatches"
    if status(local) != "401" or status(public, local_caddy=True) != "503":
        raise Stop("BASELINE_HTTP_UNEXPECTED")
    if not re.search(r"127\.0\.0\.1:8765\s", run("ss", "-lnt")):
        raise Stop("NO_LOOPBACK_LISTENER")
    original = CADDY.read_text()
    proposed = replace_guard(original)
    prepared = pathlib.Path(tempfile.mkstemp(
        prefix=".rewatch-caddy.", dir=str(CADDY.parent)
    )[1])
    shutil.copymode(CADDY, prepared)
    prepared.write_text(proposed)
    run("caddy", "validate", "--config", str(prepared), "--adapter", "caddyfile")
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup = pathlib.Path("/root") / ("rewatch-public-rollback-" + stamp)
    backup.mkdir(mode=0o700)
    shutil.copy2(CADDY, backup / "Caddyfile")

    DROP.parent.mkdir(parents=True, exist_ok=True)
    content = ("[Service]\n"
               "Environment=REWATCH_SIMKL_BOOTSTRAP=1\n"
               "Environment=REWATCH_SIMKL_CLIENT_IDS=" + ",".join(ids) + "\n"
               "Environment=REWATCH_SIMKL_CREDENTIALS_DB_PATH=" + DB + "\n")
    tmpdrop = DROP.parent / ".rewatch-bootstrap.new"
    tmpdrop.write_text(content)
    os.chmod(tmpdrop, 0o644)
    tmpdrop.replace(DROP)
    unit_changed = True
    run("systemctl", "daemon-reload")
    run("systemctl", "restart", SERVICE)
    if run("systemctl", "is-active", SERVICE) != "active":
        raise Stop("SERVICE_RESTART_FAILED")
    env = run("systemctl", "show", SERVICE, "-p", "Environment", "--value")
    if "REWATCH_SIMKL_BOOTSTRAP=1" not in env or \
            "REWATCH_SIMKL_CLIENT_IDS=" not in env:
        raise Stop("BOOTSTRAP_ENV_NOT_LOADED")

    # Invalid installationId produces 400 only when bootstrap handler is active.
    invalid = '{"installationId":"invalid","clientId":"invalid"}'
    if status("http://127.0.0.1:8765/v1/simkl/bootstrap", body=invalid) != "400":
        raise Stop("BOOTSTRAP_ROUTE_NOT_ACTIVE")

    prepared.replace(CADDY)
    prepared = None
    site_changed = True
    run("caddy", "validate", "--config", str(CADDY), "--adapter", "caddyfile")
    run("systemctl", "reload", "caddy")
    if status(public, local_caddy=True) != "401" or \
            status(f"https://{HOST}/v1/simkl/bootstrap",
                   body=invalid, local_caddy=True) != "400" or \
            status(f"https://{HOST}/", local_caddy=True) != "404" or \
            status(local) != "401":
        raise Stop("PUBLIC_HTTP_CHECK_FAILED")
    if run("systemctl", "is-enabled", SERVICE) != "disabled":
        raise Stop("SERVICE_AUTOSTART_CHANGED")
    completed = True
    print("REWATCH_PUBLIC_HTTPS=ENABLED")
    print("UNAUTHENTICATED_READ=401")
    print("INVALID_BOOTSTRAP=400")
    print("UNKNOWN_PATH=404")
    print("SIMKL_BOOTSTRAP=ENABLED")
    print("ALLOWED_SIMKL_APP_IDS=" + str(len(ids)))
    print("STAGING_SERVICE=ACTIVE")
    print("STAGING_AUTOSTART=DISABLED")
    print("CADDY_RELOAD=PASS")
    print("ROLLBACK_BACKUP=" + str(backup))
    print("RESULT=REWATCH_PUBLIC_HTTPS_READY")
except Exception as exc:
    print("STOP=" + str(exc).replace("\n", " ")[:200])
finally:
    if not completed and (site_changed or unit_changed):
        try:
            if site_changed and backup and (backup / "Caddyfile").is_file():
                shutil.copy2(backup / "Caddyfile", CADDY)
                run("systemctl", "reload", "caddy")
            if unit_changed:
                DROP.unlink(missing_ok=True)
                run("systemctl", "daemon-reload")
                run("systemctl", "restart", SERVICE)
            print("ROLLBACK=RESTORED")
        except Exception:
            print("ROLLBACK=INCOMPLETE_MANUAL_CHECK_REQUIRED")
    if prepared:
        try:
            prepared.unlink(missing_ok=True)
        except Exception:
            pass
    if not completed:
        print("RESULT=NOT_DEPLOYED")
        raise SystemExit(1)
