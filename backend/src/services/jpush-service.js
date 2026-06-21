const JPUSH_PUSH_URL = 'https://api.jpush.cn/v3/push';

function buildAuthHeader() {
  const appKey = process.env.JPUSH_APP_KEY;
  const masterSecret = process.env.JPUSH_MASTER_SECRET;
  if (!appKey || !masterSecret) {
    return null;
  }
  const credentials = Buffer.from(`${appKey}:${masterSecret}`).toString('base64');
  return `Basic ${credentials}`;
}

async function sendJpushSos(registrationIds = [], triggeredBy = {}, location = {}) {
  if (!Array.isArray(registrationIds) || registrationIds.length === 0) {
    return;
  }

  const authHeader = buildAuthHeader();
  if (!authHeader) {
    console.error('[push:jpush] Missing JPUSH_APP_KEY or JPUSH_MASTER_SECRET');
    return;
  }

  const alertBody = `${triggeredBy.name || 'A teammate'} needs help`;
  const iosBody =
    location.lat != null && location.lng != null
      ? `${alertBody} at ${location.lat},${location.lng}`
      : alertBody;
  const extras = {
    type: 'sos_alert',
    user_id: triggeredBy.id,
    username: triggeredBy.name,
    lat: location.lat,
    lng: location.lng,
    group_id: location.group_id || null,
  };

  const body = {
    platform: 'all',
    audience: { registration_id: registrationIds },
    notification: {
      alert: `SOS Alert: ${triggeredBy.name || 'Teammate'}`,
      android: {
        title: 'SOS Alert',
        alert: alertBody,
        extras,
      },
      ios: {
        alert: {
          title: 'SOS Alert',
          body: iosBody,
        },
        extras,
        'content-available': true,
        apns_production: process.env.JPUSH_APNS_PRODUCTION === 'true',
      },
    },
    options: {
      apns_production: process.env.JPUSH_APNS_PRODUCTION === 'true',
    },
  };

  try {
    const response = await fetch(JPUSH_PUSH_URL, {
      method: 'POST',
      headers: {
        Authorization: authHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`HTTP ${response.status} ${errText}`);
    }
  } catch (error) {
    console.error('[push:jpush] JPush API error:', error.message);
  }
}

module.exports = {
  sendJpushSos,
};
