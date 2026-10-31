import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Users' Jira tokens and LLM keys are kept sealed (AES-256-GCM). The key comes from SECRET_KEY, or
 * from a file made on first start next to the database, readable by the service user only.
 */
let key: Buffer | null = null;

export function initSecrets(file: string) {
  let secret = process.env.SECRET_KEY;
  if (!secret) {
    if (!existsSync(file)) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, randomBytes(32).toString('base64url'), { mode: 0o600 });
    }
    secret = readFileSync(file, 'utf8').trim();
  }
  key = createHash('sha256').update(secret).digest();
}

function k(): Buffer {
  if (!key) throw new Error('secrets are not initialised');
  return key;
}

export function seal(text: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', k(), iv);
  const body = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return `v1:${Buffer.concat([iv, c.getAuthTag(), body]).toString('base64url')}`;
}

export function unseal(sealed: string): string {
  if (!sealed.startsWith('v1:')) throw new Error('unknown sealed format');
  const raw = Buffer.from(sealed.slice(3), 'base64url');
  const d = createDecipheriv('aes-256-gcm', k(), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
}
