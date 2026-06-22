function makeRes() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

function getPushTokenHandler(router) {
  const layer = router.stack.find(
    (entry) => entry.route && entry.route.path === '/push-token' && entry.route.methods.post
  );
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

async function loadAuthPushTokenHandler() {
  jest.resetModules();
  const mockQuery = jest.fn().mockResolvedValue({ rows: [] });

  jest.doMock('../../config/db', () => ({
    pool: { query: mockQuery },
  }));
  jest.doMock('../../middleware/auth', () => ({
    requireAuth: (req, _res, next) => {
      req.user = { userId: 'user-1' };
      next();
    },
  }));
  jest.doMock(
    '../../services/wechat-auth',
    () => ({ exchangeWeChatCode: jest.fn() }),
    { virtual: true }
  );
  jest.doMock(
    '../../services/sms-service',
    () => ({ sendAliSms: jest.fn() }),
    { virtual: true }
  );

  const router = require('../auth');
  return { handler: getPushTokenHandler(router), mockQuery };
}

describe('POST /api/auth/push-token provider support', () => {
  test('registers jpush token', async () => {
    const { handler, mockQuery } = await loadAuthPushTokenHandler();
    const req = {
      body: {
        provider: 'jpush',
        token: '  jpush-token-123\t',
        platform: 'android',
        app_version: '1.2.0',
      },
      user: { userId: 'user-1' },
    };
    const res = makeRes();

    await handler(req, res);

    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockQuery.mock.calls[0][1]).toEqual([
      'user-1',
      'jpush',
      'jpush-token-123',
      'android',
      '1.2.0',
    ]);
    expect(res.json).toHaveBeenCalledWith({ ok: true });
  });

  test('keeps expo token compatibility', async () => {
    const { handler, mockQuery } = await loadAuthPushTokenHandler();
    const req = {
      body: {
        provider: 'expo',
        token: 'ExponentPushToken[expo-abc]',
        platform: 'ios',
      },
      user: { userId: 'user-1' },
    };
    const res = makeRes();

    await handler(req, res);

    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockQuery.mock.calls[0][1][1]).toBe('expo');
    expect(mockQuery.mock.calls[0][1][2]).toBe('ExponentPushToken[expo-abc]');
    expect(res.json).toHaveBeenCalledWith({ ok: true });
  });

  test('rejects invalid provider', async () => {
    const { handler, mockQuery } = await loadAuthPushTokenHandler();
    const req = {
      body: {
        provider: 'apns',
        token: 'whatever',
      },
      user: { userId: 'user-1' },
    };
    const res = makeRes();

    await handler(req, res);

    expect(mockQuery).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'invalid provider' });
  });
});

describe('sendSosPush provider routing', () => {
  test('routes jpush tokens to JPush sender', async () => {
    jest.resetModules();
    const mockQuery = jest.fn().mockResolvedValue({
      rows: [
        { user_id: 'u1', provider: 'jpush', token: 'jpush-reg-1' },
        { user_id: 'u2', provider: 'expo', token: 'ExponentPushToken[expo-1]' },
      ],
    });
    const sendJpushSos = jest.fn().mockResolvedValue();
    global.fetch = jest.fn().mockResolvedValue({
      json: async () => ({ data: [] }),
    });

    jest.doMock('../../config/db', () => ({
      pool: { query: mockQuery },
    }));
    jest.doMock('../../services/jpush-service', () => ({
      sendJpushSos,
    }));

    const { sendSosPush } = require('../../services/push_notifications');

    await sendSosPush(
      ['u1', 'u2'],
      { id: 'trigger-1', name: 'Alice' },
      { lat: 25.03, lng: 121.56, group_id: 'group-1' }
    );

    expect(sendJpushSos).toHaveBeenCalledWith(
      ['jpush-reg-1'],
      { id: 'trigger-1', name: 'Alice' },
      { lat: 25.03, lng: 121.56, group_id: 'group-1' }
    );
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
