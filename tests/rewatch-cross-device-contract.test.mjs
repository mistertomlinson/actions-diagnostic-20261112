import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const sourceRoot = process.env.REWATCH_THREE_WAY_ROOT;
if (!sourceRoot) throw Error('REWATCH_THREE_WAY_ROOT must be set by CI');
const androidDir = join(sourceRoot, 'android', 'app/src/main/java/com/nuvio/tv/domain/rewatch');
const ipadDir = join(sourceRoot, 'ipad', 'composeApp/src/commonMain/kotlin/com/nuvio/app/features/rewatch');
const serverDir = join(sourceRoot, 'vps', 'services/rewatch-sync');

async function serverModule(filename) {
  return import(pathToFileURL(join(serverDir, filename)).href);
}

test('Android and iPad share exact serialized event, API and response contracts', async () => {
  for (const filename of [
    'RewatchCommittedEventPlanner.kt',
    'RewatchVpsApi.kt',
    'RewatchRemoteCheckpointReader.kt'
  ]) {
    const [android, ipad] = await Promise.all([
      readFile(join(androidDir, filename), 'utf8'),
      readFile(join(ipadDir, filename), 'utf8')
    ]);
    // Packages deliberately differ. The implementation after the package is identical.
    const stripPackage = text => text.replace(/^package [^\n]+\n/, '');
    assert.equal(stripPackage(android), stripPackage(ipad), filename + ' contract drift');
  }
  // Foreground reconcile has platform-specific storage adapters but the
  // shared core policy must not drift between Android and iPad.
  const foreground = 'RewatchForegroundSynchronizer.kt';
  const [androidForeground, ipadForeground] = await Promise.all([
    readFile(join(androidDir, foreground), 'utf8'),
    readFile(join(ipadDir, foreground), 'utf8')
  ]);
  const normalizeForeground = text => text
    .replace(/^package [^\n]*\n\n/, '')
    .replace('import com.nuvio.tv.data.local.RewatchObservedLocalSync\n', '')
    .trim();
  assert.equal(normalizeForeground(androidForeground),
    normalizeForeground(ipadForeground), 'foreground sync policy drift');
  const gate = await readFile(join(ipadDir, 'RewatchCommittedSaveHandoff.kt'), 'utf8');
  assert.match(gate, /internal object RewatchMobileSyncGate\s*\{\s*const val ENABLED = false/);
});

test('simulated iPad and Android replay events interoperate with actual staged server', async () => {
  const { RewatchStore } = await serverModule('store.mjs');
  const { makeServer } = await serverModule('server.mjs');
  const { SimklReplayCredentials } = await serverModule('simkl-sessions.mjs');
  const { makeSimklVerifier } = await serverModule('simkl-identity.mjs');
  const temp = await mkdtemp(join(tmpdir(), 'rewatch-three-way-contract-'));
  let server = null;
  try {
    const dbPath = join(temp, 'state.json');
    const store = new RewatchStore(dbPath);
    await store.init();
    const registry = new SimklReplayCredentials(join(temp, 'credentials.json'));
    await registry.init();

    // Fake existing Simkl logins only. No actual Simkl HTTP request is made.
    const fakeIpadToken = 'fake-ipad-existing-simkl-token-1234567';
    const fakeTvToken = 'fake-tv-existing-simkl-token-123456789';
    const fakeFriendToken = 'fake-friend-existing-simkl-token-1234';
    let verifiedRequests = 0;
    const verifier = makeSimklVerifier({
      allowedClientIds: ['existing-nuvio-ipad-app', 'existing-nuvio-android-tv-app'],
      fetchImpl: async (url, request) => {
        verifiedRequests++;
        assert.equal(url.origin, 'https://api.simkl.com');
        assert.equal(url.pathname, '/users/settings');
        assert.equal(request.method, 'POST');
        assert.equal(request.redirect, 'manual');
        const token = request.headers.Authorization.slice('Bearer '.length);
        if (![fakeIpadToken, fakeTvToken, fakeFriendToken].includes(token)) {
          return new Response('', { status: 401 });
        }
        const id = token === fakeFriendToken ? 99001 : 12003;
        return new Response(JSON.stringify({ account: { id } }), { status: 200 });
      }
    });
    server = makeServer(store, {
      [randomBytes(32).toString('hex')]: {
        principal: 'unused-bootstrap-account', deviceId: 'unused-staging-device'
      }
    }, { simklVerifier: verifier, simklCredentials: registry });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    assert.equal(server.address().address, '127.0.0.1');
    const base = 'http://127.0.0.1:' + server.address().port;
    async function request(method, route, token, data) {
      assert.ok(route.startsWith('/v1/rewatches') || route === '/v1/simkl/bootstrap');
      const response = await fetch(base + route, {
        method,
        headers: {
          ...(token ? { Authorization: 'Bearer ' + token } : {}),
          'Content-Type': 'application/json'
        },
        body: data == null ? undefined : JSON.stringify(data),
        signal: AbortSignal.timeout(4000)
      });
      return { status: response.status, body: await response.json() };
    }
    async function bootstrap(clientId, accessToken) {
      const response = await request('POST', '/v1/simkl/bootstrap', null, {
        clientId, accessToken, installationId: randomUUID()
      });
      assert.equal(response.status, 201);
      assert.equal(response.body.schemaVersion, 1);
      return response.body;
    }
    const ipad = await bootstrap('existing-nuvio-ipad-app', fakeIpadToken);
    const android = await bootstrap('existing-nuvio-android-tv-app', fakeTvToken);
    const friend = await bootstrap('existing-nuvio-ipad-app', fakeFriendToken);
    assert.equal(ipad.simklAccountId, '12003');
    assert.equal(android.simklAccountId, '12003');
    assert.equal(friend.simklAccountId, '99001');
    assert.notEqual(ipad.deviceId, android.deviceId);
    assert.notEqual(ipad.token, android.token);
    assert.ok(verifiedRequests >= 3);

    const seriesId = 'imdb:tt0386676';
    const sessionId = 'office-existing-replay';
    const ep = n => ({ season: 3, episode: n });
    const session = {
      sessionId, canonicalSeriesId: seriesId, episode: ep(18),
      positionMs: 0, durationMs: 0, lastCompletedEpisode: ep(17),
      phase: 'NEXT_UP'
    };
    async function send(actor, type, revision, data = {}) {
      // Payload shape is the one written by both pinned Kotlin planners.
      const body = {
        eventId: randomUUID(), deviceId: actor.deviceId,
        canonicalSeriesId: seriesId, sessionId,
        expectedRevision: revision, type, ...data
      };
      assert.equal(JSON.stringify(body).includes('local-profile:'), false);
      return request('POST', '/v1/rewatches/events', actor.token, body);
    }
    const list = actor => request('GET', '/v1/rewatches', actor.token);

    // Existing iPad rewatch S3E18 migrates without resetting to S1E1.
    const imported = await send(ipad, 'IMPORT_SNAPSHOT', 0, { session });
    assert.equal(imported.status, 200);
    assert.equal(imported.body.revision, 1);
    const androidInitial = await list(android);
    assert.equal(androidInitial.body.items.length, 1);
    assert.deepEqual(androidInitial.body.items[0].session.episode, ep(18));
    assert.deepEqual(androidInitial.body.items[0].session.lastCompletedEpisode, ep(17));
    assert.equal(androidInitial.body.items[0].session.phase, 'NEXT_UP');

    // Android plays S3E18, which iPad sees without changing watched history.
    const progress = await send(android, 'PROGRESS', 1, {
      episode: ep(18), positionMs: 1200, durationMs: 1800000
    });
    assert.equal(progress.status, 200);
    assert.equal(progress.body.revision, 2);
    const ipadProgress = await list(ipad);
    assert.equal(ipadProgress.body.items[0].session.positionMs, 1200);
    assert.equal(ipadProgress.body.items[0].session.phase, 'PLAYING');

    // Completion advances to the already-watched next episode, not Simkl Next Up.
    const completed = await send(android, 'COMPLETE_EPISODE', 2, {
      episode: ep(18), resultPhase: 'NEXT_UP', nextEpisode: ep(19)
    });
    assert.equal(completed.status, 200);
    assert.equal(completed.body.revision, 3);
    assert.deepEqual(completed.body.session.episode, ep(19));
    assert.deepEqual(completed.body.session.lastCompletedEpisode, ep(18));
    const ipadNext = await list(ipad);
    assert.deepEqual(ipadNext.body.items[0].session.episode, ep(19));

    // A delayed old iPad upload cannot rewind the TV's completion.
    const stale = await send(ipad, 'PROGRESS', 2, {
      episode: ep(18), positionMs: 50000, durationMs: 1800000
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.current.revision, 3);
    assert.deepEqual(stale.body.current.session.episode, ep(19));

    // iPad starts 19, then a late metadata response is resolved by Android.
    const ipadStarted = await send(ipad, 'PROGRESS', 3, {
      episode: ep(19), positionMs: 1500, durationMs: 1800000
    });
    assert.equal(ipadStarted.status, 200);
    assert.equal(ipadStarted.body.revision, 4);
    const pendingMetadata = await send(ipad, 'COMPLETE_EPISODE', 4, {
      episode: ep(19), resultPhase: 'AWAITING_METADATA'
    });
    assert.equal(pendingMetadata.status, 200);
    assert.equal(pendingMetadata.body.revision, 5);
    assert.equal(pendingMetadata.body.session.phase, 'AWAITING_METADATA');
    const resolved = await send(android, 'RESOLVE_METADATA', 5, {
      completedEpisode: ep(19), resultPhase: 'NEXT_UP', nextEpisode: ep(20)
    });
    assert.equal(resolved.status, 200);
    assert.equal(resolved.body.revision, 6);
    assert.deepEqual((await list(ipad)).body.items[0].session.episode, ep(20));

    // Profile isolation and device-bound credentials cannot be bypassed.
    assert.equal((await list(friend)).body.items.length, 0);
    assert.equal((await request('GET', '/v1/rewatches', null)).status, 401);
    const spoof = await request('POST', '/v1/rewatches/events', friend.token, {
      eventId: randomUUID(), deviceId: android.deviceId,
      canonicalSeriesId: seriesId, sessionId,
      expectedRevision: 6, type: 'STOP'
    });
    assert.equal(spoof.status, 403);
    const ended = await send(ipad, 'STOP', 6);
    assert.equal(ended.status, 200);
    assert.equal(ended.body.revision, 7);
    const restored = new RewatchStore(dbPath);
    await restored.init();
    assert.equal(restored.list('simkl:12003')[0].revision, 7);
    assert.equal(restored.list('simkl:12003')[0].session.phase, 'FINISHED');
    assert.equal(restored.list('simkl:99001').length, 0);
    assert.equal((await readFile(dbPath, 'utf8')).includes('local-profile:'), false);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await rm(temp, { recursive: true, force: true });
  }
});
