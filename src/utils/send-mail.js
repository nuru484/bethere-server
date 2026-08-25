// src/utils/send-mail.js
import { Resend } from "resend";
import ENV from "../config/env.js";
import { renderTemplate } from "./render-template.js";
import { requestLogger } from "./logger.js";

const resend = ENV.RESEND_API_KEY ? new Resend(ENV.RESEND_API_KEY) : null;

/**
 * Sends a transactional email over the Resend HTTP API. Without
 * RESEND_API_KEY the message is logged instead of sent, so auth flows stay
 * exercisable in development and CI without an account.
 *
 * THROWS on a refused send, deliberately. Two kinds of caller sit above it
 * and they want opposite things: the mail queue retries the job and keeps
 * what it cannot deliver on the failed set, while a caller waiting on a code
 * turns the failure into a message the person can act on. A caller that
 * genuinely wants fire-and-forget goes through the queue, which is where
 * failures are swallowed and logged.
 *
 * @param {Object} options
 * @param {string} options.email - Recipient address.
 * @param {string} options.subject
 * @param {string} [options.template] - EJS file under src/ejs.
 * @param {Object} [options.data] - Data for the template.
 * @param {string} [options.text] - Plain-text body; always sent when present.
 * @returns {Promise<void>}
 */
const sendMail = async (options) => {
  const { email, subject, template, data, text } = options;

  const html = template && data ? await renderTemplate(template, data) : "";

  if (!resend) {
    requestLogger().info(
      { to: email, subject, text },
      "RESEND_API_KEY not set - email logged instead of sent"
    );
    return;
  }

  // Resend's request type demands a definite html or text body, so pick the
  // branch rather than passing an undefined field.
  const base = { from: ENV.MAIL_FROM, to: email, subject };
  const { error } = html
    ? await resend.emails.send({ ...base, html, text })
    : await resend.emails.send({ ...base, text: text ?? "" });

  // Resend reports failures as a result value rather than a rejection; make
  // it a throw so every caller above sees delivery problems the same way.
  if (error) {
    throw new Error(`Resend send failed: ${error.name}: ${error.message}`);
  }
};

export default sendMail;
