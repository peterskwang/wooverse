import crypto from 'crypto';
import zlib from 'zlib';

// Tencent TRTC UserSig generation
// Docs: https://cloud.tencent.com/document/product/647/17275

const TRTC_SDK_APP_ID = parseInt(process.env.TRTC_SDK_APP_ID ?? '0');
const TRTC_SECRET_KEY = process.env.TRTC_SECRET_KEY ?? '';
const SIG_EXPIRE_SECONDS = 86400 * 7; // 7 days

export function generateTrtcCredentials(channelId: string, userId: string) {
  const userSig = genUserSig(userId);
  return {
    sdkAppId: TRTC_SDK_APP_ID,
    userId,
    userSig,
    // roomId mapped from channelId — use numeric hash for TRTC room
    roomId: channelIdToRoomId(channelId),
    expireAt: Math.floor(Date.now() / 1000) + SIG_EXPIRE_SECONDS,
  };
}

// Map channel UUID to a stable numeric TRTC room ID (1 ~ 4294967295)
function channelIdToRoomId(channelId: string): number {
  const hash = crypto.createHash('md5').update(channelId).digest('hex');
  return (parseInt(hash.slice(0, 8), 16) % 4294967294) + 1;
}

function genUserSig(userId: string): string {
  const currTime = Math.floor(Date.now() / 1000);
  const rawContent = buildUserSigContent(currTime, userId);
  const sig = hmacSha256(rawContent);
  const compressed = compressAndEncode(rawContent);
  return `${compressed}.${sig}`;
}

function buildUserSigContent(currTime: number, userId: string): string {
  return [
    'TLS.identifier:' + userId,
    'TLS.sdkappid:' + TRTC_SDK_APP_ID,
    'TLS.time:' + currTime,
    'TLS.expire:' + SIG_EXPIRE_SECONDS,
  ].join('\n') + '\n';
}

function hmacSha256(content: string): string {
  return crypto.createHmac('sha256', TRTC_SECRET_KEY).update(content).digest('base64');
}

function compressAndEncode(content: string): string {
  const identifier = content.match(/identifier:(.+)/)?.[1]?.trim() ?? '';
  const time = parseInt(content.match(/time:(\d+)/)?.[1] ?? '0');

  const json = JSON.stringify({
    TLS_ver: '2.0',
    identifier,
    sdkappid: TRTC_SDK_APP_ID,
    time,
    expire: SIG_EXPIRE_SECONDS,
    userbuf: '',
  });
  const compressed = zlib.deflateSync(Buffer.from(json));
  return compressed.toString('base64url');
}
