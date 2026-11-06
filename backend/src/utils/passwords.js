// Password hashing using Node's built-in crypto.scrypt -- deliberately NOT
// bcrypt/argon2, to avoid adding a native-compiled dependency (bcrypt) or a
// new package at all for something Node already does securely. scrypt is a
// standard, memory-hard KDF; this follows Node's own documented pattern
// (https://nodejs.org/api/crypto.html#using-strings-as-inputs) of storing
// `salt:hash` together so verification never needs a second lookup.
import { scrypt, randomBytes, timingSafeEqual } from 'crypto';
import { promisify } from 'util';

const scryptAsync = promisify(scrypt);
const KEY_LENGTH = 64;

export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const derived = await scryptAsync(password, salt, KEY_LENGTH);
  return `${salt}:${derived.toString('hex')}`;
}

export async function verifyPassword(password, stored) {
  if (typeof stored !== 'string' || !stored.includes(':')) return false;
  const [salt, hashHex] = stored.split(':');
  if (!salt || !hashHex) return false;
  const derived = await scryptAsync(password, salt, KEY_LENGTH);
  const storedBuf = Buffer.from(hashHex, 'hex');
  // Length check before timingSafeEqual: it throws on mismatched lengths
  // rather than returning false, and the length check itself doesn't leak
  // timing-exploitable information the way comparing byte content would.
  return storedBuf.length === derived.length && timingSafeEqual(storedBuf, derived);
}
