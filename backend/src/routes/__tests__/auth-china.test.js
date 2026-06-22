const crypto = require('crypto');
const express = require('express');
const http = require('http');

jest.mock('../../config/db', () => ({
  pool: {
    query: jest.fn(),
    connect: jest.fn()
  }
}));

jest.mock('../../services/wechat-auth', () => ({
  exchangeWeChatCode: jest.fn()
}));

jest.mock('../../services/sms-service', () => ({
  sendAliSms: jest.fn()
}));

jest.mock('apple-signin-auth', () => ({
  verifyIdToken: jest.fn()
}));

const { pool } = require('../../config/db');
const { exchangeWeChatCode } = require('../../services/wechat-auth');
const { sendAliSms } = require('../../services/sms-service');
const authRouter = require('../auth');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function jsonRequest(server, method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const address = server.address();
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: address.port,
        path,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...headers
        }
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          let parsed = data;
          try {
            parsed = data ? JSON.parse(data) : {};
          } catch {
            parsed = data;
          }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on('error', reject);
    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

describe('China auth routes', () => {
  let app;
  let server;

  beforeAll((done) => {
    process.env.JWT_SECRET = 'test-jwt-secret';
    app = express();
    app.use(express.json());
    app.use('/api/auth', authRouter);
    server = app.listen(0, done);
  });

  afterAll((done) => {
    server.close(done);
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('POST /api/auth/wechat validates code presence', async () => {
    const res = await jsonRequest(server, 'POST', '/api/auth/wechat', {});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('code required');
  });

  test('POST /api/auth/wechat signs in existing identity user', async () => {
    exchangeWeChatCode.mockResolvedValue({
      openid: 'wx-openid-1',
      unionid: 'wx-unionid-1'
    });

    pool.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-wechat-1',
          email: null,
          name: 'WeChat Existing',
          created_at: '2026-06-21T00:00:00Z',
          banned_at: null
        }]
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-wechat-1',
          email: null,
          name: 'WeChat Existing',
          created_at: '2026-06-21T00:00:00Z',
          banned_at: null
        }]
      });

    const res = await jsonRequest(server, 'POST', '/api/auth/wechat', { code: 'abc123' });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    expect(res.body.user.id).toBe('user-wechat-1');
    expect(exchangeWeChatCode).toHaveBeenCalledWith('abc123');
  });

  test('POST /api/auth/sms/request normalizes phone, stores hash, and sends SMS', async () => {
    const client = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] }),
      release: jest.fn()
    };
    pool.connect.mockResolvedValue(client);
    sendAliSms.mockResolvedValue({ Code: 'OK' });

    const res = await jsonRequest(server, 'POST', '/api/auth/sms/request', {
      phone: '138 0013 8000'
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(sendAliSms).toHaveBeenCalledTimes(1);
    expect(sendAliSms.mock.calls[0][0].phoneE164).toBe('+8613800138000');

    const insertCall = client.query.mock.calls.find((call) => /INSERT INTO sms_login_codes/i.test(call[0]));
    expect(insertCall).toBeTruthy();
    expect(insertCall[1][0]).toBe('+8613800138000');
    expect(insertCall[1][1]).toHaveLength(64);
  });

  test('POST /api/auth/sms/request enforces 3 per 5-minute rate limit', async () => {
    const client = {
      query: jest.fn()
        .mockResolvedValue({ rows: [] }),
      release: jest.fn()
    };
    pool.connect.mockResolvedValue(client);
    sendAliSms.mockResolvedValue({ Code: 'OK' });

    const phone = '13911112222';
    const r1 = await jsonRequest(server, 'POST', '/api/auth/sms/request', { phone });
    const r2 = await jsonRequest(server, 'POST', '/api/auth/sms/request', { phone });
    const r3 = await jsonRequest(server, 'POST', '/api/auth/sms/request', { phone });
    const r4 = await jsonRequest(server, 'POST', '/api/auth/sms/request', { phone });

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r3.status).toBe(200);
    expect(r4.status).toBe(429);
  });

  test('POST /api/auth/sms/verify accepts valid code and creates identity user', async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'sms-code-1',
          code_hash: sha256('123456'),
          attempts: 0
        }]
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-phone-1',
          email: null,
          name: 'PHONE User',
          created_at: '2026-06-21T00:00:00Z',
          banned_at: null
        }]
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-phone-1',
          email: null,
          name: 'PHONE User',
          created_at: '2026-06-21T00:00:00Z',
          banned_at: null
        }]
      });

    const res = await jsonRequest(server, 'POST', '/api/auth/sms/verify', {
      phone: '+8613800138000',
      code: '123456'
    });

    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    expect(res.body.user.id).toBe('user-phone-1');
  });
});
