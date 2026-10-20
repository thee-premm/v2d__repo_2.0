import { env } from "../config/env.js";
import { logger } from "./logger.js";

/**
 * Outbound email. No SMTP provider is integrated yet (see docs/DEPLOYMENT.md):
 *   log       development only — the message is written to the server log
 *   disabled  nothing is sent; callers must not claim delivery
 * Returns true only when a message was actually handed to a transport.
 */
export async function sendMail({ to, subject, text }) {
  if (env.mailTransport === "log" && !env.isProduction) {
    logger.info("[mail:log transport] message not delivered — development output only", { to, subject, body: text });
    return true;
  }
  return false;
}

export const mailEnabled = () => env.mailTransport !== "disabled" && !env.isProduction;
