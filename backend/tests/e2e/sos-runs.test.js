/**
 * End-to-end SOS + runs API tests — LIVE backend required on :8102
 * Creates real groups (UUID FK) before testing runs/SOS.
 */
const http = require('http');

const BASE = 'http://localhost:8102';
let token = null;
let groupId = null;
let testsRun = 0;
let testsPassed = 0;

function request(method, path, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...headers
      }
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function assert(condition, label) {
  testsRun++;
  if (condition) {
    testsPassed++;
    console.log(`  ✅ ${label}`);
  } else {
    console.log(`  ❌ ${label}`);
    process.exitCode = 1;
  }
}

async function run() {
  console.log('🔱 Wooverse E2E SOS + Runs Tests\n');

  // Setup: create user, login
  const email = `sos-e2e-${Date.now()}@test.com`;
  const signup = await request('POST', '/api/auth/signup', {
    email, password: 'e2etest2024', name: 'SOS Tester'
  });
  assert(signup.status === 201, `Signup returns ${signup.status}`);
  token = signup.body.token;
  assert(!!token, 'Signup returns token');

  // Create a real group (UUID required for runs FK)
  console.log('─ Group Setup ─');
  const group = await request('POST', '/api/groups', {
    name: 'E2E SOS Test Group',
    code: `SOS-${Date.now()}`
  }, { Authorization: `Bearer ${token}` });
  assert(group.status === 201, `Group creation returns ${group.status}`);
  groupId = group.body.group?.id || group.body.id;
  assert(!!groupId && groupId.length > 20, 'Group has valid UUID');

  // SOS: missing fields rejected
  console.log('─ SOS Validation ─');
  const missing = await request('POST', '/api/sos', {},
    { Authorization: `Bearer ${token}` });
  assert(missing.status === 400, 'SOS without fields rejected');

  const noLat = await request('POST', '/api/sos',
    { group_id: groupId },
    { Authorization: `Bearer ${token}` });
  assert(noLat.status === 400, 'SOS without lat/lng rejected');

  // SOS: valid trigger
  console.log('─ SOS Trigger ─');
  const sos = await request('POST', '/api/sos',
    { group_id: groupId, lat: 45.923, lng: 6.869 },
    { Authorization: `Bearer ${token}` });
  assert(sos.status === 201, `SOS trigger returns ${sos.status}`);

  // SOS without auth rejected
  console.log('─ SOS Auth ─');
  const noAuthSos = await request('POST', '/api/sos',
    { group_id: groupId, lat: 45.923, lng: 6.869 });
  assert(noAuthSos.status === 401, 'SOS without token rejected');

  // Runs: start
  console.log('─ Run Start ─');
  const run = await request('POST', '/api/runs/start',
    { group_id: groupId, top_altitude_m: 3200, started_at: new Date().toISOString() },
    { Authorization: `Bearer ${token}` });
  assert(run.status === 201, `Run start returns ${run.status}`);
  assert(!!run.body.run_id, 'Run start returns run_id');
  const runId = run.body.run_id;

  // Runs: end
  console.log('─ Run End ─');
  const endRun = await request('POST', `/api/runs/${runId}/end`,
    { duration_seconds: 3600, distance_meters: 12000, vertical_meters: 5800,
      max_speed_kmh: 68, avg_speed_kmh: 42 },
    { Authorization: `Bearer ${token}` });
  assert(endRun.status === 200, `Run end returns ${endRun.status}`);
  assert(endRun.body.ok === true, 'Run end returns ok');

  // Runs: history
  console.log('─ Run History ─');
  const history = await request('GET', '/api/runs?limit=5', null,
    { Authorization: `Bearer ${token}` });
  assert(history.status === 200, `Run history returns ${history.status}`);
  assert(Array.isArray(history.body.runs), 'Run history returns runs array');

  // Runs unauthorized
  console.log('─ Run Auth ─');
  const noAuthRun = await request('POST', '/api/runs/start',
    { group_id: groupId });
  assert(noAuthRun.status === 401, 'Run start without token rejected');

  // Summary
  console.log(`\n───────────────────────────`);
  console.log(`Results: ${testsPassed}/${testsRun} passed`);
  if (testsPassed === testsRun) {
    console.log('✅ ALL E2E SOS+RUNS TESTS PASSED\n');
  } else {
    console.log(`❌ ${testsRun - testsPassed} TEST(S) FAILED\n`);
  }
}

run().catch((err) => {
  console.error('❌ Test suite crashed:', err.message);
  process.exit(1);
});
