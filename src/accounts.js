// Conturile dispecerilor și administratorilor: autentificare, sesiuni, administrare.
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { hashSecret, verifySecret, isValidPassword, temporaryPassword, hashToken } = require('./secret');

const ROLES = ['admin', 'dispatcher'];
const ROLE_LABELS = { admin: 'administrator', dispatcher: 'dispecer' };
// Sesiunea expiră după această perioadă fără activitate, sau oricum după 7 zile.
const DEFAULT_IDLE_MS = 12 * 60 * 60 * 1000;
const MAX_SESSION_MS = 7 * 24 * 60 * 60 * 1000;
// Ultima activitate se scrie în baza de date cel mult o dată pe minut.
const TOUCH_INTERVAL_MS = 60 * 1000;
// Pentru un utilizator inexistent verificăm totuși o parolă, ca timpul de răspuns să nu-l dezvăluie.
const DUMMY_HASH = hashSecret('utilizator-inexistent');

function cleanText(value, maxLength) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') return null;
  return value.trim().slice(0, maxLength);
}

/**
 * Emite 'sessions:revoked' ({ userId, exceptSessionId }) când sesiunile unui utilizator trebuie
 * închise (cont dezactivat, parolă resetată sau schimbată) și 'session:revoked' (sessionId) la ieșire.
 */
class Accounts extends EventEmitter {
  constructor({ repo, now = Date.now, sessionIdleMs = DEFAULT_IDLE_MS }) {
    super();
    this.repo = repo;
    this.now = now;
    this.sessionIdleMs = sessionIdleMs;
  }

  publicUser(user) {
    return {
      id: user.id,
      username: user.username,
      name: user.name,
      role: user.role,
      active: user.active,
      mustChangePassword: user.mustChangePassword,
      createdAt: user.createdAt,
      lastLoginAt: user.lastLoginAt,
    };
  }

  /** Prima pornire: creează contul „admin” dacă nu există niciun utilizator. */
  ensureAdmin(password, { mustChangePassword = false } = {}) {
    if (this.repo.countUsers() > 0) return null;
    if (!password) {
      throw new Error('Nu există niciun cont. Setați ADMIN_PASSWORD pentru a crea contul de administrator.');
    }
    const id = this.repo.insertUser({
      username: 'admin',
      name: 'Administrator',
      passwordHash: hashSecret(password),
      role: 'admin',
      active: true,
      mustChangePassword,
      createdAt: this.now(),
    });
    return this.publicUser(this.repo.userById(id));
  }

  // ---- Autentificare și sesiuni ----

  login(username, password, { ip = '', userAgent = '' } = {}) {
    const user = typeof username === 'string' && username.trim() ? this.repo.userByUsername(username.trim()) : null;
    const valid = verifySecret(typeof password === 'string' ? password : '', user ? user.passwordHash : DUMMY_HASH);
    if (!user || !valid || !user.active) return { ok: false, error: 'Utilizator sau parolă greșită' };

    const token = crypto.randomBytes(32).toString('base64url');
    const ts = this.now();
    this.repo.insertSession({
      tokenHash: hashToken(token),
      userId: user.id,
      createdAt: ts,
      lastSeenAt: ts,
      ip: String(ip).slice(0, 64),
      userAgent: String(userAgent).slice(0, 200),
    });
    user.lastLoginAt = ts;
    this.repo.updateUser(user);
    return { ok: true, token, user: this.publicUser(user) };
  }

  /** Utilizatorul sesiunii, sau null dacă sesiunea nu există, a expirat ori contul e dezactivat. */
  authenticate(token) {
    if (typeof token !== 'string' || !token) return null;
    const tokenHash = hashToken(token);
    const session = this.repo.session(tokenHash);
    if (!session) return null;
    const ts = this.now();
    if (ts - session.last_seen_at > this.sessionIdleMs || ts - session.created_at > MAX_SESSION_MS) {
      this.repo.deleteSession(tokenHash);
      return null;
    }
    const user = this.repo.userById(session.user_id);
    if (!user || !user.active) {
      this.repo.deleteSession(tokenHash);
      return null;
    }
    if (ts - session.last_seen_at >= TOUCH_INTERVAL_MS) this.repo.touchSession(tokenHash, ts);
    return { ...this.publicUser(user), sessionId: tokenHash };
  }

  logout(token) {
    if (typeof token !== 'string' || !token) return;
    const tokenHash = hashToken(token);
    this.repo.deleteSession(tokenHash);
    this.emit('session:revoked', tokenHash);
  }

  /** Utilizatorul își schimbă parola; celelalte sesiuni ale lui se închid, cea curentă rămâne. */
  changePassword(userId, currentPassword, newPassword, currentSessionId = '') {
    const user = this.repo.userById(userId);
    if (!user || !verifySecret(typeof currentPassword === 'string' ? currentPassword : '', user.passwordHash)) {
      return { ok: false, error: 'Parola actuală este greșită' };
    }
    if (!isValidPassword(newPassword)) return { ok: false, error: 'Parola nouă trebuie să aibă cel puțin 8 caractere' };
    if (newPassword === currentPassword) return { ok: false, error: 'Parola nouă trebuie să fie diferită de cea actuală' };
    user.passwordHash = hashSecret(newPassword);
    user.mustChangePassword = false;
    this.repo.updateUser(user);
    this._revokeSessions(user.id, currentSessionId);
    return { ok: true, user: this.publicUser(user) };
  }

  pruneSessions() {
    const ts = this.now();
    return this.repo.pruneSessions(ts - this.sessionIdleMs, ts - MAX_SESSION_MS);
  }

  // ---- Administrarea utilizatorilor ----

  listUsers() {
    const sessions = this.repo.sessionCounts(this.now() - this.sessionIdleMs);
    return this.repo.listUsers().map((u) => ({ ...this.publicUser(u), activeSessions: sessions.get(u.id) || 0 }));
  }

  getUser(id) {
    const user = this.repo.userById(id);
    return user ? this.publicUser(user) : null;
  }

  _validateUser(input, userId) {
    if (!input || typeof input !== 'object') return { error: 'Date lipsă' };
    const name = cleanText(input.name, 80);
    const username = cleanText(input.username, 32);
    if (name === null || username === null) return { error: 'Date invalide' };
    if (!name) return { error: 'Introduceți numele' };
    const normalized = username.toLowerCase();
    if (!/^[a-z0-9._-]{3,32}$/.test(normalized)) {
      return { error: 'Numele de utilizator: 3–32 caractere, doar litere fără diacritice, cifre, „.”, „_” sau „-”' };
    }
    const existing = this.repo.userByUsername(normalized);
    if (existing && existing.id !== userId) return { error: `Utilizatorul „${normalized}” există deja` };
    if (!ROLES.includes(input.role)) return { error: 'Alegeți rolul' };
    return { name, username: normalized, role: input.role };
  }

  /** Contul nou primește o parolă temporară, pe care utilizatorul o schimbă la prima autentificare. */
  createUser(input) {
    const data = this._validateUser(input, null);
    if (data.error) return { ok: false, error: data.error };
    const password = temporaryPassword();
    const id = this.repo.insertUser({
      ...data,
      passwordHash: hashSecret(password),
      active: true,
      mustChangePassword: true,
      createdAt: this.now(),
    });
    return { ok: true, user: this.getUser(id), temporaryPassword: password };
  }

  /** Modifică nume / utilizator / rol. Întoarce și `changes` ({ câmp: [vechi, nou] }) pentru jurnal. */
  updateUser(id, input, actorId) {
    const user = this.repo.userById(id);
    if (!user) return { ok: false, error: 'Utilizator inexistent' };
    const data = this._validateUser(input, id);
    if (data.error) return { ok: false, error: data.error };
    if (data.role !== user.role) {
      if (id === actorId) return { ok: false, error: 'Nu vă puteți schimba propriul rol' };
      if (user.role === 'admin' && user.active && this.repo.countActiveAdmins() <= 1) {
        return { ok: false, error: 'Trebuie să rămână cel puțin un administrator activ' };
      }
    }
    const changes = {};
    for (const field of ['name', 'username', 'role']) {
      if (user[field] !== data[field]) changes[field] = [user[field], data[field]];
    }
    Object.assign(user, data);
    this.repo.updateUser(user);
    return { ok: true, user: this.publicUser(user), changes };
  }

  /** Parolă temporară nouă (ex. parolă uitată); sesiunile deschise ale utilizatorului se închid. */
  resetPassword(id, actorId) {
    const user = this.repo.userById(id);
    if (!user) return { ok: false, error: 'Utilizator inexistent' };
    if (id === actorId) return { ok: false, error: 'Pentru contul propriu folosiți „Schimbă parola”' };
    const password = temporaryPassword();
    user.passwordHash = hashSecret(password);
    user.mustChangePassword = true;
    this.repo.updateUser(user);
    this._revokeSessions(user.id);
    return { ok: true, user: this.publicUser(user), temporaryPassword: password };
  }

  setActive(id, active, actorId) {
    const user = this.repo.userById(id);
    if (!user) return { ok: false, error: 'Utilizator inexistent' };
    if (user.active === Boolean(active)) return { ok: true, user: this.publicUser(user), changed: false };
    if (!active) {
      if (id === actorId) return { ok: false, error: 'Nu vă puteți dezactiva propriul cont' };
      if (user.role === 'admin' && this.repo.countActiveAdmins() <= 1) {
        return { ok: false, error: 'Trebuie să rămână cel puțin un administrator activ' };
      }
    }
    user.active = Boolean(active);
    this.repo.updateUser(user);
    if (!user.active) this._revokeSessions(user.id);
    return { ok: true, user: this.publicUser(user), changed: true };
  }

  _revokeSessions(userId, exceptSessionId = '') {
    this.repo.deleteUserSessions(userId, exceptSessionId);
    this.emit('sessions:revoked', { userId, exceptSessionId });
  }
}

module.exports = { Accounts, ROLES, ROLE_LABELS };
