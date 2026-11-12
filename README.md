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

## Why not use actions/checkout?

The source repository's tree contains a legacy `libass-android` gitlink without a matching `.gitmodules` URL, which caused `actions/checkout@v6` to fail during credential cleanup even after fetching the correct commit. This harness uses a minimal plain `git fetch` + detached checkout, then verifies the exact SHA. This is a workaround for checkout setup, **not** a NuvioMobile source fix.

## Safety

Do not merge files from this harness into the app by default.
Do not enable the rollout gate or deploy anything on the basis of a passing focused iOS test alone.
Do not treat the original repository's 422 error as a confirmed account or Terms of Service violation.
