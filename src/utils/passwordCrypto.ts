// Client-side salted PBKDF2-SHA256 password hashing & verification using Web Crypto API.

const PBKDF2_ITERATIONS = 100_000;

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim();
  const len = Math.floor(clean.length / 2);
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export function normalizePhoneForPassword(phone: string): string {
  return phone.trim().replace(/\s+/g, '');
}

export async function hashPassword(plainPassword: string, existingSaltHex?: string): Promise<{
  salt: string;
  hash: string;
}> {
  const normalized = plainPassword.trim();
  const saltBytes = existingSaltHex
    ? hexToBytes(existingSaltHex)
    : crypto.getRandomValues(new Uint8Array(16));
  const saltHex = bytesToHex(saltBytes);

  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(normalized),
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: saltBytes.buffer as ArrayBuffer,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    256
  );

  return {
    salt: saltHex,
    hash: bytesToHex(new Uint8Array(derivedBits)),
  };
}

export async function verifyPassword(
  plainPassword: string,
  saltHex: string,
  expectedHashHex: string
): Promise<boolean> {
  if (!plainPassword || !saltHex || !expectedHashHex) return false;
  const { hash } = await hashPassword(plainPassword, saltHex);
  return constantTimeEqualHex(hash, expectedHashHex);
}
