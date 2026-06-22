const https = require('https');
const querystring = require('querystring');

function exchangeWeChatCode(code) {
  return new Promise((resolve, reject) => {
    const appId = process.env.WECHAT_APP_ID;
    const appSecret = process.env.WECHAT_APP_SECRET;

    if (!appId || !appSecret) {
      return reject(new Error('WeChat env vars missing'));
    }

    const query = querystring.stringify({
      appid: appId,
      secret: appSecret,
      code,
      grant_type: 'authorization_code'
    });
    const path = `/sns/oauth2/access_token?${query}`;

    const req = https.request(
      {
        method: 'POST',
        hostname: 'api.weixin.qq.com',
        path,
        headers: {
          'Content-Length': 0
        }
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          try {
            const payload = JSON.parse(body || '{}');
            if (payload.errcode) {
              return reject(new Error(`WeChat exchange failed: ${payload.errmsg || payload.errcode}`));
            }
            if (!payload.openid) {
              return reject(new Error('WeChat exchange missing openid'));
            }
            resolve({
              openid: payload.openid,
              unionid: payload.unionid || null
            });
          } catch (e) {
            reject(new Error(`WeChat exchange invalid response: ${e.message}`));
          }
        });
      }
    );

    req.on('error', (err) => {
      reject(new Error(`WeChat exchange request failed: ${err.message}`));
    });
    req.end();
  });
}

module.exports = { exchangeWeChatCode };
