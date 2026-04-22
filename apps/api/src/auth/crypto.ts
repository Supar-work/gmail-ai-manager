import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { env } from '../env.js';

const KEY = Buffer.from(env.TOKEN_ENC_KEY, 'base64');
if (KEY.length !== 32) {
  throw new Error(`TOKEN_ENC_KEY must decode to 32 bytes (got ${KEY.length})`);
}

const IV_LEN = 12;
const TAG_LEN = 16;

export function encrypt(plaintext: string): Buffer {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]);
}

export function decrypt(buf: Buffer): string {
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const enc = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}
