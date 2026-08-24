// src/utils/render-template.js
//
// Renders an EJS template from src/ejs into the HTML body of an email. Every
// template gets the brand values below without any builder passing them, so a
// rebrand is a one-line change here rather than an edit to every message.
import ejs from "ejs";
import path from "path";
import { fileURLToPath } from "url";
import ENV from "../config/env.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** FRONTEND_URL without a trailing slash, so joins never double up. */
const siteUrl = ENV.FRONTEND_URL.replace(/\/+$/, "");

/**
 * The app's palette, flattened to hex - email clients have no HSL custom
 * properties. Near-black surfaces with the one green accent, the way the
 * console uses it.
 */
export const BRAND = {
  /** The brand green: rules, the code plate's digits, the tagline. */
  accent: "#10a674",
  /** Body text. */
  ink: "#1d2320",
  /** Secondary text on a pale background. */
  muted: "#6b7472",
  /** Secondary text on a dark band. */
  mutedOnDark: "#9aa5a1",
  /** The dark band behind the masthead and footer. */
  night: "#131c18",
  /** The sheet the message is printed on. */
  paper: "#ffffff",
  /** Buttons and rules that need to carry weight. */
  primary: "#10a674",
  /** Dark enough for link text on a pale background. */
  primaryDeep: "#0b7a55",
  /** Hairlines between rows. */
  rule: "#dfe4e2",
  /** The page behind the card. */
  surface: "#f2f4f3",
  /** Tint for detail blocks. */
  surfaceAlt: "#f8faf9",
};

const brandDefaults = {
  brand: BRAND,
  brandName: "BeThere",
  brandTagline: "Attendance, in person",
  /** Hosted rather than a cid attachment: an inline image makes every message
   * arrive wearing a paperclip, and it only resolves once the URL is public
   * https - an inbox cannot fetch localhost. */
  logoUrl:
    ENV.EMAIL_LOGO_URL ??
    (siteUrl.startsWith("https") ? `${siteUrl}/logo.png` : null),
  siteUrl,
};

/**
 * Constrains a URL to http(s) before it lands in an href. Anything else
 * (javascript:, data:) collapses to the site root - a useless link beats a
 * script-in-mail-client vector.
 */
const safeUrl = (url) => (/^https?:\/\//i.test(url) ? url : siteUrl);

export const renderTemplate = async (template, data) => {
  const action = data.action;
  return ejs.renderFile(path.join(__dirname, "../ejs", template), {
    ...brandDefaults,
    ...data,
    ...(action ? { action: { ...action, url: safeUrl(action.url) } } : {}),
  });
};
