const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');
const { Server } = require('socket.io');
const { openDatabase, createRepository } = require('./db');
const { FleetStore, importCars, LINK_STATUSES } = require('./store');
const { Accounts } = require('./accounts');
const { createAuditLog, rideSummary } = require('./audit');
const { createApi, sessionToken, sameOrigin, hostnameOf } = require('./api');
const { createDriverApi } = require('./driver-api');
const { rideViewForDispatcher, rideViewForDriver, offerViewForDriver } = require('./views');
const { createSmsSender, normalizePhone, rideSmsText } = require('./sms');
const { loadCars } = require('./config');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const SHARED_DIR = path.join(__dirname, '..', 'shared');
const LEAFLET_DIR = path.dirname(require.resolve('leaflet/dist/leaflet.js'));

// Limită pentru încercări greșite de autentificare (parolă dispecer / PIN șofer), per IP.
const AUTH_WINDOW_MS = 10 * 60 * 1000;
const AUTH_MAX_FAILURES = 20;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const PRESENCE_SWEEP_MS = 15 * 1000;
const OFFER_SWEEP_MS = 2 * 1000;
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
  const store = new FleetStore({
    repo,
    avgSpeedKmh: config.avgSpeedKmh,
    offerTimeoutMs: (config.offerTimeoutSeconds || 60) * 1000,
  });
  const sms = createSmsSender(config.sms || { provider: 'console' }, config.smsTransport);
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
    store.pruneDriverSessions();
  };
  maintenance();
  const maintenanceTimer = setInterval(maintenance, DAY_MS);
  maintenanceTimer.unref();
  // Mașinile din aplicație care nu mai trimit poziția apar „deconectate” după un minut.
  const presenceTimer = setInterval(() => store.sweepPresence(), PRESENCE_SWEEP_MS);
  presenceTimer.unref();
  // Comenzile neacceptate la timp dispar de pe telefoanele șoferilor.
  const offerTimer = setInterval(() => store.expireOffers(), OFFER_SWEEP_MS);
  offerTimer.unref();

  const dispatcherView = (ride) => rideViewForDispatcher(ride, store.rideOffers(ride.id));
  const driverOffers = (carId) => {
    const car = store.getCarView(carId);
    return store.carOffers(carId).map(({ offer, ride }) => offerViewForDriver(offer, ride, car, store.avgSpeedKmh));
  };

  /** SMS-ul cu linkul de urmărire, trimis automat clientului când un șofer acceptă comanda. */
  async function sendRideSms(ride) {
    if (!ride.phone) return store.setRideSms(ride.id, 'no_phone');
    const to = normalizePhone(ride.phone, (config.sms && config.sms.countryCode) || '40');
    if (!to) return store.setRideSms(ride.id, 'invalid_phone', ride.phone);
    const base = config.publicUrl || ride.linkBase;
    if (!base) return store.setRideSms(ride.id, 'failed', 'Adresa publică a serverului (PUBLIC_URL) nu este setată');
    const car = store.getCarView(ride.carId);
    const text = rideSmsText({
      companyName: config.companyName,
      plate: ride.carPlate,
      model: car ? car.model : '',
      driverFirstName: ride.driverName.split(/\s+/)[0],
      etaMin: store.trackingView(ride).etaMin,
      link: `${base}/track/${ride.token}`,
    });
    store.setRideSms(ride.id, 'sending', to);
    const result = await sms.send(to, text);
    store.setRideSms(ride.id, result.ok ? (result.simulated ? 'simulated' : 'sent') : 'failed', result.ok ? to : result.error);
  }

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
      voice: config.voice || null,
    })
  );
  app.get('/api/cars', (req, res) => res.json(store.carDirectory()));
  app.use('/api/driver', createDriverApi({ store, limiter }));
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

    // Șoferul: token de sesiune (aplicația și pagina web) sau, pentru simulator, mașină + PIN.
    if (auth.role === 'driver' && auth.token) {
      const carId = store.authenticateDriverToken(auth.token);
      if (!carId) return next(new Error('unauthorized'));
      socket.data = { role: 'driver', carId };
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

  /** Adresa publică de pe care lucrează dispecerul (pentru linkul din SMS, dacă PUBLIC_URL lipsește). */
  function dispatcherOrigin(socket) {
    const origin = socket.handshake.headers.origin;
    if (origin && hostnameOf(origin, true)) return origin.replace(/\/+$/, '');
    const host = handshakeHostname(socket) && ((config.trustProxy && socket.handshake.headers['x-forwarded-host']) || socket.handshake.headers.host);
    const proto = (config.trustProxy && socket.handshake.headers['x-forwarded-proto']) || 'http';
    return host ? `${String(proto).split(',')[0].trim()}://${String(host).split(',')[0].trim()}` : '';
  }

  function onDispatcher(socket) {
    const { user } = socket.data;
    socket.join(['dispatchers', `user:${user.id}`, `session:${user.sessionId}`]);
    socket.emit('fleet:snapshot', {
      user: accounts.publicUser(user),
      cars: store.listCars(),
      rides: store.listRides().map(dispatcherView),
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
        const result = store.createOrder(data, { userId: actor.id, name: actor.name }, { linkBase: dispatcherOrigin(socket) });
        if (!result.ok) return reply(ack, result);
        const sentTo = `trimisă la ${result.offeredTo.length} ${result.offeredTo.length === 1 ? 'mașină' : 'mașini'}`;
        audit.log(actor, 'ride_create', `ride:${result.ride.id}`, `${rideSummary(result.ride)} · ${sentTo}`, clientKey(socket));
        reply(ack, { ok: true, ride: dispatcherView(result.ride), offeredTo: result.offeredTo });
      })
    );

    socket.on(
      'ride:resend',
      withUser((actor, data, ack) => {
        const { rideId, target } = data || {};
        const result = store.resendOrder(rideId, target);
        if (!result.ok) return reply(ack, result);
        const sentTo = `trimisă din nou la ${result.offeredTo.length} ${result.offeredTo.length === 1 ? 'mașină' : 'mașini'}`;
        audit.log(actor, 'ride_resend', `ride:${result.ride.id}`, `${rideSummary(result.ride)} · ${sentTo}`, clientKey(socket));
        reply(ack, { ok: true, offeredTo: result.offeredTo });
      })
    );

    socket.on(
      'ride:sms',
      withUser((actor, data, ack) => {
        const ride = store.getRide(data && data.rideId);
        if (!ride || !LINK_STATUSES.has(ride.status)) return reply(ack, { ok: false, error: 'Cursa nu mai este în desfășurare' });
        audit.log(actor, 'ride_sms', `ride:${ride.id}`, rideSummary(ride), clientKey(socket));
        sendRideSms(ride);
        reply(ack, { ok: true });
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
    socket.emit('driver:init', { car, ride: ride ? rideViewForDriver(ride) : null, offers: driverOffers(carId) });

    socket.on('offer:accept', (data, ack) => {
      const result = store.acceptOffer(data && data.rideId, carId);
      reply(ack, result.ok ? { ok: true, ride: rideViewForDriver(result.ride) } : result);
    });
    socket.on('offer:decline', (data, ack) => reply(ack, store.declineOffer(data && data.rideId, carId)));

    socket.on('location', (data, ack) => reply(ack, store.updateLocation(carId, data)));
    socket.on('gps:off', (data, ack) => reply(ack, store.gpsLost(carId)));

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
    io.to('dispatchers').emit('ride:update', dispatcherView(ride));
    if (ride.carId) io.to(`car:${ride.carId}`).emit('ride:update', rideViewForDriver(ride));
    io.to(`ride:${ride.id}`).emit('track:update', store.trackingView(ride));
    // Cursa s-a încheiat: linkul clientului dispare, iar paginile deschise se deconectează.
    if (store.isFinished(ride)) io.in(`ride:${ride.id}`).disconnectSockets(true);
  });

  // Comandă nouă pentru o mașină, sau oferta ei s-a închis (preluată de alt coleg, expirată, anulată).
  store.on('offer', (offer) => {
    const room = io.to(`car:${offer.carId}`);
    if (offer.response === null) {
      const ride = store.getRide(offer.rideId);
      room.emit('offer:new', offerViewForDriver(offer, ride, store.getCarView(offer.carId), store.avgSpeedKmh));
    } else if (offer.response !== 'accepted') {
      room.emit('offer:gone', { rideId: offer.rideId, reason: offer.response });
    }
  });

  store.on('ride:accepted', (ride) => sendRideSms(ride));

  async function close() {
    clearInterval(maintenanceTimer);
    clearInterval(presenceTimer);
    clearInterval(offerTimer);
    io.close();
    if (httpServer.listening) await new Promise((resolve) => httpServer.close(resolve));
    db.close();
  }

  return { app, httpServer, io, store, accounts, db, sms, close };
}

module.exports = { createApp };
