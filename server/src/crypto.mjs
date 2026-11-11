import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export function token(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

export function pkcePair() {
  const verifier = token(48);
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function sameString(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && timingSafeEqual(x, y);
}

function keyOf(secret) {
  if (!secret) throw new Error('STATED_TOKEN_KEY is not set. Bot tokens are not stored in plain text.');
  return createHash('sha256').update(secret).digest();
}

export function seal(plain, secret) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyOf(secret), iv);
  const body = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join('.');
}

export function open(sealed, secret) {
  const [version, iv, tag, body] = String(sealed || '').split('.');
  if (version !== 'v1') throw new Error('Unknown token format.');
  const decipher = createDecipheriv('aes-256-gcm', keyOf(secret), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
}
