# Nuvio cross-device test harness (temporary GitHub Actions workaround)

This public repository is a **GitHub Actions execution harness only**.
It is **not** the NuvioMobile source repository, product fork, production branch, or deployment destination.

## Source of truth

- Application source: https://github.com/mistertomlinson/NuvioMobile
- iPad rewatch development branch: `feature/persistent-simkl-rewatch-0.6.7`
- Initial checkpoint SHA (first test attempt): `a273972fe01e2ff8363f7df38768b118f1a8c98f`
- Current pinned source SHA (iOS test assertion fix only): `8af4218a2a085216438704c920e29e53a2414c83`
- Android TV fork: https://github.com/mistertomlinson/NuvioTV
- Current original-repo issue: HTTP 422 "Actions has been disabled for this repository" on manual workflow dispatch, despite repository Actions settings being enabled. The precise cause has **not** been established.

## What the workflow does

`.github/workflows/nuvio-ios-rewatch.yml` runs on GitHub's `xcode-27` Apple Silicon runner with Xcode 27.1 and Java 17.
It fetches NuvioMobile **read-only** at its explicitly pinned SHA, prepares the native iOS engine dependencies, and runs only the focused tests:

```bash
./gradlew :composeApp:iosSimulatorArm64Test \
  --tests '*Rewatch*' \
  -Pnuvio.ios.distribution=full \
  -Dorg.gradle.jvmargs="-Xmx4608M -Dfile.encoding=UTF-8 -XX:MaxMetaspaceSize=768M" \
  -Pkotlin.native.jvmArgs="-Xmx4608M" \
  --console=plain
```

It does **not** produce an IPA, install on an iPad, deploy a VPS service, modify Simkl history, or enable the dormant rewatch feature.

## IMPORTANT: Pin and test coverage

**Do not assume a successful run proves the latest feature branch is tested.**
The workflow is pinned to one immutable NuvioMobile commit. A future agent must:

1. Inspect and confirm the intended NuvioMobile feature-branch HEAD.
2. Update **both** the pinned `ref` in the fetch step and the `git rev-parse HEAD` assertion in the workflow to that exact SHA. Review the diff before dispatching.
3. Run the workflow manually and review the specific run's conclusion and test logs.
4. Report the **actual source SHA and actual test results**. A dispatch-accepted response or a completed setup step is not a test pass.

The `*Rewatch*` filter is a **focused** suite, not the entire iOS test suite, not Android testing, and not cross-device end-to-end validation.

## Run manually

```bash
gh workflow run nuvio-ios-rewatch.yml \
  --repo mistertomlinson/actions-diagnostic-20261112 \
  --ref main
```

Use the returned run URL to inspect progress and results.

## VPS staging regression gate

`.github/workflows/rewatch-vps-staging.yml` uses a disposable GitHub-hosted `ubuntu-latest` runner with Node.js 22.

- **Source of truth:** `mistertomlinson/NuvioMobile`, branch `prototype/rewatch-vps-staging-20261110`.
- **Pinned VPS source SHA:** `e447e830f0e2057e43a88cb6bd9c8f27e5edfab5`.
- **Scope:** Reproduces that source branch's own `.github/workflows/rewatch-sync-staging.yml` checks: syntax, fail-closed staging/deployment guards, `npm test`, and a disposable multi-user server smoke test.
- **Isolation:** All execution is on an ephemeral GitHub runner. No Oracle VPS logins, real secrets, deployment, service restarts, Caddy changes, real Simkl credentials, or app installations.
- **Limitations:** This tests the staged server, not deployed VPS health and not real Android ↔ VPS ↔ iPad end-to-end compatibility.

Manually run:

```bash
gh workflow run rewatch-vps-staging.yml \
  --repo mistertomlinson/actions-diagnostic-20261112 \
  --ref main
```

The source SHA is **immutable and separately pinned** from the iOS test source. For future VPS code changes, first inspect the staging branch's new HEAD, then update both the `git fetch` pin and the SHA assertion in this workflow; inspect the updated diff before running. Confirm the actual `npm test` and smoke-step conclusions, not only the dispatch response.

## Android ↔ iPad ↔ VPS protocol compatibility gate

.github/workflows/rewatch-three-way-contract.yml fetches **three distinct pinned commits** into separate directories on a disposable Ubuntu runner:

- Android source: `726c9d8681a999f127f2e9995da5abb12e463dff` (NuvioTV).
- iPad source: `8af4218a2a085216438704c920e29e53a2414c83` (NuvioMobile feature branch).
- VPS source: `e447e830f0e2057e43a88cb6bd9c8f27e5edfab5` (NuvioMobile staging branch).

It checks that the Kotlin event planner, VPS API, and remote checkpoint reader **source bodies are identical** after removing their intentionally different package declarations. Its Node test then loads the actual pinned VPS server and exchanges request JSON shaped exactly like the Kotlin planner's output, using **fake existing Simkl tokens** and a mocked Simkl verifier (never a real Simkl request). It covers an existing Office S3E18 replay, Android/iPad progress and completion, S3E19 Next Up, stale offline 409, metadata recovery, isolation, spoof rejection, STOP, and restart persistence.

**Important limitation:** The Node test uses simulated client requests, not executable Android/iOS clients. Source parity is a static check and these tests do **not** prove that either actual app calls its transport. Full device↔VPS↔device end-to-end validation and production safety review still remain.

Run only when the pin and workflow diff are reviewed:


```bash
gh workflow run rewatch-three-way-contract.yml \
  --repo mistertomlinson/actions-diagnostic-20261112 \
  --ref main
```

Future AI: independently update and verify all three pinned source SHAs after client/server changes; never treat this workflow's PASS as permission to enable sync, expose a public endpoint, or deploy apps.

## Staging checkpoint: 2026-11-12 (operator-reported)

The Oracle VPS staging upgrade script returned **`RESULT=STAGING_TWO_FILE_UPGRADE_PASSED`** after installing the pinned server and store source from `NuvioMobile@e447e830f0e2057e43a88cb6bd9c8f27e5edfab5`. Operator output showed `60/60` Node tests, disposable smoke PASS, exact new source hashes, service active, autostart disabled, Simkl bootstrap disabled, loopback unauthenticated HTTP 401, public HTTPS 503, Caddy and credentials unchanged, and no database migration. The source commit itself was also independently tested in GitHub Actions (run `43323763682`). The installed VPS hash and health assertions are from the operator's run, **not** an independent remote session by this harness.

**Do not enable client flags or expose the API yet.** Source audits of the current Android `726c9d8681a999f127f2e9995da5abb12e463dff` and iOS `8af4218a2a085216438704c920e29e53a2414c83` branches found:
- Android `RewatchCrossDeviceGate.ENABLED = false`; iOS `RewatchMobileSyncGate.ENABLED = false`.
- Both implement isolated local playback rewatch and optional replay-only sync transports, but remote `pullSeries` / `uploadPending` are not wired into a gated application lifecycle.
- A remote-only series started on another device has no confirmed discovery/polling trigger in Home. A locally existing rewatch also needs an authenticated remote-empty checkpoint and explicit import enqueue before it can sync, even without a subsequent local playback write.
- iOS `IosRewatchSyncRuntime.activateAfterValidatedRollout()` requires explicit installation; it is not called on app startup.
- VPS Simkl bootstrap and HTTPS exposure are OFF, intentionally, so real apps cannot connect today.

**Next implementation work (feature branches only):** introduce tested, explicit, gate-controlled reconciliation triggers for initial remote discovery, pre-play checkpoint and local import, post-save outbox drain, resume after offline/restart, and stale profile/credential changes. Keep network/certificate checks, existing watched-history protection, and feature gate OFF in all checked-in builds. Test these flows with fake transports on both platforms, re-run Android and focused iOS tests, then review a private HTTPS staging exposure plan before on-device activation. Do not assume that passing the simulated three-way Node test proves client lifecycle integration.

## Client lifecycle integration checkpoint (2026-11-12, not released)

After the source audit described above, both feature branches received the dormant lifecycle wiring:

- Android: `mistertomlinson/NuvioTV:design/persistent-simkl-rewatch-cross-device`, latest reviewed source `a35229aa9804b9f849bd26bd7eda1ecb9efcc122`. Added gated Home entry/return and pre-play refresh, validated server roster discovery, offline event drain before remote apply, durable local-only `IMPORT_SNAPSHOT` after verified empty checkpoint, background post-save upload, and local STOP / late-metadata handoff. The public DI facade keeps the implementation internal.
- iPad: `mistertomlinson/NuvioMobile:feature/persistent-simkl-rewatch-0.6.7`, latest reviewed source `26a463f0c5de837f24c5707c30d5e49771e94f57`. Added equivalent shared foreground reconciliation, expect/actual platform hooks (iOS-only, NuvioMobile Android flavor no-op), pre-play/Home entry, asynchronous outbox upload, and STOP/metadata handling.
- Both have new `RewatchForegroundSynchronizerTest` and remote-roster tests. `RewatchCrossDeviceGate.ENABLED = false`, `RewatchMobileSyncGate.ENABLED = false`. Server Simkl bootstrap OFF, public HTTPS still 503.
- Latest three-way **simulated** protocol test run [43335608964](https://github.com/mistertomlinson/actions-diagnostic-20261112/actions/runs/43335608964) **PASS**, now including shared foreground policy parity between the new client commits and server `e447e83`.
- Android CI [43335358090](https://github.com/mistertomlinson/actions-diagnostic-20261112/actions/runs/43335358090) is the first build after repairing an internal-class exposure compile error. Inspect its exact test and assemble conclusions before claiming Android built.
- iPad focused simulator CI [43334699856](https://github.com/mistertomlinson/actions-diagnostic-20261112/actions/runs/43334699856) tests the final iPad SHA. Do not claim it passed until the run completes and the test log confirms it.
- Original Android CI [43334664399](https://github.com/mistertomlinson/actions-diagnostic-20261112/actions/runs/43334664399) found two Kotlin `public` constructor/`internal` runtime exposure errors; both are addressed through `RewatchSyncFacade` after the failed build.
- All CI Android build properties are **fake `example.invalid` values** on the ephemeral runner, never actual user credentials. Do not install that APK.

Open release gates remain: verify both native builds, review account/series canonical alias handling across real clients, stage safe authenticated HTTPS exposure, confirm true signed-device APK↔VPS↔IPA sync and Simkl history immutability, then consider deliberately enabling the gates. A passing protocol simulation or one platform build alone does not justify activation.

### Validation results for the dormant client lifecycle checkpoint

All the following ran against the pinned source revisions (not deployed or installed):

- **Android** [Actions run 43335358090](https://github.com/mistertomlinson/actions-diagnostic-20261112/actions/runs/43335358090): **SUCCESS** — `*Rewatch*` sideload unit tests and `:app:assembleSideload`, source `a35229aa9804b9f849bd26bd7eda1ecb9efcc122`. Build used **dummy local `example.invalid` settings**, not real credentials.
- **iPad** [Actions run 43334699856](https://github.com/mistertomlinson/actions-diagnostic-20261112/actions/runs/43334699856): **SUCCESS** — focused `*Rewatch*` iOS simulator tests, source `26a463f0c5de837f24c5707c30d5e49771e94f57`. No signed IPA or device install.
- **Three-way contract** [Actions run 43335608964](https://github.com/mistertomlinson/actions-diagnostic-20261112/actions/runs/43335608964): **SUCCESS** — source parity and simulated HTTP exchange against VPS source `e447e830f0e2057e43a88cb6bd9c8f27e5edfab5`.
- **Repeat three-way contract** [Actions run 43335985852](https://github.com/mistertomlinson/actions-diagnostic-20261112/actions/runs/43335985852): **SUCCESS**, same client/server pins after updating documentation.
- GitHub branch heads rechecked as the Android/iPad pinned SHAs above; both rollout gates remain `false`.
- **NOT RELEASE-READY:** no full native regression suite in these runs, no actual signed Android ↔ VPS ↔ iPad end-to-end test, and no authenticated public/private HTTPS staging onboarding. The user's staging VPS continues to require controlled configuration before real-device connection; do not open the fail-closed 503 route or enable bootstrap/gates without a separately reviewed plan.

## Why not use actions/checkout?

The source repository's tree contains a legacy `libass-android` gitlink without a matching `.gitmodules` URL, which caused `actions/checkout@v6` to fail during credential cleanup even after fetching the correct commit. This harness uses a minimal plain `git fetch` + detached checkout, then verifies the exact SHA. This is a workaround for checkout setup, **not** a NuvioMobile source fix.

## Safety

Do not merge files from this harness into the app by default.
Do not enable the rollout gate or deploy anything on the basis of a passing focused iOS test alone.
Do not treat the original repository's 422 error as a confirmed account or Terms of Service violation.
