// API-ul REST al dispeceratului: autentificare, istoric, flotă, utilizatori, jurnal.
const express = require('express');
const { rideViewForDispatcher } = require('./views');
const { carChangeSummary, userChangeSummary, userLabel, AUDIT_CATEGORIES } = require('./audit');
const { ROLE_LABELS } = require('./accounts');

const SESSION_COOKIE = 'taxi_session';
const COOKIE_MAX_AGE_S = 7 * 24 * 60 * 60;
const MAX_PAGE_SIZE = 10000;
// Cu o parolă temporară se poate doar vedea contul, schimba parola sau ieși.
const ALLOWED_BEFORE_PASSWORD_CHANGE = new Set(['/me', '/me/password', '/logout']);
const STATUS_FILTER_LABELS = { active: 'în desfășurare', completed: 'finalizate', cancelled: 'anulate' };

function parseCookies(header) {
  const cookies = {};
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    try {
      cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      // cookie malformat: ignorat
    }
  }
  return cookies;
}

function sessionToken(cookieHeader) {
  return parseCookies(cookieHeader)[SESSION_COOKIE] || '';
}

function hostnameOf(value, isUrl) {
  try {
    return new URL(isUrl ? value : `http://${value}`).hostname;
  } catch {
    return null;
  }
}

/** Cererea vine din paginile aplicației? (fără antet Origin: client non-browser, acceptat) */
function sameOrigin(origin, hostname) {
  return !origin || (hostnameOf(origin, true) !== null && hostnameOf(origin, true) === hostname);
}

function sessionCookie(token, secure) {
  return [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${token ? COOKIE_MAX_AGE_S : 0}`,
    secure ? 'Secure' : '',
  ]
    .filter(Boolean)
    .join('; ');
}

const num = (v) => (v === undefined || v === '' ? NaN : Number(v));
const text = (v) => (typeof v === 'string' ? v.trim().slice(0, 100) : '');

function parsePage(query, defaultLimit) {
  return {
    limit: Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(num(query.limit)) || defaultLimit)),
    offset: Math.max(0, Math.trunc(num(query.offset)) || 0),
  };
}

/** Filtrele de căutare din query string (/api/rides?from=…&to=…&carId=…&status=…&q=…). */
function parseRideFilters(query) {
  const status = text(query.status);
  return {
    filters: {
      from: num(query.from),
      to: num(query.to),
      carId: text(query.carId),
      status: status in STATUS_FILTER_LABELS ? status : '',
      q: text(query.q),
    },
    page: parsePage(query, 50),
  };
}

function parseAuditFilters(query) {
  const userId = num(query.userId);
  const category = text(query.category);
  return {
    filters: {
      from: num(query.from),
      to: num(query.to),
      userId: Number.isInteger(userId) ? userId : undefined,
      category: AUDIT_CATEGORIES.includes(category) ? category : '',
    },
    page: parsePage(query, 100),
  };
}

function createApi({ store, accounts, audit, limiter, config }) {
  const api = express.Router();
  const day = new Intl.DateTimeFormat('ro-RO', { timeZone: config.timeZone, day: '2-digit', month: '2-digit', year: 'numeric' });

  // Cererile care modifică date trebuie să vină din paginile aplicației (pe lângă cookie-ul SameSite).
  api.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD' && !sameOrigin(req.get('origin'), req.hostname)) {
      return res.status(403).json({ error: 'Cerere respinsă' });
    }
    next();
  });
  api.use(express.json({ limit: '20kb' }));

  // ---- Autentificare ----

  api.post('/login', (req, res) => {
    if (limiter.blocked(req.ip)) {
      return res.status(429).json({ error: 'Prea multe încercări greșite. Reîncercați peste câteva minute.' });
    }
    const { username, password } = req.body || {};
    const result = accounts.login(username, password, { ip: req.ip, userAgent: req.get('user-agent') || '' });
    if (!result.ok) {
      limiter.fail(req.ip);
      audit.log(null, 'auth_login_failed', '', `utilizator „${text(username).slice(0, 40)}”`, req.ip);
      return res.status(401).json({ error: result.error });
    }
    res.set('Set-Cookie', sessionCookie(result.token, req.secure));
    audit.log(result.user, 'auth_login', `user:${result.user.id}`, '', req.ip);
    res.json({ user: result.user });
  });

  api.use((req, res, next) => {
    const token = sessionToken(req.headers.cookie);
    const user = accounts.authenticate(token);
    if (!user) {
      return res.status(401).json({ error: 'Sesiunea a expirat. Autentificați-vă din nou.', code: 'unauthenticated' });
    }
    if (user.mustChangePassword && !ALLOWED_BEFORE_PASSWORD_CHANGE.has(req.path)) {
      return res.status(403).json({ error: 'Schimbați mai întâi parola temporară.', code: 'password_change_required' });
    }
    req.user = user;
    req.sessionToken = token;
    next();
  });

  const requireAdmin = (req, res, next) =>
    req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Doar administratorii au acces la această acțiune.' });

  const me = (user) => accounts.publicUser(user);

  api.get('/me', (req, res) => res.json({ user: me(req.user) }));

  api.post('/logout', (req, res) => {
    accounts.logout(req.sessionToken);
    audit.log(req.user, 'auth_logout', `user:${req.user.id}`, '', req.ip);
    res.set('Set-Cookie', sessionCookie('', req.secure));
    res.json({ ok: true });
  });

  api.post('/me/password', (req, res) => {
    const { currentPassword, newPassword } = req.body || {};
    const result = accounts.changePassword(req.user.id, currentPassword, newPassword, req.user.sessionId);
    if (!result.ok) return res.status(400).json(result);
    audit.log(req.user, 'auth_password_change', `user:${req.user.id}`, '', req.ip);
    res.json({ user: result.user });
  });

  // ---- Istoric curse ----

  api.get('/rides', (req, res) => {
    const { filters, page } = parseRideFilters(req.query);
    const { rides, total } = store.searchRides(filters, page);
    if (req.query.export === '1') {
      const parts = [`${rides.length} curse`];
      if (Number.isFinite(filters.from) && Number.isFinite(filters.to)) {
        parts.push(`${day.format(filters.from)} – ${day.format(filters.to - 1)}`);
      }
      if (filters.carId) parts.push(`mașina ${filters.carId}`);
      if (filters.status) parts.push(STATUS_FILTER_LABELS[filters.status]);
      if (filters.q) parts.push(`căutare „${filters.q}”`);
      audit.log(req.user, 'history_export', '', parts.join(' · '), req.ip);
    }
    res.json({ rides: rides.map(rideViewForDispatcher), total, stats: store.rideStats(filters) });
  });

  api.get('/rides/:id/route', (req, res) => {
    const ride = store.getRide(req.params.id);
    if (!ride) return res.status(404).json({ error: 'Cursă inexistentă' });
    res.json({ ride: rideViewForDispatcher(ride), points: store.rideRoute(ride.id) });
  });

  // ---- Flotă (citire: toți; modificări: administratori) ----

  api.get('/fleet', (req, res) => res.json(store.adminCars()));

  api.post('/fleet', requireAdmin, (req, res) => {
    const result = store.createCar(req.body);
    if (!result.ok) return res.status(400).json(result);
    audit.log(req.user, 'car_create', `car:${result.car.id}`, `${result.car.plate} · ${result.car.driver}`, req.ip);
    res.status(201).json({ ok: true, car: result.car });
  });

  api.put('/fleet/:id', requireAdmin, (req, res) => {
    const { id } = req.params;
    const body = req.body || {};
    const before = store.adminCars().find((c) => c.id === id);
    if (!before) return res.status(404).json({ ok: false, error: 'Mașină inexistentă' });
    // Corpul poate conține datele mașinii, doar { active }, sau ambele.
    if (['plate', 'model', 'driver', 'pin'].some((key) => key in body)) {
      const result = store.updateCar(id, body);
      if (!result.ok) return res.status(400).json(result);
      const summary = carChangeSummary(before.plate, result.changes);
      if (summary) audit.log(req.user, 'car_update', `car:${id}`, summary, req.ip);
    }
    if (typeof body.active === 'boolean') {
      const result = store.setCarActive(id, body.active);
      if (!result.ok) return res.status(400).json(result);
      if (result.changed) {
        const car = store.adminCars().find((c) => c.id === id);
        audit.log(req.user, body.active ? 'car_activate' : 'car_deactivate', `car:${id}`, `${car.plate} · ${car.driver}`, req.ip);
      }
    }
    res.json({ ok: true, car: store.adminCars().find((c) => c.id === id) });
  });

  // ---- Utilizatori (administratori) ----

  const userId = (req) => {
    const id = Number(req.params.id);
    return Number.isInteger(id) && accounts.getUser(id) ? id : null;
  };

  api.get('/users', requireAdmin, (req, res) => res.json(accounts.listUsers()));

  api.post('/users', requireAdmin, (req, res) => {
    const result = accounts.createUser(req.body);
    if (!result.ok) return res.status(400).json(result);
    audit.log(req.user, 'user_create', `user:${result.user.id}`, `${userLabel(result.user)}, ${ROLE_LABELS[result.user.role]}`, req.ip);
    res.status(201).json({ ok: true, user: result.user, temporaryPassword: result.temporaryPassword });
  });

  api.put('/users/:id', requireAdmin, (req, res) => {
    const id = userId(req);
    if (id === null) return res.status(404).json({ ok: false, error: 'Utilizator inexistent' });
    const body = req.body || {};
    const before = accounts.getUser(id);
    if (['name', 'username', 'role'].some((key) => key in body)) {
      const result = accounts.updateUser(id, { ...before, ...body }, req.user.id);
      if (!result.ok) return res.status(400).json(result);
      const summary = userChangeSummary(before.name, result.changes);
      if (summary) audit.log(req.user, 'user_update', `user:${id}`, summary, req.ip);
    }
    if (typeof body.active === 'boolean') {
      const result = accounts.setActive(id, body.active, req.user.id);
      if (!result.ok) return res.status(400).json(result);
      if (result.changed) {
        audit.log(req.user, body.active ? 'user_activate' : 'user_deactivate', `user:${id}`, userLabel(result.user), req.ip);
      }
    }
    res.json({ ok: true, user: accounts.getUser(id) });
  });

  api.post('/users/:id/reset-password', requireAdmin, (req, res) => {
    const id = userId(req);
    if (id === null) return res.status(404).json({ ok: false, error: 'Utilizator inexistent' });
    const result = accounts.resetPassword(id, req.user.id);
    if (!result.ok) return res.status(400).json(result);
    audit.log(req.user, 'user_password_reset', `user:${id}`, userLabel(result.user), req.ip);
    res.json({ ok: true, user: result.user, temporaryPassword: result.temporaryPassword });
  });

  // ---- Jurnal (administratori) ----

  api.get('/audit', requireAdmin, (req, res) => {
    const { filters, page } = parseAuditFilters(req.query);
    res.json(audit.search(filters, page));
  });

  api.use((req, res) => res.status(404).json({ error: 'Negăsit' }));
  api.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON invalid' });
    next(err);
  });

  return api;
}

module.exports = { createApi, sessionToken, sameOrigin, hostnameOf };
