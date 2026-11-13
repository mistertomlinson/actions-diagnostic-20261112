#!/usr/bin/env bash
# Pin, build, and ADB-install isolated public HTTPS rewatch TV test.
# Never checks out, resets, merges, or edits the original active branch.
set -euo pipefail
PIN="e65c223353a7d01add64103832a344b6b752d112"
SOURCE="$HOME/Developer/NuvioTV_OfficialBeta_Port"
BRANCH="test/rewatch-public-https-20261112"
OUTPUT="$HOME/Downloads/Nuvio-Rewatch-HTTPS-Test-armeabi-v7a.apk"
APPID="com.nuvio.tv.sideload"
echo "===== NUVIO REWATCH HTTPS ANDROID TEST ====="
echo "SOURCE_PIN=$PIN"
for tool in git java adb python3; do
  command -v "$tool" >/dev/null || { echo "STOP=MISSING_TOOL_$tool"; exit 1; }
done
git -C "$SOURCE" rev-parse --show-toplevel >/dev/null || {
  echo "STOP=NUVIO_CHECKOUT_MISSING"; exit 1;
}
origin="$(git -C "$SOURCE" remote get-url origin)"
[[ "$origin" == *"mistertomlinson/NuvioTV"* ]] || {
  echo "STOP=UNEXPECTED_ORIGIN"; exit 1;
}
if [[ ! -f "$HOME/.nuvio/secrets.properties" && ! -f "$SOURCE/local.properties" ]]; then
  echo "STOP=EXISTING_RUNTIME_PROPERTIES_MISSING"; exit 1
fi
python3 - "$HOME/.nuvio/secrets.properties" "$SOURCE/local.properties" <<'PY'
import sys
from pathlib import Path
configured = {}
for path in sys.argv[1:]:
    f = Path(path)
    if f.is_file():
        for line in f.read_text(errors="replace").splitlines():
            key, sep, val = line.partition("=")
            if sep and val.strip(): configured[key.strip()] = val.strip()
if not configured.get("SIMKL_CLIENT_ID"):
    raise SystemExit("STOP=SIMKL_CLIENT_ID_MISSING")
print("SIMKL_CONFIGURATION=PRESENT_VALUES_HIDDEN")
PY
git -C "$SOURCE" fetch --no-tags origin "refs/heads/$BRANCH"
[[ "$(git -C "$SOURCE" rev-parse FETCH_HEAD)" == "$PIN" ]] || {
  echo "STOP=TEST_BRANCH_PIN_MISMATCH"; exit 1;
}
scratch="$(mktemp -d /tmp/nuvio-rewatch-https.XXXXXX)"
checkout="$scratch/source"
cleanup() {
  if [[ -d "$checkout" ]]; then
    git -C "$SOURCE" worktree remove --force "$checkout" >/dev/null 2>&1 || true
  fi
  rm -rf "$scratch"
}
trap cleanup EXIT
git -C "$SOURCE" worktree add --detach "$checkout" "$PIN" >/dev/null
for config in local.properties local.dev.properties nuviotv.jks; do
  if [[ -f "$SOURCE/$config" ]]; then
    cp -p "$SOURCE/$config" "$checkout/$config"
    chmod 600 "$checkout/$config"
  fi
done
grep -q 'const val ENABLED = true' \
  "$checkout/app/src/main/java/com/nuvio/tv/data/local/AndroidRewatchSyncRuntime.kt"
grep -q 'assertTrue(' \
  "$checkout/app/src/test/java/com/nuvio/tv/data/local/RewatchRolloutGateTest.kt"
echo "SYNC_GATE=ON_IN_TEST_WORKTREE_ONLY"
echo "===== REWATCH REGRESSION ====="
(
  cd "$checkout"
  chmod +x gradlew
  ./gradlew :app:testSideloadUnitTest --tests '*Rewatch*' \
    --no-daemon --console=plain
  echo "===== BUILD V7A SIDELOAD ====="
  ./gradlew :app:assembleSideload --no-daemon --console=plain
)
apk="$(find "$checkout/app/build/outputs/apk/sideload" -type f \
  -name '*armeabi-v7a*.apk' -print -quit)"
[[ -n "$apk" && -s "$apk" ]] || {
  echo "STOP=V7A_APK_MISSING"; exit 1;
}
unzip -Z1 "$apk" | grep -q '^lib/armeabi-v7a/' || {
  echo "STOP=V7A_NATIVE_LIB_MISSING"; exit 1;
}
mkdir -p "$HOME/Downloads"
cp "$apk" "$OUTPUT"
echo "APK_READY=$OUTPUT"
echo "APK_SHA256=$(shasum -a 256 "$OUTPUT" | awk '{print $1}')"
devices="$(adb devices | awk 'NR>1 && $2=="device" {print $1}')"
count="$(printf '%s\n' "$devices" | grep -c . || true)"
if [[ "$count" -ne 1 ]]; then
  echo "INSTALL_SKIPPED=NEED_EXACTLY_ONE_ADB_DEVICE"
  echo "RESULT=APK_BUILT"
  exit 0
fi
echo "ADB_TARGET=$devices"
if ! adb -s "$devices" install -r "$OUTPUT"; then
  echo "STOP=ADB_INSTALL_FAILED_OLD_APP_PRESERVED"
  exit 1
fi
adb -s "$devices" shell cmd package compile -f -m speed "$APPID"
echo "AOT_COMPILE=PASS"
echo "ORIGINAL_CHECKOUT=UNCHANGED"
echo "RESULT=ANDROID_REWATCH_HTTPS_TEST_INSTALLED"
