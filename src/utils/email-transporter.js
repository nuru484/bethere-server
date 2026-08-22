// src/utils/email-transporter.js
import nodemailer from "nodemailer";
import ENV from "../config/env.js";

// SMTP transporter driven entirely by config: host/port/secure come from ENV,
// so the same code works with Gmail or any other provider. No `service`
// shorthand - it silently overrides SMTP_HOST/PORT/SECURE.
export const createEmailTransporter = () => {
  return nodemailer.createTransport({
    host: ENV.SMTP_HOST,
    port: ENV.SMTP_PORT,
    secure: ENV.SMTP_SECURE,
    auth: {
      user: ENV.GMAIL_USER,
      pass: ENV.GMAIL_PASSWORD,
    },
  });
};
