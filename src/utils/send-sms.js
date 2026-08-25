// src/utils/send-sms.js
//
// SMS delivery seam. With FROG_* configured it sends through Frog (Wigal);
// without, it logs the message so dev and test runs need no provider. OTP
// codes must never be logged in production - only the destination is.
import ENV from "../config/env.js";
import { requestLogger } from "../utils/logger.js";

export async function sendSms(phone, message) {
  if (!ENV.FROG_API_KEY || !ENV.FROG_USERNAME || !ENV.FROG_SENDER_ID) {
    if (ENV.NODE_ENV === "production") {
      requestLogger().warn({ phone }, "SMS requested but no provider is configured");
      return;
    }
    requestLogger().info({ phone, message }, "SMS (log-only, no provider configured)");
    return;
  }

  const response = await fetch("https://frogapi.wigal.com.gh/api/v3/sms/send", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "API-KEY": ENV.FROG_API_KEY,
      USERNAME: ENV.FROG_USERNAME,
    },
    body: JSON.stringify({
      senderid: ENV.FROG_SENDER_ID,
      destinations: [{ destination: phone }],
      message,
      smstype: "text",
    }),
  });

  if (!response.ok) {
    throw new Error(`SMS provider responded ${response.status}`);
  }
}
