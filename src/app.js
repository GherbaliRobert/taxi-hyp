const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const { openDatabase, createRepository } = require('./db');
const { FleetStore, importCars } = require('./store');
const { loadCars } = require('./config');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const SHARED_DIR = path.join(__dirname, '..', 'shared');
const LEAFLET_DIR = path.dirname(require.resolve('leaflet/dist/leaflet.js'));

// Limită pentru încercări greșite de autentificare (parolă dispecer / PIN șofer), per IP.
const AUTH_WINDOW_MS = 10 * 60 * 1000;
const AUTH_MAX_FAILURES = 20;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_PAGE_SIZE = 10000;

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

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

function rideViewForDispatcher(ride) {
  return {
    id: ride.id,
    customerName: ride.customerName,
    phone: ride.phone,
    address: ride.address,
    notes: ride.notes,
    pickup: ride.pickup,
    carId: ride.carId,
    carPlate: ride.carPlate,
    driverName: ride.driverName,
    status: ride.status,
    createdAt: ride.createdAt,
    updatedAt: ride.updatedAt,
    statusTimes: ride.statusTimes,
    distanceM: Math.round(ride.distanceM),
    trackPath: `/track/${ride.token}`,
  };
}

function rideViewForDriver(ride) {
  return {
    id: ride.id,
    customerName: ride.customerName,
    phone: ride.phone,
    address: ride.address,
    notes: ride.notes,
    pickup: ride.pickup,
    status: ride.status,
    createdAt: ride.createdAt,
  };
}

/** Filtrele de căutare din query string (/api/rides?from=…&to=…&carId=…&status=…&q=…). */
function parseRideFilters(query) {
  const num = (v) => (v === undefined || v === '' ? NaN : Number(v));
  const text = (v) => (typeof v === 'string' ? v.trim().slice(0, 100) : '');
  const status = text(query.status);
  return {
    filters: {
      from: num(query.from),
      to: num(query.to),
      carId: text(query.carId),
      status: ['active', 'completed', 'cancelled'].includes(status) ? status : '',
      q: text(query.q),
    },
    page: {
      limit: Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(num(query.limit)) || 50)),
      offset: Math.max(0, Math.trunc(num(query.offset)) || 0),
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
  const limiter = createAuthLimiter();

  const pruneRoutes = () => store.pruneRoutes(config.routeRetentionDays || 180);
  pruneRoutes();
  const pruneTimer = setInterval(pruneRoutes, DAY_MS);
  pruneTimer.unref();

  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', true);
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
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

  // ---- API pentru dispecerat (istoric, flotă): parola în antetul Authorization ----

  const api = express.Router();
  api.use((req, res, next) => {
    const key = req.ip;
    if (limiter.blocked(key)) return res.status(429).json({ error: 'Prea multe încercări. Reîncercați mai târziu.' });
    const header = req.get('authorization') || '';
    const password = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (password && safeEqual(password, config.dispatcherPassword)) return next();
    limiter.fail(key);
    res.status(401).json({ error: 'Parolă greșită' });
  });
  api.use(express.json({ limit: '20kb' }));

  api.get('/rides', (req, res) => {
    const { filters, page } = parseRideFilters(req.query);
    const { rides, total } = store.searchRides(filters, page);
    res.json({ rides: rides.map(rideViewForDispatcher), total, stats: store.rideStats(filters) });
  });

  api.get('/rides/:id/route', (req, res) => {
    const ride = store.getRide(req.params.id);
    if (!ride) return res.status(404).json({ error: 'Cursă inexistentă' });
    res.json({ ride: rideViewForDispatcher(ride), points: store.rideRoute(ride.id) });
  });

  api.get('/fleet', (req, res) => res.json(store.adminCars()));

  api.post('/fleet', (req, res) => {
    const result = store.createCar(req.body);
    res.status(result.ok ? 201 : 400).json(result);
  });

  api.put('/fleet/:id', (req, res) => {
    const { id } = req.params;
    const body = req.body || {};
    if (!store.adminCars().some((c) => c.id === id)) return res.status(404).json({ ok: false, error: 'Mașină inexistentă' });
    // Corpul poate conține datele mașinii, doar { active }, sau ambele.
    let result = { ok: true };
    if (['plate', 'model', 'driver', 'pin'].some((key) => key in body)) result = store.updateCar(id, body);
    if (result.ok && typeof body.active === 'boolean') result = store.setCarActive(id, body.active);
    if (!result.ok) return res.status(400).json(result);
    res.json({ ok: true, car: store.adminCars().find((c) => c.id === id) });
  });

  app.use('/api', api);
  app.use('/api', (err, req, res, next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON invalid' });
    next(err);
  });

  app.get('/driver', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'driver.html')));
  app.get('/history', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'history.html')));
  app.get('/fleet', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'fleet.html')));
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

  io.use((socket, next) => {
    const auth = socket.handshake.auth || {};
    const key = clientKey(socket);

    if (auth.role === 'track') {
      const ride = store.getRideByToken(auth.token);
      if (!ride) return next(new Error('not_found'));
      socket.data = { role: 'track', rideId: ride.id };
      return next();
    }

    if (limiter.blocked(key)) return next(new Error('too_many_attempts'));
    if (auth.role === 'dispatcher' && safeEqual(auth.password, config.dispatcherPassword)) {
      socket.data = { role: 'dispatcher' };
      return next();
    }
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
    socket.join('dispatchers');
    socket.emit('fleet:snapshot', {
      cars: store.listCars(),
      rides: store.listRides().map(rideViewForDispatcher),
    });

    socket.on('ride:create', (data, ack) => {
      const result = store.createRide(data);
      reply(ack, result.ok ? { ok: true, ride: rideViewForDispatcher(result.ride) } : result);
    });

    socket.on('ride:status', (data, ack) => {
      const { rideId, status } = data || {};
      const result = store.updateRideStatus(rideId, status, { role: 'dispatcher' });
      reply(ack, result.ok ? { ok: true } : result);
    });
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

  store.on('ride', (ride) => {
    io.to('dispatchers').emit('ride:update', rideViewForDispatcher(ride));
    io.to(`car:${ride.carId}`).emit('ride:update', rideViewForDriver(ride));
    io.to(`ride:${ride.id}`).emit('track:update', store.trackingView(ride));
  });

  async function close() {
    clearInterval(pruneTimer);
    io.close();
    if (httpServer.listening) await new Promise((resolve) => httpServer.close(resolve));
    db.close();
  }

  return { app, httpServer, io, store, db, close };
}

module.exports = { createApp };
