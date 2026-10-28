const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');
const { Server } = require('socket.io');
const { openDatabase, createRepository } = require('./db');
const { FleetStore, importCars } = require('./store');
const { Accounts } = require('./accounts');
const { createAuditLog, rideSummary } = require('./audit');
const { createApi, sessionToken, sameOrigin, hostnameOf } = require('./api');
const { rideViewForDispatcher, rideViewForDriver } = require('./views');
const { loadCars } = require('./config');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const SHARED_DIR = path.join(__dirname, '..', 'shared');
const LEAFLET_DIR = path.dirname(require.resolve('leaflet/dist/leaflet.js'));

// Limită pentru încercări greșite de autentificare (parolă dispecer / PIN șofer), per IP.
const AUTH_WINDOW_MS = 10 * 60 * 1000;
const AUTH_MAX_FAILURES = 20;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const PAGES = ['driver', 'history', 'fleet', 'users', 'audit'];
const RIDE_STATUS_ACTIONS = { cancelled: 'ride_cancel', completed: 'ride_complete' };

function createAuthLimiter(now = Date.now) {
  const failures = new Map();
  return {
    blocked(key) {
      const entry = failures.get(key);
      if (!entry) return false;
      if (now() > entry.resetAt) {
        failures.delete(key);
        return false;
      }
      return entry.count >= AUTH_MAX_FAILURES;
    },
    fail(key) {
      const entry = failures.get(key);
      if (!entry || now() > entry.resetAt) {
        failures.set(key, { count: 1, resetAt: now() + AUTH_WINDOW_MS });
      } else {
        entry.count += 1;
      }
    },
  };
}

function reply(ack, payload) {
  if (typeof ack === 'function') ack(payload);
}

/** Prima pornire: baza de date e goală, importăm flota din fișierul de configurare. */
function seedFleet(repo, config) {
  if (repo.countCars() > 0) return;
  const cars = config.seedCars || (fs.existsSync(config.seedCarsFile) ? loadCars(config.seedCarsFile) : []);
  importCars(repo, cars);
  if (cars.length && !config.seedCars) {
    console.log(`[flotă] ${cars.length} mașini importate din ${config.seedCarsFile}`);
  }
}

function createApp(config) {
  const db = openDatabase(config.databaseFile);
  const repo = createRepository(db);
  seedFleet(repo, config);
  const store = new FleetStore({ repo, avgSpeedKmh: config.avgSpeedKmh });
  const accounts = new Accounts({ repo, sessionIdleMs: (config.sessionIdleHours || 12) * HOUR_MS });
  const admin = accounts.ensureAdmin(config.adminPassword, { mustChangePassword: config.adminPasswordIsDefault });
  if (admin && config.adminPasswordIsDefault) {
    console.warn('[conturi] A fost creat contul „admin” cu parola „admin”; va trebui schimbată la prima autentificare.');
  } else if (admin) {
    console.log('[conturi] A fost creat contul „admin” cu parola din configurare (ADMIN_PASSWORD).');
  }
  const audit = createAuditLog(repo);
  const limiter = createAuthLimiter();

  const maintenance = () => {
    store.pruneRoutes(config.routeRetentionDays || 180);
    accounts.pruneSessions();
  };
  maintenance();
  const maintenanceTimer = setInterval(maintenance, DAY_MS);
  maintenanceTimer.unref();

  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', true);
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Frame-Options', 'DENY');
    // Linkul de urmărire conține un token secret: nu-l trimitem altor site-uri (ex. serverul de hărți).
    res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });

  app.get('/health', (req, res) => res.json({ ok: true }));
  app.get('/api/config', (req, res) =>
    res.json({
      companyName: config.companyName,
      mapCenter: config.mapCenter,
      mapZoom: config.mapZoom,
      geocodeCountry: config.geocodeCountry,
    })
  );
  app.get('/api/cars', (req, res) => res.json(store.carDirectory()));
  app.use('/api', createApi({ store, accounts, audit, limiter, config }));

  for (const page of PAGES) {
    app.get(`/${page}`, (req, res) => res.sendFile(path.join(PUBLIC_DIR, `${page}.html`)));
  }
  app.get('/track/:token', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'track.html')));
  app.use('/vendor/leaflet', express.static(LEAFLET_DIR));
  app.use('/shared', express.static(SHARED_DIR));
  app.use(express.static(PUBLIC_DIR));

  const httpServer = http.createServer(app);
  const io = new Server(httpServer);

  function clientKey(socket) {
    if (config.trustProxy) {
      const forwarded = socket.handshake.headers['x-forwarded-for'];
      if (typeof forwarded === 'string' && forwarded) return forwarded.split(',')[0].trim();
    }
    return socket.handshake.address;
  }

  function handshakeHostname(socket) {
    const headers = socket.handshake.headers;
    const host = (config.trustProxy && headers['x-forwarded-host']) || headers.host || '';
    return hostnameOf(String(host).split(',')[0].trim(), false);
  }

  /** Utilizatorul sesiunii din cookie-ul conexiunii, reverificat (cont dezactivat, sesiune expirată). */
  function dispatcherUser(socket) {
    const user = accounts.authenticate(sessionToken(socket.handshake.headers.cookie));
    return user && !user.mustChangePassword ? user : null;
  }

  io.use((socket, next) => {
    const auth = socket.handshake.auth || {};
    const key = clientKey(socket);

    if (auth.role === 'track') {
      const ride = store.getRideByToken(auth.token);
      if (!ride) return next(new Error('not_found'));
      socket.data = { role: 'track', rideId: ride.id };
      return next();
    }

    if (auth.role === 'dispatcher') {
      // Doar paginile aplicației pot folosi sesiunea dispecerului (nu și alte site-uri).
      if (!sameOrigin(socket.handshake.headers.origin, handshakeHostname(socket))) return next(new Error('unauthorized'));
      const user = accounts.authenticate(sessionToken(socket.handshake.headers.cookie));
      if (!user) return next(new Error('unauthorized'));
      if (user.mustChangePassword) return next(new Error('password_change_required'));
      socket.data = { role: 'dispatcher', user };
      return next();
    }

    if (limiter.blocked(key)) return next(new Error('too_many_attempts'));
    if (auth.role === 'driver' && store.verifyDriver(auth.carId, auth.pin)) {
      socket.data = { role: 'driver', carId: auth.carId };
      return next();
    }
    limiter.fail(key);
    return next(new Error('unauthorized'));
  });

  io.on('connection', (socket) => {
    const { role } = socket.data;
    if (role === 'dispatcher') onDispatcher(socket);
    else if (role === 'driver') onDriver(socket);
    else if (role === 'track') onTracker(socket);
    else socket.disconnect(true);
  });

  function onDispatcher(socket) {
    const { user } = socket.data;
    socket.join(['dispatchers', `user:${user.id}`, `session:${user.sessionId}`]);
    socket.emit('fleet:snapshot', {
      user: accounts.publicUser(user),
      cars: store.listCars(),
      rides: store.listRides().map(rideViewForDispatcher),
    });

    /** Rulează acțiunea doar dacă sesiunea este încă validă; altfel închide conexiunea. */
    const withUser = (handler) => (data, ack) => {
      const actor = dispatcherUser(socket);
      if (!actor) {
        reply(ack, { ok: false, error: 'Sesiunea a expirat. Autentificați-vă din nou.' });
        return socket.disconnect(true);
      }
      handler(actor, data, ack);
    };

    socket.on(
      'ride:create',
      withUser((actor, data, ack) => {
        const result = store.createRide(data, { userId: actor.id, name: actor.name });
        if (!result.ok) return reply(ack, result);
        audit.log(actor, 'ride_create', `ride:${result.ride.id}`, rideSummary(result.ride), clientKey(socket));
        reply(ack, { ok: true, ride: rideViewForDispatcher(result.ride) });
      })
    );

    socket.on(
      'ride:status',
      withUser((actor, data, ack) => {
        const { rideId, status } = data || {};
        const result = store.updateRideStatus(rideId, status, { role: 'dispatcher', userId: actor.id, name: actor.name });
        if (!result.ok) return reply(ack, result);
        const action = RIDE_STATUS_ACTIONS[status] || 'ride_status';
        audit.log(actor, action, `ride:${result.ride.id}`, rideSummary(result.ride), clientKey(socket));
        reply(ack, { ok: true });
      })
    );
  }

  function onDriver(socket) {
    const { carId } = socket.data;
    socket.join(`car:${carId}`);
    store.driverConnected(carId);

    const car = store.getCarView(carId);
    const ride = car.rideId ? store.getRide(car.rideId) : null;
    socket.emit('driver:init', { car, ride: ride ? rideViewForDriver(ride) : null });

    socket.on('location', (data, ack) => reply(ack, store.updateLocation(carId, data)));

    socket.on('status', (data, ack) => {
      reply(ack, store.setCarStatus(carId, data && data.status));
    });

    socket.on('ride:status', (data, ack) => {
      const { rideId, status } = data || {};
      const result = store.updateRideStatus(rideId, status, { role: 'driver', carId });
      reply(ack, result.ok ? { ok: true } : result);
    });

    socket.on('disconnect', () => store.driverDisconnected(carId));
  }

  function onTracker(socket) {
    const ride = store.getRide(socket.data.rideId);
    if (!ride) return socket.disconnect(true);
    socket.join(`ride:${ride.id}`);
    socket.emit('track:update', store.trackingView(ride));
  }

  store.on('car', (car) => {
    const view = store.carView(car);
    io.to('dispatchers').emit('car:update', view);
    io.to(`car:${car.id}`).emit('car:update', view);
    if (car.rideId) {
      const ride = store.getRide(car.rideId);
      if (ride) io.to(`ride:${ride.id}`).emit('track:update', store.trackingView(ride));
    }
  });

  // PIN schimbat sau mașină dezactivată: șoferul trebuie să se autentifice din nou.
  store.on('car:revoked', (car) => io.in(`car:${car.id}`).disconnectSockets(true));

  // Cont dezactivat, parolă resetată sau schimbată, ieșire: închidem conexiunile live ale sesiunilor.
  accounts.on('sessions:revoked', ({ userId, exceptSessionId }) => {
    let sockets = io.in(`user:${userId}`);
    if (exceptSessionId) sockets = sockets.except(`session:${exceptSessionId}`);
    sockets.disconnectSockets(true);
  });
  accounts.on('session:revoked', (sessionId) => io.in(`session:${sessionId}`).disconnectSockets(true));

  store.on('ride', (ride) => {
    io.to('dispatchers').emit('ride:update', rideViewForDispatcher(ride));
    io.to(`car:${ride.carId}`).emit('ride:update', rideViewForDriver(ride));
    io.to(`ride:${ride.id}`).emit('track:update', store.trackingView(ride));
  });

  async function close() {
    clearInterval(maintenanceTimer);
    io.close();
    if (httpServer.listening) await new Promise((resolve) => httpServer.close(resolve));
    db.close();
  }

  return { app, httpServer, io, store, accounts, db, close };
}

module.exports = { createApp };
