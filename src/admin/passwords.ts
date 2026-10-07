// Admin console credentials: scrypt password hashes, generated passwords, and
// session tokens. Node's built-in crypto only — no native dependency.

import { randomBytes, randomInt, scrypt as scryptCb, timingSafeEqual, createHash } from 'node:crypto';

const N = 16384, R = 8, P = 1, KEYLEN = 64;
export const MIN_PASSWORD_LENGTH = 12;

function scrypt(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCb(password.normalize('NFKC'), salt, KEYLEN, { N: n, r, p, maxmem: 64 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key))));
}

/** `scrypt$N$r$p$<salt b64>$<hash b64>` */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, N, R, P);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [n, r, p] = parts.slice(1, 4).map(Number);
  if (!n || !r || !p) return false;
  const expected = Buffer.from(parts[5]!, 'base64');
  const key = await scrypt(password, Buffer.from(parts[4]!, 'base64'), n, r, p);
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** A hash to verify against when the user doesn't exist, so a miss costs the same time as a hit. */
let dummyHash: Promise<string> | null = null;
export function dummyPasswordHash(): Promise<string> { return (dummyHash ??= hashPassword(randomBytes(16).toString('hex'))); }

// No look-alikes (0/O, 1/l/I) — these get read off a terminal and typed in.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

/** A random password: 4 groups of 5 (~117 bits), e.g. `h7Kqm-2xWpa-...`. */
export function generatePassword(): string {
  const groups: string[] = [];
  for (let g = 0; g < 4; g++) {
    let s = '';
    for (let i = 0; i < 5; i++) s += ALPHABET[randomInt(ALPHABET.length)];
    groups.push(s);
  }
  return groups.join('-');
}

/** Why a chosen password is refused, or null when it is acceptable. */
export function passwordProblem(password: unknown, username?: string): string | null {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (password.length > 256) return 'Use at most 256 characters.';
  if (username && password.toLowerCase().includes(username.toLowerCase())) return 'The password must not contain the username.';
  if (new Set(password).size < 5) return 'The password is too repetitive.';
  return null;
}

export function newSessionToken(): string { return randomBytes(32).toString('base64url'); }
export function hashToken(token: string): string { return createHash('sha256').update(token).digest('hex'); }

const USERNAME = /^[A-Za-z0-9][A-Za-z0-9._@-]{1,63}$/;
export function validUsername(u: unknown): u is string { return typeof u === 'string' && USERNAME.test(u); }
