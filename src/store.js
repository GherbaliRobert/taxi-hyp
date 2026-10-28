const crypto = require('crypto');
const { EventEmitter } = require('events');
const Geo = require('../shared/geo');
const { hashSecret: hashPin, verifySecret: verifyPin, isValidPin, hashToken } = require('./secret');

const CAR_STATUSES = ['free', 'busy', 'offline'];
const RIDE_STATUSES = ['pending', 'assigned', 'arrived', 'in_progress', 'completed', 'cancelled'];
const FINISHED = new Set(['completed', 'cancelled']);
// Linkul clientului funcționează doar cât timp mașina vine spre el sau clientul e în cursă.
const LINK_STATUSES = new Set(['assigned', 'arrived', 'in_progress']);

// Tranzițiile permise pentru statusul unei curse.
// „pending” (se caută șofer) → „assigned” se face doar când un șofer acceptă (acceptOffer).
const TRANSITIONS = {
  pending: ['cancelled'],
  assigned: ['arrived', 'in_progress', 'completed', 'cancelled'],
  arrived: ['in_progress', 'completed', 'cancelled'],
  in_progress: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
};
// Șoferul nu poate anula o cursă — doar dispeceratul.
const DRIVER_RIDE_STATUSES = new Set(['arrived', 'in_progress', 'completed']);

const TRAIL_LENGTH = 30;
const MIN_LOCATION_INTERVAL_MS = 500;
// Cât timp rămân cursele încheiate în lista dispecerului.
const RECENT_FINISHED_MS = 24 * 60 * 60 * 1000;
// Cât timp are un șofer să accepte o comandă.
const DEFAULT_OFFER_TIMEOUT_MS = 60 * 1000;
const MAX_TARGETED_CARS = 50;
// Ultima poziție a mașinii se salvează în baza de date cel mult o dată la atâtea ms.
const POSITION_SAVE_INTERVAL_MS = 15 * 1000;
// Traseul unei curse se salvează ca un punct la atâtea ms.
const ROUTE_POINT_INTERVAL_MS = 10 * 1000;
// Filtre pentru kilometraj: ignorăm pozițiile imprecise și salturile GPS imposibile.
const ODOMETER_MAX_ACCURACY_M = 50;
const ODOMETER_MAX_SPEED_MS = 60; // ~216 km/h
// Aplicația de telefon trimite poziția prin HTTP (și din fundal): mașina e „conectată”
// cât timp a trimis ceva în ultimul minut, chiar dacă WebSocket-ul e întrerupt.
const HTTP_PRESENCE_MS = 60 * 1000;
// GPS-ul este obligatoriu: o mașină fără o poziție GPS mai nouă de un minut nu primește comenzi.
const GPS_LOST_MS = 60 * 1000;
// Vârsta maximă acceptată pentru o poziție raportată de telefon (poziția retrimisă fără semnal nou).
const MAX_FIX_AGE_MS = 10 * 60 * 1000;
// Sesiunea șoferului expiră după 30 de zile fără activitate.
const DRIVER_SESSION_IDLE_MS = 30 * 24 * 60 * 60 * 1000;
const DRIVER_SESSION_TOUCH_MS = 10 * 60 * 1000;

function cleanText(value, maxLength) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') return null;
  return value.trim().slice(0, maxLength);
}

function optionalNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizePlate(plate) {
  return plate.trim().replace(/\s+/g, ' ').toUpperCase();
}

/** Adaugă mașinile dintr-o listă (ex. data/cars.json) într-o bază de date goală, păstrând id-urile. */
function importCars(repo, cars, now = Date.now()) {
  for (const car of cars) {
    repo.insertCar({
      id: car.id,
      plate: normalizePlate(car.plate),
      model: car.model || '',
      driver: car.driver,
      pinHash: hashPin(car.pin),
      active: true,
      createdAt: now,
    });
  }
}

/**
 * Starea flotei și a curselor.
 * Ce trebuie păstrat (mașini, curse, trasee) se scrie în baza de date prin `repo`;
 * conexiunile și pozițiile live sunt ținute în memorie.
 * Emite 'car' (mașina s-a schimbat), 'ride' (cursa s-a schimbat) și
 * 'car:revoked' (sesiunile șoferului trebuie închise: PIN schimbat sau mașină dezactivată).
 * O mașină primește comenzi doar dacă e liberă, conectată și cu GPS-ul funcțional (vezi _gpsOk).
 */
class FleetStore extends EventEmitter {
  constructor({ repo, avgSpeedKmh = 25, offerTimeoutMs = DEFAULT_OFFER_TIMEOUT_MS, now = Date.now }) {
    super();
    this.repo = repo;
    this.now = now;
    this.avgSpeedKmh = avgSpeedKmh;
    this.offerTimeoutMs = offerTimeoutMs;
    this.cars = new Map();
    // Doar cursele active (inclusiv comenzile care așteaptă un șofer); cele încheiate se citesc din baza de date.
    this.rides = new Map();
    this.ridesByToken = new Map();
    // id cursă -> ofertele trimise șoferilor (inclusiv cele cu răspuns), pentru cursele active.
    this.offers = new Map();

    for (const record of repo.listCars()) {
      this.cars.set(record.id, this._carFromRecord(record));
    }
    // După o repornire, cursele active continuă (linkurile clienților rămân valabile).
    for (const ride of repo.activeRides()) {
      this._trackRide(ride);
      this.offers.set(ride.id, repo.rideOffers(ride.id));
      const car = ride.carId && this.cars.get(ride.carId);
      if (car) car.rideId = ride.id;
    }
  }

  _carFromRecord(record) {
    return {
      id: record.id,
      plate: record.plate,
      model: record.model,
      driver: record.driver,
      pinHash: record.pinHash,
      active: record.active,
      createdAt: record.createdAt,
      status: 'offline',
      connections: 0,
      httpSeenAt: 0,
      rideId: null,
      position: record.lastPosition,
      // Șoferul a oprit GPS-ul sau telefonul a raportat că locația nu e disponibilă.
      gpsOff: false,
      gpsWasOk: false,
      trail: [],
      lastSeen: record.lastPosition ? record.lastPosition.ts : null,
      lastSavedAt: 0,
    };
  }

  _carRecord(car) {
    return {
      id: car.id,
      plate: car.plate,
      model: car.model,
      driver: car.driver,
      pinHash: car.pinHash,
      active: car.active,
      createdAt: car.createdAt,
    };
  }

  // ---- Mașini ----

  verifyDriver(carId, pin) {
    const car = this.cars.get(carId);
    return Boolean(car && car.active && verifyPin(pin, car.pinHash));
  }

  _activeCars() {
    return [...this.cars.values()].filter((c) => c.active).sort((a, b) => a.plate.localeCompare(b.plate));
  }

  /** Informații publice despre flotă (pentru ecranul de autentificare al șoferului). */
  carDirectory() {
    return this._activeCars().map((c) => ({ id: c.id, plate: c.plate, model: c.model }));
  }

  /**
   * Vederea completă a mașinii pentru dispecerat (fără PIN).
   * Traseul recent se trimite doar la încărcarea inițială; apoi clientul îl continuă singur.
   */
  carView(car, { withTrail = false } = {}) {
    const view = {
      id: car.id,
      plate: car.plate,
      model: car.model,
      driver: car.driver,
      active: car.active,
      status: car.status,
      rideId: car.rideId,
      position: car.position,
      gpsOk: this._gpsOk(car),
      lastSeen: car.lastSeen,
    };
    if (withTrail) view.trail = car.trail.slice();
    return view;
  }

  listCars() {
    return this._activeCars().map((c) => this.carView(c, { withTrail: true }));
  }

  getCarView(carId) {
    const car = this.cars.get(carId);
    return car ? this.carView(car) : null;
  }

  /** Toate mașinile, inclusiv cele dezactivate, pentru pagina de administrare a flotei. */
  adminCars() {
    return [...this.cars.values()]
      .sort((a, b) => Number(b.active) - Number(a.active) || a.plate.localeCompare(b.plate))
      .map((c) => ({
        id: c.id,
        plate: c.plate,
        model: c.model,
        driver: c.driver,
        active: c.active,
        status: c.status,
        rideId: c.rideId,
        lastSeen: c.lastSeen,
        createdAt: c.createdAt,
      }));
  }

  _validateCar(input, carId, { requirePin }) {
    if (!input || typeof input !== 'object') return { error: 'Date lipsă' };
    const plate = cleanText(input.plate, 20);
    const model = cleanText(input.model, 60);
    const driver = cleanText(input.driver, 80);
    if (plate === null || model === null || driver === null) return { error: 'Date invalide' };
    if (!plate) return { error: 'Introduceți numărul de înmatriculare' };
    if (!driver) return { error: 'Introduceți numele șoferului' };
    const normalized = normalizePlate(plate);
    for (const other of this.cars.values()) {
      if (other.id !== carId && other.plate.toUpperCase() === normalized) {
        return { error: `Există deja o mașină cu numărul ${normalized}` };
      }
    }
    const pin = input.pin === undefined || input.pin === null ? '' : String(input.pin).trim();
    if (pin || requirePin) {
      if (!isValidPin(pin)) return { error: 'PIN-ul trebuie să aibă între 4 și 12 cifre' };
    }
    return { plate: normalized, model, driver, pin };
  }

  _newCarId(plate) {
    const base = plate.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'masina';
    let id = base;
    for (let i = 2; this.cars.has(id); i++) id = `${base}-${i}`;
    return id;
  }

  createCar(input) {
    const data = this._validateCar(input, null, { requirePin: true });
    if (data.error) return { ok: false, error: data.error };
    const car = this._carFromRecord({
      id: this._newCarId(data.plate),
      plate: data.plate,
      model: data.model,
      driver: data.driver,
      pinHash: hashPin(data.pin),
      active: true,
      createdAt: this.now(),
      lastPosition: null,
    });
    this.repo.insertCar(this._carRecord(car));
    this.cars.set(car.id, car);
    this.emit('car', car);
    return { ok: true, car: this.adminCars().find((c) => c.id === car.id) };
  }

  /**
   * Modifică datele mașinii; un PIN nou închide sesiunile deschise ale șoferului.
   * Întoarce și `changes` ({ câmp: [vechi, nou] }, plus `pin: true`) pentru jurnal.
   */
  updateCar(carId, input) {
    const car = this.cars.get(carId);
    if (!car) return { ok: false, error: 'Mașină inexistentă' };
    const data = this._validateCar(input, carId, { requirePin: false });
    if (data.error) return { ok: false, error: data.error };
    const changes = {};
    for (const field of ['plate', 'model', 'driver']) {
      if (car[field] !== data[field]) changes[field] = [car[field], data[field]];
    }
    if (data.pin) changes.pin = true;
    car.plate = data.plate;
    car.model = data.model;
    car.driver = data.driver;
    if (data.pin) car.pinHash = hashPin(data.pin);
    this.repo.updateCar(this._carRecord(car));
    this.emit('car', car);
    if (data.pin) this._revokeDriver(car);
    return { ok: true, car: this.adminCars().find((c) => c.id === car.id), changes };
  }

  /** Dezactivarea scoate mașina de pe hartă și deconectează șoferul; istoricul ei rămâne. */
  setCarActive(carId, active) {
    const car = this.cars.get(carId);
    if (!car) return { ok: false, error: 'Mașină inexistentă' };
    if (!active && car.rideId) return { ok: false, error: 'Mașina are o cursă activă' };
    if (car.active === Boolean(active)) return { ok: true, changed: false };
    car.active = Boolean(active);
    this.repo.updateCar(this._carRecord(car));
    this.emit('car', car);
    if (!car.active) this._revokeDriver(car);
    return { ok: true, changed: true };
  }

  /** PIN schimbat sau mașină dezactivată: toate sesiunile șoferului se închid. */
  _revokeDriver(car) {
    this.repo.deleteCarDriverSessions(car.id);
    car.httpSeenAt = 0;
    this.emit('car:revoked', car);
    this._updatePresence(car);
  }

  // ---- Sesiunile șoferilor ----

  /** Autentificarea șoferului cu mașina și PIN-ul; întoarce un token pentru aplicație sau pagina web. */
  createDriverSession(carId, pin, { device = '' } = {}) {
    if (!this.verifyDriver(carId, pin)) return { ok: false, error: 'PIN greșit pentru mașina aleasă' };
    const car = this.cars.get(carId);
    const token = crypto.randomBytes(32).toString('base64url');
    const ts = this.now();
    this.repo.insertDriverSession({
      tokenHash: hashToken(token),
      carId,
      createdAt: ts,
      lastSeenAt: ts,
      device: String(device).slice(0, 100),
    });
    return { ok: true, token, car: { id: car.id, plate: car.plate, model: car.model } };
  }

  /** Mașina sesiunii, sau null dacă tokenul e necunoscut, expirat ori mașina e dezactivată. */
  authenticateDriverToken(token) {
    if (typeof token !== 'string' || !token) return null;
    const tokenHash = hashToken(token);
    const session = this.repo.driverSession(tokenHash);
    if (!session) return null;
    const ts = this.now();
    const car = this.cars.get(session.car_id);
    if (!car || !car.active || ts - session.last_seen_at > DRIVER_SESSION_IDLE_MS) {
      this.repo.deleteDriverSession(tokenHash);
      return null;
    }
    if (ts - session.last_seen_at >= DRIVER_SESSION_TOUCH_MS) this.repo.touchDriverSession(tokenHash, ts);
    return car.id;
  }

  /** Ieșirea din aplicație: sesiunea se închide, iar mașina apare deconectată imediat. */
  endDriverSession(token) {
    const carId = this.authenticateDriverToken(token);
    if (!carId) return;
    this.repo.deleteDriverSession(hashToken(token));
    const car = this.cars.get(carId);
    car.httpSeenAt = 0;
    this._updatePresence(car);
  }

  pruneDriverSessions() {
    return this.repo.pruneDriverSessions(this.now() - DRIVER_SESSION_IDLE_MS);
  }

  // ---- Prezența șoferului (WebSocket sau HTTP din aplicație) ----

  _isOnline(car) {
    return car.connections > 0 || this.now() - car.httpSeenAt <= HTTP_PRESENCE_MS;
  }

  /** Recalculează liber/ocupat/deconectat după conexiuni; emite 'car' dacă s-a schimbat. */
  _updatePresence(car) {
    const online = this._isOnline(car);
    if (online && car.status === 'offline') {
      car.status = car.rideId ? 'busy' : 'free';
    } else if (!online && car.status !== 'offline') {
      car.status = 'offline';
      if (car.position) this.repo.saveCarPosition(car.id, car.position);
      this._withdrawCarOffers(car.id);
    } else {
      return false;
    }
    this._refreshGps(car, false);
    this.emit('car', car);
    return true;
  }

  /** Semnal de la aplicație (poziție trimisă prin HTTP). */
  driverHeartbeat(carId) {
    const car = this.cars.get(carId);
    if (!car) return;
    car.httpSeenAt = this.now();
    car.lastSeen = car.httpSeenAt;
    this._updatePresence(car);
  }

  /** Rulat periodic: mașinile care nu mai trimit nimic devin „deconectate”, cele fără poziții noi „fără GPS”. */
  sweepPresence() {
    for (const car of this.cars.values()) {
      if (car.status !== 'offline' && !this._updatePresence(car)) this._refreshGps(car);
    }
  }

  // ---- GPS (obligatoriu pentru a primi comenzi) ----

  _gpsOk(car) {
    return car.status !== 'offline' && !car.gpsOff && Boolean(car.position) && this.now() - car.position.ts <= GPS_LOST_MS;
  }

  /** Recalculează starea GPS-ului; la pierderea lui, ofertele deschise ale mașinii se retrag. */
  _refreshGps(car, emit = true) {
    const ok = this._gpsOk(car);
    if (ok === car.gpsWasOk) return false;
    car.gpsWasOk = ok;
    if (!ok) this._withdrawCarOffers(car.id);
    if (emit) this.emit('car', car);
    return true;
  }

  /** Șoferul a oprit GPS-ul (sau telefonul nu mai are acces la locație). */
  gpsLost(carId) {
    const car = this.cars.get(carId);
    if (!car) return { ok: false, error: 'Mașină necunoscută' };
    car.gpsOff = true;
    this._refreshGps(car);
    return { ok: true };
  }

  driverConnected(carId) {
    const car = this.cars.get(carId);
    if (!car) return;
    car.connections += 1;
    if (car.status === 'offline') {
      car.status = car.rideId ? 'busy' : 'free';
    }
    car.lastSeen = this.now();
    this._refreshGps(car, false);
    this.emit('car', car);
  }

  driverDisconnected(carId) {
    const car = this.cars.get(carId);
    if (!car) return;
    car.connections = Math.max(0, car.connections - 1);
    this._updatePresence(car);
  }

  /**
   * Poziția GPS a telefonului. `age` (ms) = de cât timp are telefonul această poziție: o poziție veche
   * retrimisă (ex. GPS oprit, fără semnal) ține mașina conectată, dar nu și „cu GPS”.
   */
  updateLocation(carId, data) {
    const car = this.cars.get(carId);
    if (!car) return { ok: false, error: 'Mașină necunoscută' };
    if (!data || !Geo.isValidLatLng(data.lat, data.lng)) {
      return { ok: false, error: 'Coordonate invalide' };
    }
    const age = Math.min(Math.max(optionalNumber(data.age) || 0, 0), MAX_FIX_AGE_MS);
    const ts = this.now() - Math.round(age);
    const previous = car.position;
    if (previous && ts - previous.ts < MIN_LOCATION_INTERVAL_MS) {
      // Prea curând după poziția anterioară: nu o înregistrăm, dar arată că GPS-ul a repornit.
      if (car.gpsOff && age <= GPS_LOST_MS) {
        car.gpsOff = false;
        this._refreshGps(car);
      }
      return { ok: true, ignored: true };
    }
    car.gpsOff = false;

    let heading = optionalNumber(data.heading);
    if (heading === null && previous) {
      // Telefonul nu trimite mereu direcția; o calculăm din ultimele două poziții.
      const moved = Geo.distanceMeters(previous, data);
      heading = moved > 3 ? Geo.bearingDegrees(previous, data) : previous.heading;
    }

    car.position = {
      lat: data.lat,
      lng: data.lng,
      heading,
      speed: optionalNumber(data.speed), // m/s
      accuracy: optionalNumber(data.accuracy), // metri
      ts,
    };
    car.lastSeen = this.now();
    car.trail.push([data.lat, data.lng]);
    if (car.trail.length > TRAIL_LENGTH) car.trail.shift();

    if (car.rideId) this._recordRideProgress(this.rides.get(car.rideId), car.position);
    if (ts - car.lastSavedAt >= POSITION_SAVE_INTERVAL_MS) {
      this.repo.saveCarPosition(car.id, car.position);
      car.lastSavedAt = ts;
    }
    this._refreshGps(car, false);
    this.emit('car', car);
    return { ok: true };
  }

  /** Kilometrajul cursei (doar cu clientul în mașină) și punctele de traseu pentru istoric. */
  _recordRideProgress(ride, pos, force = false) {
    if (!ride) return;
    const accurate = pos.accuracy === null || pos.accuracy <= ODOMETER_MAX_ACCURACY_M;
    if (ride.status === 'in_progress' && accurate) {
      const from = ride.odometerFrom;
      if (from) {
        const meters = Geo.distanceMeters(from, pos);
        const seconds = (pos.ts - from.ts) / 1000;
        if (seconds > 0 && meters / seconds <= ODOMETER_MAX_SPEED_MS) ride.distanceM += meters;
      }
      ride.odometerFrom = pos;
    }
    if (force || pos.ts - (ride.lastPointAt || 0) >= ROUTE_POINT_INTERVAL_MS) {
      this.repo.addRidePoint(ride.id, pos, ride.status);
      this.repo.saveRideDistance(ride.id, ride.distanceM);
      ride.lastPointAt = pos.ts;
    }
  }

  /** Șoferul își schimbă manual disponibilitatea (liber / ocupat). */
  setCarStatus(carId, status) {
    const car = this.cars.get(carId);
    if (!car) return { ok: false, error: 'Mașină necunoscută' };
    if (status !== 'free' && status !== 'busy') return { ok: false, error: 'Status invalid' };
    if (car.status === 'offline') return { ok: false, error: 'Mașina nu este conectată' };
    if (status === 'free' && car.rideId) {
      return { ok: false, error: 'Mașina are o cursă activă' };
    }
    car.status = status;
    if (status === 'busy') this._withdrawCarOffers(car.id);
    this.emit('car', car);
    return { ok: true };
  }

  // ---- Curse ----

  _validateOrder(input) {
    if (!input || typeof input !== 'object') return { error: 'Date lipsă' };
    const customerName = cleanText(input.customerName, 80);
    const phone = cleanText(input.phone, 30);
    const address = cleanText(input.address, 200);
    const notes = cleanText(input.notes, 300);
    if (customerName === null || phone === null || address === null || notes === null) return { error: 'Date invalide' };
    if (!customerName) return { error: 'Introduceți numele clientului' };
    const pickup = input.pickup;
    if (!pickup || !Geo.isValidLatLng(pickup.lat, pickup.lng)) return { error: 'Alegeți pe hartă locul de preluare' };
    return { customerName, phone, address, notes, pickup: { lat: pickup.lat, lng: pickup.lng } };
  }

  /**
   * Cui se trimite comanda: { mode: 'all' } (toate mașinile libere), { mode: 'nearest', count }
   * (cele mai apropiate) sau { mode: 'car', carId } (o singură mașină).
   */
  _parseTarget(target) {
    if (!target || target.mode === 'all') return { mode: 'all' };
    if (target.mode === 'nearest' && Number.isInteger(target.count) && target.count > 0) {
      return { mode: 'nearest', count: Math.min(target.count, MAX_TARGETED_CARS) };
    }
    if (target.mode === 'car' && typeof target.carId === 'string') {
      const car = this.cars.get(target.carId);
      if (!car || !car.active) return { error: 'Mașină inexistentă' };
      if (car.status !== 'free' || car.rideId) return { error: `Mașina ${car.plate} nu este liberă` };
      if (!this._gpsOk(car)) return { error: `Mașina ${car.plate} nu are GPS-ul pornit` };
      return { mode: 'car', carId: target.carId };
    }
    return { error: 'Alegeți cui trimiteți comanda' };
  }

  /** Mașinile libere, conectate și cu GPS, cele mai apropiate de client primele. */
  _offerCandidates(ride, target) {
    const free = this._activeCars().filter((c) => c.status === 'free' && !c.rideId && this._gpsOk(c));
    if (target.mode === 'car') return free.filter((c) => c.id === target.carId);
    const byDistance = free
      .map((car) => ({ car, distance: car.position ? Geo.distanceMeters(car.position, ride.pickup) : Infinity }))
      .sort((a, b) => a.distance - b.distance)
      .map((x) => x.car);
    return target.mode === 'nearest' ? byDistance.slice(0, target.count) : byDistance;
  }

  /**
   * Dispecerul introduce comanda clientului; aceasta ajunge la șoferi, iar primul care acceptă o primește.
   * `actor` este dispecerul ({ userId, name }); `linkBase` e adresa publică a serverului pentru linkul din SMS.
   */
  createOrder(input, actor, { linkBase = '' } = {}) {
    const data = this._validateOrder(input);
    if (data.error) return { ok: false, error: data.error };
    const target = this._parseTarget(input.target);
    if (target.error) return { ok: false, error: target.error };

    const ts = this.now();
    const ride = {
      token: crypto.randomBytes(16).toString('base64url'),
      ...data,
      carId: null,
      carPlate: '',
      driverName: '',
      status: 'pending',
      createdAt: ts,
      updatedAt: ts,
      statusTimes: { pending: ts },
      distanceM: 0,
      createdById: actor ? actor.userId : null,
      createdByName: actor ? actor.name : '',
      closedByName: '',
      linkBase: String(linkBase).slice(0, 200),
      sms: { status: '', detail: '', at: null },
    };
    ride.id = this.repo.insertRide(ride);
    this._trackRide(ride);
    this.offers.set(ride.id, []);
    const offeredTo = this._sendOffers(ride, target);
    this.emit('ride', ride);
    return { ok: true, ride, offeredTo };
  }

  /** Retrimite o comandă încă neacceptată (ex. toți au refuzat); ofertele vechi încă deschise se retrag. */
  resendOrder(rideId, targetInput) {
    const ride = this.rides.get(String(rideId));
    if (!ride || ride.status !== 'pending') return { ok: false, error: 'Comanda nu mai așteaptă un șofer' };
    const target = this._parseTarget(targetInput);
    if (target.error) return { ok: false, error: target.error };
    this._closeOffers(ride.id, 'withdrawn');
    const offeredTo = this._sendOffers(ride, target);
    this.emit('ride', ride);
    return { ok: true, ride, offeredTo };
  }

  _sendOffers(ride, target) {
    const ts = this.now();
    const cars = this._offerCandidates(ride, target);
    for (const car of cars) {
      const offer = { rideId: ride.id, carId: car.id, offeredAt: ts, expiresAt: ts + this.offerTimeoutMs, response: null, respondedAt: null };
      offer.id = this.repo.insertOffer(offer);
      this.offers.get(ride.id).push(offer);
      this.emit('offer', offer);
    }
    return cars.map((c) => c.id);
  }

  /** Răspunsul la o ofertă: accepted | declined | expired | taken | withdrawn. */
  _answer(offer, response) {
    offer.response = response;
    offer.respondedAt = this.now();
    this.repo.answerOffer(offer);
    this.emit('offer', offer);
  }

  _openOffer(rideId, carId) {
    const ts = this.now();
    return (this.offers.get(rideId) || []).find((o) => o.carId === carId && o.response === null && o.expiresAt > ts) || null;
  }

  /** Închide ofertele încă fără răspuns ale unei comenzi (cele trecute de termen devin „expired”). */
  _closeOffers(rideId, response) {
    const ts = this.now();
    for (const offer of this.offers.get(rideId) || []) {
      if (offer.response === null) this._answer(offer, offer.expiresAt <= ts ? 'expired' : response);
    }
  }

  /** Mașina nu mai poate primi comenzi (a acceptat alta, e ocupată sau deconectată). */
  _withdrawCarOffers(carId, exceptRideId = null) {
    for (const [rideId, list] of this.offers) {
      if (rideId === exceptRideId) continue;
      const open = list.filter((o) => o.carId === carId && o.response === null);
      if (!open.length) continue;
      open.forEach((o) => this._answer(o, 'withdrawn'));
      const ride = this.rides.get(rideId);
      if (ride) this.emit('ride', ride);
    }
  }

  /** Șoferul acceptă comanda. Primul care acceptă o primește; ceilalți văd că a fost preluată. */
  acceptOffer(rideId, carId) {
    const ride = this.rides.get(String(rideId));
    const car = this.cars.get(carId);
    if (!car) return { ok: false, error: 'Mașină necunoscută' };
    // Al doilea „Accept” al aceluiași șofer (ex. rețea lentă) nu e o eroare.
    if (ride && ride.carId === carId) return { ok: true, ride };
    if (!ride || ride.status !== 'pending') {
      return { ok: false, error: ride ? 'Comanda a fost preluată de alt coleg' : 'Comanda nu mai este disponibilă' };
    }
    if (!this._gpsOk(car)) return { ok: false, error: 'Porniți GPS-ul ca să acceptați comanda' };
    const offer = this._openOffer(ride.id, carId);
    if (!offer) return { ok: false, error: 'Oferta a expirat' };
    if (car.status !== 'free' || car.rideId) return { ok: false, error: 'Mașina nu este liberă' };

    const ts = this.now();
    this._answer(offer, 'accepted');
    this._closeOffers(ride.id, 'taken');
    this._withdrawCarOffers(car.id, ride.id);

    ride.carId = car.id;
    ride.carPlate = car.plate;
    ride.driverName = car.driver;
    ride.status = 'assigned';
    ride.updatedAt = ts;
    ride.statusTimes.assigned = ts;
    this.repo.updateRide(ride);
    if (car.position) this._recordRideProgress(ride, { ...car.position, ts }, true);

    car.rideId = ride.id;
    car.status = 'busy';
    this.emit('car', car);
    this.emit('ride', ride);
    this.emit('ride:accepted', ride);
    return { ok: true, ride };
  }

  declineOffer(rideId, carId) {
    const offer = this._openOffer(String(rideId), carId);
    if (!offer) return { ok: true };
    this._answer(offer, 'declined');
    const ride = this.rides.get(String(rideId));
    if (ride) this.emit('ride', ride);
    return { ok: true };
  }

  /** Rulat periodic: ofertele fără răspuns în timpul alocat expiră. */
  expireOffers() {
    const ts = this.now();
    const touched = new Set();
    for (const [rideId, list] of this.offers) {
      for (const offer of list) {
        if (offer.response === null && offer.expiresAt <= ts) {
          this._answer(offer, 'expired');
          touched.add(rideId);
        }
      }
    }
    for (const rideId of touched) {
      const ride = this.rides.get(rideId);
      if (ride) this.emit('ride', ride);
    }
  }

  /** Comenzile oferite acum unei mașini (pentru aplicația șoferului). */
  carOffers(carId) {
    const result = [];
    for (const [rideId, list] of this.offers) {
      const offer = this._openOffer(rideId, carId);
      const ride = this.rides.get(rideId);
      if (offer && ride && ride.status === 'pending') result.push({ offer, ride });
    }
    return result.sort((a, b) => a.offer.offeredAt - b.offer.offeredAt);
  }

  /** Ofertele unei comenzi, cu numărul mașinii (pentru dispecer). */
  rideOffers(rideId) {
    const list = this.offers.get(String(rideId)) || this.repo.rideOffers(rideId);
    return list.map((o) => ({ ...o, plate: this.cars.has(o.carId) ? this.cars.get(o.carId).plate : o.carId }));
  }

  /** Starea SMS-ului către client (sending | sent | simulated | failed | no_phone | invalid_phone). */
  setRideSms(rideId, status, detail = '') {
    const ride = this.getRide(rideId);
    if (!ride) return;
    ride.sms = { status, detail: String(detail).slice(0, 300), at: this.now() };
    this.repo.saveRideSms(ride.id, ride.sms);
    this.emit('ride', ride);
  }

  /**
   * Schimbă statusul unei curse.
   * `actor` este { role: 'dispatcher', userId, name } sau { role: 'driver', carId }.
   */
  updateRideStatus(rideId, status, actor) {
    const ride = this.rides.get(String(rideId));
    if (!ride) {
      const stored = this.repo.rideById(rideId);
      return { ok: false, error: stored ? 'Cursa este deja încheiată' : 'Cursă inexistentă' };
    }
    if (!RIDE_STATUSES.includes(status)) return { ok: false, error: 'Status invalid' };
    if (actor && actor.role === 'driver') {
      if (ride.carId !== actor.carId) return { ok: false, error: 'Cursa nu vă aparține' };
      if (!DRIVER_RIDE_STATUSES.has(status)) return { ok: false, error: 'Acțiune nepermisă' };
    }
    if (!TRANSITIONS[ride.status].includes(status)) {
      return { ok: false, error: `Cursa nu poate trece din „${ride.status}” în „${status}”` };
    }

    const ts = this.now();
    const car = ride.carId ? this.cars.get(ride.carId) : null;
    ride.status = status;
    ride.updatedAt = ts;
    ride.statusTimes[status] = ts;
    if (FINISHED.has(status)) {
      ride.closedByName = actor && actor.role === 'driver' ? 'Șofer' : (actor && actor.name) || 'Dispecerat';
      this._closeOffers(ride.id, 'withdrawn');
    }
    if (car && car.position) {
      // Kilometrajul pornește de la locul preluării clientului.
      if (status === 'in_progress') ride.odometerFrom = { ...car.position, ts };
      this._recordRideProgress(ride, { ...car.position, ts }, true);
    }
    this.repo.updateRide(ride);

    if (FINISHED.has(status)) {
      this._untrackRide(ride);
      if (car && car.rideId === ride.id) {
        car.rideId = null;
        car.status = this._isOnline(car) ? 'free' : 'offline';
        this.emit('car', car);
      }
    }
    this.emit('ride', ride);
    return { ok: true, ride };
  }

  /**
   * Cursa care interesează aplicația șoferului: cea activă sau, dacă nu are, ultima încheiată în
   * ultimele `withinMs` (ca aplicația din fundal să afle că o cursă a fost anulată).
   */
  driverRide(carId, withinMs = 10 * 60 * 1000) {
    const car = this.cars.get(carId);
    if (!car) return null;
    if (car.rideId) return this.rides.get(car.rideId) || null;
    const latest = this.repo.latestRideForCar(carId);
    return latest && FINISHED.has(latest.status) && this.now() - latest.updatedAt <= withinMs ? latest : null;
  }

  getRide(rideId) {
    return this.rides.get(String(rideId)) || this.repo.rideById(rideId);
  }

  /** Cursa linkului de urmărire, doar cât timp e în desfășurare: după încheiere linkul dispare. */
  getRideByToken(token) {
    if (typeof token !== 'string' || !token) return null;
    const ride = this.ridesByToken.get(token);
    return ride && LINK_STATUSES.has(ride.status) ? ride : null;
  }

  isFinished(ride) {
    return FINISHED.has(ride.status);
  }

  /** Cursele active (și comenzile în așteptare) plus ultimele 20 încheiate în ultimele 24 de ore. */
  listRides() {
    const active = [...this.rides.values()].sort((a, b) => b.createdAt - a.createdAt);
    const finished = this.repo.recentFinished(this.now() - RECENT_FINISHED_MS, 20);
    return [...active, ...finished];
  }

  /** Ce vede clientul pe pagina de urmărire — fără datele altor clienți sau ale flotei. */
  trackingView(ride) {
    // După încheiere linkul nu mai arată nimic despre mașină sau șofer.
    if (!LINK_STATUSES.has(ride.status)) return { ride: { status: ride.status }, car: null, distanceM: null, etaMin: null };
    const car = this.cars.get(ride.carId);
    const view = {
      ride: {
        status: ride.status,
        address: ride.address,
        pickup: ride.pickup,
        createdAt: ride.createdAt,
        updatedAt: ride.updatedAt,
      },
      car: {
        plate: ride.carPlate,
        model: car ? car.model : '',
        driverFirstName: ride.driverName.split(/\s+/)[0],
        online: Boolean(car && car.status !== 'offline'),
        position: car ? car.position : null,
      },
      distanceM: null,
      etaMin: null,
    };
    if (view.car.position && ride.status === 'assigned') {
      view.distanceM = Math.round(Geo.distanceMeters(view.car.position, ride.pickup));
      view.etaMin = Geo.etaMinutes(view.distanceM, this.avgSpeedKmh);
    }
    return view;
  }

  // ---- Istoric ----

  searchRides(filters, page) {
    return this.repo.searchRides(filters, page);
  }

  rideStats(filters) {
    return this.repo.rideStats(filters);
  }

  rideRoute(rideId) {
    return this.repo.ridePoints(rideId);
  }

  /** Șterge punctele de traseu mai vechi de `days` zile (cursele rămân în istoric). */
  pruneRoutes(days) {
    return this.repo.pruneRidePoints(this.now() - days * 24 * 60 * 60 * 1000);
  }

  _trackRide(ride) {
    this.rides.set(ride.id, ride);
    this.ridesByToken.set(ride.token, ride);
  }

  _untrackRide(ride) {
    this.rides.delete(ride.id);
    this.ridesByToken.delete(ride.token);
    this.offers.delete(ride.id);
  }
}

module.exports = { FleetStore, importCars, normalizePlate, CAR_STATUSES, RIDE_STATUSES, LINK_STATUSES };
