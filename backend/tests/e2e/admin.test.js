/**
 * Wooverse Admin Panel — E2E Regression Suite
 * Tests every admin endpoint: users, groups, SOS, ban, delete, notify
 * This is the safety net that prevents new features from breaking existing ones.
 */
const http = require('http');

const BASE = 'http://localhost:8102';
const ADMIN_PW = 'wooverse_admin_dev_2024';
let userToken = null;
let testUserId = null;
let testGroupId = null;
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
      headers: { 'Content-Type': 'application/json', ...headers },
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

async function setup() {
  // Create a real user + group for admin operations
  const email = `admin-e2e-${Date.now()}@test.com`;
  const signup = await request('POST', '/api/auth/signup',
    { email, password: 'admintest2024', name: 'Admin E2E User' });
  userToken = signup.body.token;
  testUserId = signup.body.user?.id || signup.body.id;

  const group = await request('POST', '/api/groups',
    { name: 'Admin E2E Group', code: `AE2E-${Date.now()}` },
    { Authorization: `Bearer ${userToken}` });
  testGroupId = group.body.group?.id || group.body.id;
}

async function run() {
  console.log('🔱 Wooverse Admin Panel E2E Regression\n');
  await setup();

  // ═══════════════════════════════════════
  // 1. AUTH GATES — reject without password
  // ═══════════════════════════════════════
  console.log('─ Auth Gates ─');
  const noPw = await request('GET', '/api/admin/users');
  assert(noPw.status === 401, 'No password → 401');

  const badPw = await request('GET', '/api/admin/users',
    null, { 'X-Admin-Password': 'wrong' });
  assert(badPw.status === 401, 'Bad password → 401');

  const okPw = await request('GET', '/api/admin/users',
    null, { 'X-Admin-Password': ADMIN_PW });
  assert(okPw.status === 200, 'Correct password → 200');

  // ═══════════════════════════════════════
  // 2. USERS — list, contains real user
  // ═══════════════════════════════════════
  console.log('─ Users ─');
  const users = await request('GET', '/api/admin/users',
    null, { 'X-Admin-Password': ADMIN_PW });
  assert(Array.isArray(users.body), 'Users returns array');
  assert(users.body.length > 0, 'Users list not empty');

  // Verify user shows name (not just raw device_id)
  const sample = users.body[0];
  assert(typeof sample.id === 'string' && sample.id.length > 4, 'User has id');
  assert(sample.name !== undefined, 'User has name');
  assert(sample.created_at !== undefined, 'User has created_at');

  // Find our test user
  const me = users.body.find(u => u.id === testUserId);
  assert(!!me, 'Test user visible in admin list');
  if (me) {
    assert(me.name === 'Admin E2E User', 'User name correct');
    assert(me.banned_at === null, 'User not initially banned');
  }

  // ═══════════════════════════════════════
  // 3. BAN USER — ban → verify banned_at
  // ═══════════════════════════════════════
  console.log('─ Ban/Unban ─');
  const ban = await request('POST', `/api/admin/users/${testUserId}/ban`,
    null, { 'X-Admin-Password': ADMIN_PW });
  assert(ban.status === 200, `Ban returns ${ban.status}`);
  assert(ban.body.ok === true, 'Ban response: ok=true');

  // Verify banned_at is set
  const afterBan = await request('GET', '/api/admin/users',
    null, { 'X-Admin-Password': ADMIN_PW });
  const banned = afterBan.body.find(u => u.id === testUserId);
  assert(banned && banned.banned_at !== null, 'User banned_at is set');

  // Ban unknown user
  const ban404 = await request('POST',
    '/api/admin/users/00000000-0000-0000-0000-000000000000/ban',
    null, { 'X-Admin-Password': ADMIN_PW });
  assert(ban404.status === 404, 'Ban unknown user → 404');

  // Ban without auth
  const banNoAuth = await request('POST',
    `/api/admin/users/${testUserId}/ban`);
  assert(banNoAuth.status === 401, 'Ban without auth → 401');

  // ═══════════════════════════════════════
  // 4. GROUPS — list with member count
  // ═══════════════════════════════════════
  console.log('─ Groups ─');
  const groups = await request('GET', '/api/admin/groups',
    null, { 'X-Admin-Password': ADMIN_PW });
  assert(Array.isArray(groups.body), 'Groups returns array');
  assert(groups.body.length > 0, 'Groups list not empty');

  // Verify structure
  const g = groups.body[0];
  assert(g.id !== undefined, 'Group has id');
  assert(g.member_count !== undefined, 'Group has member_count');
  assert(typeof g.member_count === 'number', 'member_count is number');

  // ═══════════════════════════════════════
  // 5. SOS — list events
  // ═══════════════════════════════════════
  console.log('─ SOS Events ─');
  const sos = await request('GET', '/api/admin/sos',
    null, { 'X-Admin-Password': ADMIN_PW });
  assert(Array.isArray(sos.body), 'SOS returns array');
  // SOS list should include user_name
  if (sos.body.length > 0) {
    assert(sos.body[0].user_name !== undefined, 'SOS event has user_name');
    assert(sos.body[0].triggered_at !== undefined, 'SOS event has triggered_at');
  }

  // ═══════════════════════════════════════
  // 6. NOTIFY — validation + broadcast
  // ═══════════════════════════════════════
  console.log('─ Notify ─');
  const noBody = await request('POST', '/api/admin/notify',
    null, { 'X-Admin-Password': ADMIN_PW });
  assert(noBody.status === 400, 'Notify without body → 400');

  const noTitle = await request('POST', '/api/admin/notify',
    { body: 'Test message' }, { 'X-Admin-Password': ADMIN_PW });
  assert(noTitle.status === 400, 'Notify without title → 400');

  const notifyAll = await request('POST', '/api/admin/notify',
    { title: 'E2E Test', body: 'This is an automated test notification' },
    { 'X-Admin-Password': ADMIN_PW });
  assert(notifyAll.status === 200, 'Notify (all users) → 200');
  assert(notifyAll.body.ok === true, 'Notify returns ok');
  assert(typeof notifyAll.body.sent === 'number', 'Notify returns sent count');

  const notifyGroup = await request('POST', '/api/admin/notify',
    { group_id: testGroupId, title: 'E2E Group Test', body: 'Group notification' },
    { 'X-Admin-Password': ADMIN_PW });
  assert(notifyGroup.status === 200, 'Notify (specific group) → 200');

  // Notify with no auth
  const notifyNoAuth = await request('POST', '/api/admin/notify',
    { title: 'X', body: 'Y' });
  assert(notifyNoAuth.status === 401, 'Notify without auth → 401');

  // ═══════════════════════════════════════
  // 7. DELETE GROUP — with cleanup
  // ═══════════════════════════════════════
  console.log('─ Delete Group ─');
  const del404 = await request('DELETE',
    '/api/admin/groups/00000000-0000-0000-0000-000000000000',
    null, { 'X-Admin-Password': ADMIN_PW });
  assert(del404.status === 404, 'Delete unknown group → 404');

  const delNoAuth = await request('DELETE',
    `/api/admin/groups/${testGroupId}`);
  assert(delNoAuth.status === 401, 'Delete without auth → 401');

  const del = await request('DELETE',
    `/api/admin/groups/${testGroupId}`,
    null, { 'X-Admin-Password': ADMIN_PW });
  assert(del.status === 200, `Delete group → ${del.status}`);
  assert(del.body.ok === true, 'Delete returns ok');

  // Verify gone
  const afterDel = await request('GET', '/api/admin/groups',
    null, { 'X-Admin-Password': ADMIN_PW });
  const stillThere = afterDel.body.find(g => g.id === testGroupId);
  assert(!stillThere, 'Group removed from list after delete');

  // ═══════════════════════════════════════
  console.log(`\n───────────────────────────`);
  console.log(`Admin E2E: ${testsPassed}/${testsRun} passed`);
  if (testsPassed === testsRun) {
    console.log('✅ ALL ADMIN PANEL E2E TESTS PASSED\n');
  } else {
    console.log(`❌ ${testsRun - testsPassed} TEST(S) FAILED\n`);
  }
}

run().catch((err) => {
  console.error('❌ Admin suite crashed:', err.message);
  process.exit(1);
});
