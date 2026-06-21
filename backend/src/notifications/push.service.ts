import axios from 'axios';

// Alibaba Cloud Mobile Push (阿里云移动推送)
// Handles APNs (iOS) + all Chinese Android OEM channels (HMS/MiPush/OPPO/VIVO)
// Docs: https://help.aliyun.com/product/30047.html

const ACCESS_KEY_ID = process.env.ALIYUN_ACCESS_KEY_ID ?? '';
const ACCESS_KEY_SECRET = process.env.ALIYUN_ACCESS_KEY_SECRET ?? '';
const APP_KEY = process.env.PUSH_APP_KEY ?? '';

interface PushPayload {
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

export async function sendPush(userId: string, payload: PushPayload): Promise<void> {
  if (!APP_KEY) {
    console.log(`[PUSH MOCK] To user: ${userId} | ${payload.title}: ${payload.body}`);
    return;
  }

  // In production: look up device push token from DB and call Alibaba Push API
  // Using account-based push here (pushes to all devices registered to userId)
  console.log(`[PUSH] Sending to ${userId}:`, payload);

  // TODO: implement Alibaba Cloud Mobile Push API call
  // Reference: https://help.aliyun.com/document_detail/48085.html
}
