import crypto from "node:crypto";
import { promisify } from "node:util";
import { env } from "../config/env.js";

const scrypt = promisify(crypto.scrypt);

// scrypt parameters: N=2^15, r=8, p=1 (≈32 MiB, OWASP-recommended minimum).
const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 };

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password.normalize("NFKC"), salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export async function verifyPassword(password, stored) {
  if (!stored || typeof stored !== "string") return false;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, N, r, p, saltB64, keyB64] = parts;
  const expected = Buffer.from(keyB64, "base64url");
  const key = await scrypt(password.normalize("NFKC"), Buffer.from(saltB64, "base64url"), expected.length, {
    N: Number(N),
    r: Number(r),
    p: Number(p),
    maxmem: SCRYPT.maxmem,
  });
  return crypto.timingSafeEqual(key, expected);
}

// A precomputed hash used to spend equal time on unknown accounts (no user-enumeration timing signal).
let dummyHash;
export async function burnPasswordCheck(password) {
  dummyHash ??= await hashPassword(crypto.randomBytes(12).toString("hex"));
  await verifyPassword(password, dummyHash);
}

/** Password policy: length over composition rules (NIST SP 800-63B). */
export function passwordProblems(password, { username, email } = {}) {
  const problems = [];
  if (typeof password !== "string" || password.length < 10) problems.push("Use at least 10 characters");
  if (password && password.length > 128) problems.push("Use at most 128 characters");
  const lower = (password ?? "").toLowerCase();
  if (username && lower.includes(username.toLowerCase())) problems.push("Do not include your username");
  if (email && lower.includes(email.split("@")[0].toLowerCase())) problems.push("Do not include your email name");
  if (/^(.)\1+$/.test(password ?? "")) problems.push("Avoid repeating a single character");
  return problems;
}

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString("base64url");
export const sha256 = (value) => crypto.createHash("sha256").update(value).digest();

// Human-typeable one-time codes: 12 chars from an unambiguous alphabet (≈60 bits).
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export function generateOneTimeCode() {
  const bytes = crypto.randomBytes(12);
  let out = "";
  for (let i = 0; i < 12; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return `${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8)}`;
}
export function normalizeOneTimeCode(code) {
  return String(code ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}
/** Keyed hash for one-time codes, so a leaked table cannot be brute-forced offline without APP_SECRET. */
export function hashOneTimeCode(code) {
  return crypto.createHmac("sha256", env.appSecret).update(normalizeOneTimeCode(code)).digest();
}
