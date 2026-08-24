// src/mail/auth-emails.js
//
// Builders for the mail BeThere sends: the code someone needs to sign in, and
// the link back into an account. Each returns the send options minus the
// recipient, so a service adds `email` and hands the whole thing to the mailer
// or the queue - which keeps the copy in one place and the services readable.
//
// Every builder ships a plain-text `text` alongside the template data: clients
// that refuse HTML, and gateways that strip it, still get the code or link.
const TEMPLATE = "message.ejs";

const IGNORE_NOTE = "Did not request this? You can ignore this email.";

/**
 * A one-time code: login, or verifying a new account.
 *
 * @param {Object} params
 * @param {string} params.label - "login" or "verification".
 * @param {string} params.code
 * @param {number} params.ttlMinutes
 */
export const buildOtpCodeEmail = ({ label, code, ttlMinutes }) => ({
  subject: `Your BeThere ${label} code`,
  template: TEMPLATE,
  data: {
    code,
    codeNote: `Expires in ${ttlMinutes} minutes.`,
    intro: [`Use this code to finish signing in.`],
    note: IGNORE_NOTE,
    preview: `Your ${label} code expires in ${ttlMinutes} minutes.`,
    title: `Your ${label} code`,
  },
  text: `Your BeThere ${label} code is ${code}. It expires in ${ttlMinutes} minutes.`,
});

/**
 * The password-reset link.
 *
 * @param {Object} params
 * @param {string} params.firstName
 * @param {string} params.resetLink
 * @param {number} params.ttlMinutes
 */
export const buildPasswordResetEmail = ({
  firstName,
  resetLink,
  ttlMinutes,
}) => ({
  subject: "Reset your BeThere password",
  template: TEMPLATE,
  data: {
    action: { label: "Reset password", url: resetLink },
    intro: [
      `Set a new password using the button below. The link works for ${ttlMinutes} minutes.`,
    ],
    name: firstName,
    note: "Did not request this? Your password stays as it is.",
    preview: `Reset your password within ${ttlMinutes} minutes.`,
    title: "Reset your password",
  },
  text:
    `Hi ${firstName},\n\n` +
    `Set a new password using the link below within ${ttlMinutes} minutes:\n\n` +
    `${resetLink}\n\n` +
    "Did not request this? You can ignore this email.",
});
