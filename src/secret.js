// Parolele dispecerilor și PIN-urile șoferilor se păstrează doar ca hash (scrypt), niciodată în clar.
const crypto = require('crypto');

const KEY_LENGTH = 32;
// Fără caractere ușor de confundat (0/O, 1/l/I) pentru parolele temporare dictate sau copiate.
const READABLE = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';

function hashSecret(secret) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(secret), salt, KEY_LENGTH);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifySecret(secret, stored) {
  if (typeof secret !== 'string' || typeof stored !== 'string') return false;
  const [algorithm, saltHex, hashHex] = stored.split('$');
  if (algorithm !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(secret, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

function isValidPin(pin) {
  return typeof pin === 'string' && /^\d{4,12}$/.test(pin);
}

function isValidPassword(password) {
  return typeof password === 'string' && password.length >= 8 && password.length <= 128;
}

function temporaryPassword(length = 12) {
  let out = '';
  for (const byte of crypto.randomBytes(length)) out += READABLE[byte % READABLE.length];
  return out;
}

/** Tokenul de sesiune se păstrează în baza de date doar ca hash SHA-256. */
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

module.exports = { hashSecret, verifySecret, isValidPin, isValidPassword, temporaryPassword, hashToken };
