import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/** Opaque 256-bit token from the CSPRNG (SEC-AUTH-003). */
export const newToken = (): string => randomBytes(32).toString('base64url');

/** Only this hash is stored; the token itself never touches the database. */
export const hashToken = (token: string): Buffer => createHash('sha256').update(token, 'utf8').digest();

const IV_BYTES = 12;
const TAG_BYTES = 16;

/** AES-256-GCM; output is iv | tag | ciphertext. aad binds the ciphertext to its owner row. */
export const encrypt = (key: Buffer, plaintext: string, aad: string): Buffer => {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]);
};

export const decrypt = (key: Buffer, blob: Buffer, aad: string): string => {
  const iv = blob.subarray(0, IV_BYTES);
  const tag = blob.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(blob.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8');
};
