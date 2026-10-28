// PIN-urile șoferilor se păstrează doar ca hash (scrypt), niciodată în clar.
const crypto = require('crypto');

const KEY_LENGTH = 32;

function hashPin(pin) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pin), salt, KEY_LENGTH);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPin(pin, stored) {
  if (typeof pin !== 'string' || typeof stored !== 'string') return false;
  const [algorithm, saltHex, hashHex] = stored.split('$');
  if (algorithm !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(pin, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

function isValidPin(pin) {
  return typeof pin === 'string' && /^\d{4,12}$/.test(pin);
}

module.exports = { hashPin, verifyPin, isValidPin };
