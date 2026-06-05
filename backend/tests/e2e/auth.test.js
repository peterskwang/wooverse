/**
 * End-to-end auth tests — hits the LIVE running backend.
 * Backend must be up on PORT=8102 before running.
 */
const http = require('http');

const BASE = 'http://localhost:8102';
const TEST_USER = {
  email: `e2e-${Date.now()}@wooverse.test`,
  password: 'e2etest2024',
  name: 'E2E Test Rider'
};

let token = null;
let userId = null;
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
  console.log('🔱 Wooverse E2E Auth Tests\n');

  // 1. Health check
  console.log('─ Health ─');
  const health = await request('GET', '/health');
  assert(health.status === 200, 'GET /health returns 200');
  assert(health.body.status === 'ok', 'Health body contains status=ok');

  // 2. Signup
  console.log('─ Signup ─');
  const signup = await request('POST', '/api/auth/signup', TEST_USER);
  assert(signup.status === 201 || signup.status === 200,
    `Signup returns ${signup.status}`);
  assert(!!signup.body.token, 'Signup returns JWT token');
  assert(!!signup.body.user, 'Signup returns user object');
  assert(signup.body.user.email === TEST_USER.email,
    'Signup user email matches');
  token = signup.body.token;
  userId = signup.body.user.id;
  console.log(`    → user_id=${userId}`);

  // 3. Duplicate signup rejection
  console.log('─ Duplicate Signup ─');
  const dup = await request('POST', '/api/auth/signup', TEST_USER);
  assert(dup.status >= 400, `Duplicate signup rejected (HTTP ${dup.status})`);

  // 4. Login
  console.log('─ Login ─');
  const login = await request('POST', '/api/auth/login', {
    email: TEST_USER.email,
    password: TEST_USER.password
  });
  assert(login.status === 200, `Login returns 200`);
  assert(!!login.body.token, 'Login returns JWT token');
  assert(login.body.user.id === userId,
    'Login returns same user ID');
  token = login.body.token; // Use latest token

  // 5. Bad password rejection
  console.log('─ Bad Password ─');
  const badPw = await request('POST', '/api/auth/login', {
    email: TEST_USER.email,
    password: 'wrongpassword'
  });
  assert(badPw.status >= 400,
    `Bad password rejected (HTTP ${badPw.status})`);

  // 6. Protected endpoint with token
  console.log('─ Protected Endpoint ─');
  const pushToken = await request(
    'POST',
    '/api/auth/push-token',
    { token: 'ExponentPushToken[e2e-test-xxx]', platform: 'ios' },
    { Authorization: `Bearer ${token}` }
  );
  assert(pushToken.status === 200,
    `Push token registration returns ${pushToken.status}`);
  assert(pushToken.body.ok === true, 'Push token registration ok');

  // 7. Protected endpoint without token (rejected)
  console.log('─ Auth Required ─');
  const noAuth = await request('POST', '/api/auth/push-token',
    { token: 'xxx', platform: 'ios' }
  );
  assert(noAuth.status === 401,
    `No-token request rejected (HTTP ${noAuth.status})`);

  // 8. Bad token rejected
  console.log('─ Bad Token ─');
  const badToken = await request(
    'POST',
    '/api/auth/push-token',
    { token: 'xxx', platform: 'ios' },
    { Authorization: 'Bearer bad.invalid.token' }
  );
  assert(badToken.status === 401,
    `Bad token rejected (HTTP ${badToken.status})`);

  // 9. Invalid email format
  console.log('─ Validation ─');
  const badEmail = await request('POST', '/api/auth/signup', {
    email: 'not-an-email',
    password: 'valid1234',
    name: 'Bad Email'
  });
  assert(badEmail.status >= 400,
    `Invalid email rejected (HTTP ${badEmail.status})`);

  // 10. Short password rejection
  console.log('─ Short Password ─');
  const shortPw = await request('POST', '/api/auth/signup', {
    email: `short-${Date.now()}@test.com`,
    password: 'ab',
    name: 'Short'
  });
  assert(shortPw.status >= 400,
    `Short password rejected (HTTP ${shortPw.status})`);

  // Summary
  console.log(`\n───────────────────────────`);
  console.log(`Results: ${testsPassed}/${testsRun} passed`);
  if (testsPassed === testsRun) {
    console.log('✅ ALL END-TO-END AUTH TESTS PASSED\n');
  } else {
    console.log(`❌ ${testsRun - testsPassed} TEST(S) FAILED\n`);
  }
}

run().catch((err) => {
  console.error('❌ Test suite crashed:', err.message);
  process.exit(1);
});
