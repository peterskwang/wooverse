const crypto = require('crypto');
const https = require('https');

const ALI_SMS_HOST = 'dysmsapi.aliyuncs.com';
const ALI_SMS_VERSION = '2017-05-25';
const ALI_SMS_REGION = 'cn-hangzhou';

function percentEncode(value) {
  return encodeURIComponent(value)
    .replace(/\+/g, '%20')
    .replace(/\*/g, '%2A')
    .replace(/%7E/g, '~');
}

function buildCanonicalQuery(params) {
  return Object.keys(params)
    .sort()
    .map((key) => `${percentEncode(key)}=${percentEncode(params[key])}`)
    .join('&');
}

function iso8601UtcNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function signQuery(accessKeySecret, canonicalQuery) {
  const stringToSign = `GET&${percentEncode('/')}&${percentEncode(canonicalQuery)}`;
  return crypto
    .createHmac('sha1', `${accessKeySecret}&`)
    .update(stringToSign)
    .digest('base64');
}

function sendAliSms({ phoneE164, code }) {
  return new Promise((resolve, reject) => {
    const accessKeyId = process.env.ALI_SMS_ACCESS_KEY_ID;
    const accessKeySecret = process.env.ALI_SMS_ACCESS_KEY_SECRET;
    const signName = process.env.ALI_SMS_SIGN_NAME;
    const templateCode = process.env.ALI_SMS_TEMPLATE_CODE;

    if (!accessKeyId || !accessKeySecret || !signName || !templateCode) {
      return reject(new Error('Ali SMS env vars missing'));
    }

    const params = {
      Action: 'SendSms',
      Version: ALI_SMS_VERSION,
      RegionId: ALI_SMS_REGION,
      Format: 'JSON',
      SignatureMethod: 'HMAC-SHA1',
      SignatureVersion: '1.0',
      SignatureNonce: crypto.randomUUID(),
      Timestamp: iso8601UtcNow(),
      AccessKeyId: accessKeyId,
      PhoneNumbers: phoneE164,
      SignName: signName,
      TemplateCode: templateCode,
      TemplateParam: JSON.stringify({ code })
    };

    const canonicalQuery = buildCanonicalQuery(params);
    const signature = signQuery(accessKeySecret, canonicalQuery);
    const query = `Signature=${percentEncode(signature)}&${canonicalQuery}`;
    const path = `/?${query}`;

    const req = https.request(
      {
        method: 'GET',
        hostname: ALI_SMS_HOST,
        path
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          try {
            const payload = JSON.parse(body || '{}');
            if (payload.Code !== 'OK') {
              return reject(new Error(`Ali SMS send failed: ${payload.Message || payload.Code || 'Unknown error'}`));
            }
            resolve(payload);
          } catch (e) {
            reject(new Error(`Ali SMS invalid response: ${e.message}`));
          }
        });
      }
    );

    req.on('error', (err) => {
      reject(new Error(`Ali SMS request failed: ${err.message}`));
    });
    req.end();
  });
}

module.exports = { sendAliSms };
