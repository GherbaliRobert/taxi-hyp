const crypto = require('crypto');
const { EventEmitter } = require('events');
const Geo = require('../shared/geo');
const { hashPin, verifyPin, isValidPin } = require('./pin');

const CAR_STATUSES = ['free', 'busy', 'offline'];
const RIDE_STATUSES = ['assigned', 'arrived', 'in_progress', 'completed', 'cancelled'];
const FINISHED = new Set(['completed', 'cancelled']);

// Tranzițiile permise pentru statusul unei curse.
const TRANSITIONS = {
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
// Cât timp după încheiere mai funcționează linkul clientului (arată „Cursa s-a încheiat”).
const FINISHED_LINK_TTL_MS = 24 * 60 * 60 * 1000;
// Ultima poziție a mașinii se salvează în baza de date cel mult o dată la atâtea ms.
const POSITION_SAVE_INTERVAL_MS = 15 * 1000;
// Traseul unei curse se salvează ca un punct la atâtea ms.
const ROUTE_POINT_INTERVAL_MS = 10 * 1000;
// Filtre pentru kilometraj: ignorăm pozițiile imprecise și salturile GPS imposibile.
const ODOMETER_MAX_ACCURACY_M = 50;
const ODOMETER_MAX_SPEED_MS = 60; // ~216 km/h

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
 */
class FleetStore extends EventEmitter {
  constructor({ repo, avgSpeedKmh = 25, now = Date.now }) {
    super();
    this.repo = repo;
    this.now = now;
    this.avgSpeedKmh = avgSpeedKmh;
    this.cars = new Map();
    // Doar cursele active; cele încheiate se citesc din baza de date.
    this.rides = new Map();
    this.ridesByToken = new Map();

    for (const record of repo.listCars()) {
      this.cars.set(record.id, this._carFromRecord(record));
    }
    // După o repornire, cursele active continuă (linkurile clienților rămân valabile).
    for (const ride of repo.activeRides()) {
      this._trackRide(ride);
      const car = this.cars.get(ride.carId);
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
      rideId: null,
      position: record.lastPosition,
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

  /** Modifică datele mașinii; un PIN nou închide sesiunile deschise ale șoferului. */
  updateCar(carId, input) {
    const car = this.cars.get(carId);
    if (!car) return { ok: false, error: 'Mașină inexistentă' };
    const data = this._validateCar(input, carId, { requirePin: false });
    if (data.error) return { ok: false, error: data.error };
    car.plate = data.plate;
    car.model = data.model;
    car.driver = data.driver;
    if (data.pin) car.pinHash = hashPin(data.pin);
    this.repo.updateCar(this._carRecord(car));
    this.emit('car', car);
    if (data.pin) this.emit('car:revoked', car);
    return { ok: true, car: this.adminCars().find((c) => c.id === car.id) };
  }

  /** Dezactivarea scoate mașina de pe hartă și deconectează șoferul; istoricul ei rămâne. */
  setCarActive(carId, active) {
    const car = this.cars.get(carId);
    if (!car) return { ok: false, error: 'Mașină inexistentă' };
    if (!active && car.rideId) return { ok: false, error: 'Mașina are o cursă activă' };
    car.active = Boolean(active);
    this.repo.updateCar(this._carRecord(car));
    this.emit('car', car);
    if (!car.active) this.emit('car:revoked', car);
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
    this.emit('car', car);
  }

  driverDisconnected(carId) {
    const car = this.cars.get(carId);
    if (!car) return;
    car.connections = Math.max(0, car.connections - 1);
    if (car.connections === 0) {
      car.status = 'offline';
      if (car.position) this.repo.saveCarPosition(car.id, car.position);
      this.emit('car', car);
    }
  }

  updateLocation(carId, data) {
    const car = this.cars.get(carId);
    if (!car) return { ok: false, error: 'Mașină necunoscută' };
    if (!data || !Geo.isValidLatLng(data.lat, data.lng)) {
      return { ok: false, error: 'Coordonate invalide' };
    }
    const ts = this.now();
    const previous = car.position;
    if (previous && ts - previous.ts < MIN_LOCATION_INTERVAL_MS) {
      return { ok: true, ignored: true };
    }

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
    car.lastSeen = ts;
    car.trail.push([data.lat, data.lng]);
    if (car.trail.length > TRAIL_LENGTH) car.trail.shift();

    if (car.rideId) this._recordRideProgress(this.rides.get(car.rideId), car.position);
    if (ts - car.lastSavedAt >= POSITION_SAVE_INTERVAL_MS) {
      this.repo.saveCarPosition(car.id, car.position);
      car.lastSavedAt = ts;
    }
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
    this.emit('car', car);
    return { ok: true };
  }

  // ---- Curse ----

  createRide(input) {
    if (!input || typeof input !== 'object') return { ok: false, error: 'Date lipsă' };
    const customerName = cleanText(input.customerName, 80);
    const phone = cleanText(input.phone, 30);
    const address = cleanText(input.address, 200);
    const notes = cleanText(input.notes, 300);
    if (customerName === null || phone === null || address === null || notes === null) {
      return { ok: false, error: 'Date invalide' };
    }
    if (!customerName) return { ok: false, error: 'Introduceți numele clientului' };
    const pickup = input.pickup;
    if (!pickup || !Geo.isValidLatLng(pickup.lat, pickup.lng)) {
      return { ok: false, error: 'Alegeți pe hartă locul de preluare' };
    }
    const car = this.cars.get(input.carId);
    if (!car || !car.active) return { ok: false, error: 'Alegeți o mașină' };
    if (car.status !== 'free' || car.rideId) {
      return { ok: false, error: `Mașina ${car.plate} nu este liberă` };
    }

    const ts = this.now();
    const ride = {
      token: crypto.randomBytes(16).toString('base64url'),
      customerName,
      phone,
      address,
      notes,
      pickup: { lat: pickup.lat, lng: pickup.lng },
      carId: car.id,
      carPlate: car.plate,
      driverName: car.driver,
      status: 'assigned',
      createdAt: ts,
      updatedAt: ts,
      statusTimes: { assigned: ts },
      distanceM: 0,
    };
    ride.id = this.repo.insertRide(ride);
    this._trackRide(ride);
    if (car.position) this._recordRideProgress(ride, { ...car.position, ts }, true);

    car.rideId = ride.id;
    car.status = 'busy';
    this.emit('car', car);
    this.emit('ride', ride);
    return { ok: true, ride };
  }

  /**
   * Schimbă statusul unei curse.
   * `actor` este { role: 'dispatcher' } sau { role: 'driver', carId }.
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
    const car = this.cars.get(ride.carId);
    ride.status = status;
    ride.updatedAt = ts;
    ride.statusTimes[status] = ts;
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
        car.status = car.connections > 0 ? 'free' : 'offline';
        this.emit('car', car);
      }
    }
    this.emit('ride', ride);
    return { ok: true, ride };
  }

  getRide(rideId) {
    return this.rides.get(String(rideId)) || this.repo.rideById(rideId);
  }

  getRideByToken(token) {
    if (typeof token !== 'string' || !token) return null;
    const active = this.ridesByToken.get(token);
    if (active) return active;
    const stored = this.repo.rideByToken(token);
    // Linkurile curselor încheiate expiră după o zi.
    if (!stored || this.now() - stored.updatedAt > FINISHED_LINK_TTL_MS) return null;
    return stored;
  }

  isFinished(ride) {
    return FINISHED.has(ride.status);
  }

  /** Cursele active plus ultimele 20 încheiate în ultimele 24 de ore, cele mai noi primele. */
  listRides() {
    const active = [...this.rides.values()].sort((a, b) => b.createdAt - a.createdAt);
    const finished = this.repo.recentFinished(this.now() - FINISHED_LINK_TTL_MS, 20);
    return [...active, ...finished];
  }

  /** Ce vede clientul pe pagina de urmărire — fără datele altor clienți sau ale flotei. */
  trackingView(ride) {
    const car = this.cars.get(ride.carId);
    const finished = FINISHED.has(ride.status);
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
        // După încheierea cursei nu mai arătăm unde se află mașina.
        position: finished || !car ? null : car.position,
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
  }
}

module.exports = { FleetStore, importCars, normalizePlate, CAR_STATUSES, RIDE_STATUSES };
