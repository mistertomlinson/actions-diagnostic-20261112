#!/usr/bin/env bash
# Provision the EXISTING Nuvio iOS test-build's expected repository Actions
# secret from local Mac configuration and trigger its isolated Release build.
# No secrets are echoed, committed to git, or posted in Actions logs.
set -euo pipefail
umask 077
REPO="mistertomlinson/NuvioMobile"
BRANCH="test/rewatch-public-https-20261112"
SECRET="NUVIO_LOCAL_PROPERTIES_BASE64"

if ! command -v gh >/dev/null 2>&1; then
  echo "STOP=GITHUB_CLI_MISSING"
  echo "INSTALL_COMMAND=brew install gh"
  exit 1
fi
if ! gh auth status -h github.com >/dev/null 2>&1; then
  echo "STOP=GITHUB_CLI_NOT_AUTHENTICATED"
  echo "LOGIN_COMMAND=gh auth login"
  exit 1
fi

config="$(mktemp /tmp/nuvio-ios-actions-config.XXXXXX)"
trap 'rm -f "$config"' EXIT

python3 - "$config" <<'PY'
from pathlib import Path
import re
import sys

home=Path.home()
tv_sources=[
    home/"Developer/NuvioTV_OfficialBeta_Port/local.properties",
    home/"Developer/NuvioTV/local.properties",
    home/"Developer/NuvioTV_OfficialBeta_Port/local.dev.properties",
    home/".nuvio/secrets.properties",
]
mobile_sources=[
    home/"Developer/NuvioMobile/local.properties",
    home/"NuvioMobile/local.properties",
]
mobile_sources += sorted((home/"Developer").glob("NuvioMobile*/local.properties"))
mobile_sources += sorted((home/"Developer").glob("*NuvioMobile*/local.properties"))
mobile_sources += sorted(home.glob("*NuvioMobile*/local.properties"))
values={}
used=[]
for path in dict.fromkeys(tv_sources+mobile_sources):
    if not path.is_file():
        continue
    for line in path.read_text(errors="replace").splitlines():
        l=line.strip()
        if not l or l.startswith(("#","!")) or "=" not in l:
            continue
        key, _, value=line.partition("=")
        key=key.strip()
        value=value.strip().strip('"').strip("'")
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
            continue
        if value:
            values[key]=value
    used.append(path.name)

aliases={
    "NUVIO_SUPABASE_URL": ("NUVIO_SUPABASE_URL","SUPABASE_URL"),
    "NUVIO_SUPABASE_ANON_KEY": ("NUVIO_SUPABASE_ANON_KEY","SUPABASE_ANON_KEY"),
}
for target, alternatives in aliases.items():
    # Prefer native mobile config if it already contains this value.
    if values.get(target):
        continue
    for source in alternatives[1:]:
        if values.get(source):
            values[target]=values[source]
            break

needed=("NUVIO_SUPABASE_URL","NUVIO_SUPABASE_ANON_KEY",
        "TMDB_API_KEY","SIMKL_CLIENT_ID")
missing=[k for k in needed if not values.get(k)]
if missing:
    print("STOP=REQUIRED_IOS_BUILD_PROPERTIES_MISSING:"+",".join(missing))
    sys.exit(2)
if not re.fullmatch(r"[A-Za-z0-9_-]{6,200}",values["SIMKL_CLIENT_ID"]):
    print("STOP=INVALID_SIMKL_CLIENT_ID")
    sys.exit(2)

allowed=set(needed)|{
    "NUVIO_SUPABASE_FALLBACK_URL","SENTRY_DSN",
    "TRAKT_CLIENT_ID","TRAKT_CLIENT_SECRET","TRAKT_REDIRECT_URI",
    "SIMKL_REDIRECT_URI","SIMKL_APP_NAME",
    "MDBLIST_CLIENT_ID","PREMIUMIZE_CLIENT_ID",
    "NUVIO_IOS_DISTRIBUTION","NUVIO_SENTRY_DSN"
}
result={k:v for k,v in values.items() if k in allowed}
for k, v in result.items():
    if "\r" in v or "\n" in v:
        print("STOP=INVALID_MULTILINE_PROPERTY:"+k)
        sys.exit(2)

dest=Path(sys.argv[1])
dest.write_text("".join(k+"="+v+"\n" for k,v in sorted(result.items())))
dest.chmod(0o600)
print("LOCAL_CONFIG_FILES_READ="+str(len(used)))
print("REQUIRED_BUILD_CONFIG=COMPLETE")
print("SIMKL_CLIENT_ID=CONFIGURED_VALUE_HIDDEN")
print("CONFIG_VALUES=NOT_DISPLAYED")
PY

# Base64 is an encoding required by the legacy Nuvio iOS workflow, not the
# cryptographic protection. GitHub CLI encrypts the secret before upload.
base64 < "$config" | tr -d '\n' |
  gh secret set "$SECRET" --repo "$REPO" --app actions

echo "ACTIONS_SECRET=CONFIGURED"
echo "===== TRIGGERING RELEASE TEST IPA ====="
gh workflow run ios-test-build.yml --repo "$REPO" \
  --ref "$BRANCH" --field configuration=Release
echo "RESULT=IOS_RELEASE_BUILD_REQUESTED"
echo "WORKFLOW_URL=https://github.com/mistertomlinson/NuvioMobile/actions/workflows/ios-test-build.yml"
