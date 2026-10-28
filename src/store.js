const crypto = require('crypto');
const { EventEmitter } = require('events');
const Geo = require('../shared/geo');

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
const FINISHED_RIDE_TTL_MS = 24 * 60 * 60 * 1000;

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function cleanText(value, maxLength) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') return null;
  return value.trim().slice(0, maxLength);
}

function optionalNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Starea flotei și a curselor, ținută în memorie.
 * Emite 'car' (mașina modificată) și 'ride' (cursa modificată).
 */
class FleetStore extends EventEmitter {
  constructor({ cars, avgSpeedKmh = 25, now = Date.now }) {
    super();
    this.now = now;
    this.avgSpeedKmh = avgSpeedKmh;
    this.cars = new Map();
    this.rides = new Map();
    this.ridesByToken = new Map();
    this.rideCounter = 0;
    for (const c of cars) {
      this.cars.set(c.id, {
        id: c.id,
        plate: c.plate,
        model: c.model || '',
        driver: c.driver,
        pin: c.pin,
        status: 'offline',
        connections: 0,
        rideId: null,
        position: null,
        trail: [],
        lastSeen: null,
      });
    }
  }

  // ---- Mașini ----

  verifyDriver(carId, pin) {
    const car = this.cars.get(carId);
    return Boolean(car && typeof pin === 'string' && safeEqual(car.pin, pin));
  }

  carExists(carId) {
    return this.cars.has(carId);
  }

  /** Informații publice despre flotă (pentru ecranul de autentificare al șoferului). */
  carDirectory() {
    return [...this.cars.values()].map((c) => ({ id: c.id, plate: c.plate, model: c.model }));
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
      status: car.status,
      rideId: car.rideId,
      position: car.position,
      lastSeen: car.lastSeen,
    };
    if (withTrail) view.trail = car.trail.slice();
    return view;
  }

  listCars() {
    return [...this.cars.values()].map((c) => this.carView(c, { withTrail: true }));
  }

  getCarView(carId) {
    const car = this.cars.get(carId);
    return car ? this.carView(car) : null;
  }

  driverConnected(carId) {
    const car = this.cars.get(carId);
    if (!car) return;
    car.connections += 1;
    if (car.status === 'offline') {
      car.status = car.rideId ? 'busy' : 'free';
    }
    car.lastSeen = this.now();
    this._emitCar(car);
  }

  driverDisconnected(carId) {
    const car = this.cars.get(carId);
    if (!car) return;
    car.connections = Math.max(0, car.connections - 1);
    if (car.connections === 0) {
      car.status = 'offline';
      this._emitCar(car);
    }
  }

  updateLocation(carId, data) {
    const car = this.cars.get(carId);
    if (!car) return { ok: false, error: 'Mașină necunoscută' };
    if (!data || !Geo.isValidLatLng(data.lat, data.lng)) {
      return { ok: false, error: 'Coordonate invalide' };
    }
    const ts = this.now();
    if (car.position && ts - car.position.ts < MIN_LOCATION_INTERVAL_MS) {
      return { ok: true, ignored: true };
    }

    let heading = optionalNumber(data.heading);
    if (heading === null && car.position) {
      // Telefonul nu trimite mereu direcția; o calculăm din ultimele două poziții.
      const moved = Geo.distanceMeters(car.position, data);
      heading = moved > 3 ? Geo.bearingDegrees(car.position, data) : car.position.heading;
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
    this._emitCar(car);
    return { ok: true };
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
    this._emitCar(car);
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
    if (!car) return { ok: false, error: 'Alegeți o mașină' };
    if (car.status !== 'free' || car.rideId) {
      return { ok: false, error: `Mașina ${car.plate} nu este liberă` };
    }

    this._pruneFinishedRides();
    const ts = this.now();
    const ride = {
      id: String(++this.rideCounter),
      token: crypto.randomBytes(16).toString('base64url'),
      customerName,
      phone,
      address,
      notes,
      pickup: { lat: pickup.lat, lng: pickup.lng },
      carId: car.id,
      status: 'assigned',
      createdAt: ts,
      updatedAt: ts,
      statusTimes: { assigned: ts },
    };
    this.rides.set(ride.id, ride);
    this.ridesByToken.set(ride.token, ride);

    car.rideId = ride.id;
    car.status = 'busy';
    this._emitCar(car);
    this.emit('ride', ride);
    return { ok: true, ride };
  }

  /**
   * Schimbă statusul unei curse.
   * `actor` este { role: 'dispatcher' } sau { role: 'driver', carId }.
   */
  updateRideStatus(rideId, status, actor) {
    const ride = this.rides.get(rideId);
    if (!ride) return { ok: false, error: 'Cursă inexistentă' };
    if (!RIDE_STATUSES.includes(status)) return { ok: false, error: 'Status invalid' };
    if (actor && actor.role === 'driver') {
      if (ride.carId !== actor.carId) return { ok: false, error: 'Cursa nu vă aparține' };
      if (!DRIVER_RIDE_STATUSES.has(status)) return { ok: false, error: 'Acțiune nepermisă' };
    }
    if (!TRANSITIONS[ride.status].includes(status)) {
      return { ok: false, error: `Cursa nu poate trece din „${ride.status}” în „${status}”` };
    }

    const ts = this.now();
    ride.status = status;
    ride.updatedAt = ts;
    ride.statusTimes[status] = ts;

    if (FINISHED.has(status)) {
      const car = this.cars.get(ride.carId);
      if (car && car.rideId === ride.id) {
        car.rideId = null;
        car.status = car.connections > 0 ? 'free' : 'offline';
        this._emitCar(car);
      }
    }
    this.emit('ride', ride);
    return { ok: true, ride };
  }

  getRide(rideId) {
    return this.rides.get(rideId) || null;
  }

  getRideByToken(token) {
    return (typeof token === 'string' && this.ridesByToken.get(token)) || null;
  }

  isFinished(ride) {
    return FINISHED.has(ride.status);
  }

  /** Cursele active plus ultimele 20 încheiate, cele mai noi primele. */
  listRides() {
    const all = [...this.rides.values()].sort((a, b) => b.createdAt - a.createdAt);
    const active = all.filter((r) => !FINISHED.has(r.status));
    const finished = all.filter((r) => FINISHED.has(r.status)).slice(0, 20);
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
        plate: car.plate,
        model: car.model,
        driverFirstName: car.driver.split(/\s+/)[0],
        online: car.status !== 'offline',
        // După încheierea cursei nu mai arătăm unde se află mașina.
        position: finished ? null : car.position,
      },
      distanceM: null,
      etaMin: null,
    };
    if (!finished && car.position && ride.status === 'assigned') {
      view.distanceM = Math.round(Geo.distanceMeters(car.position, ride.pickup));
      view.etaMin = Geo.etaMinutes(view.distanceM, this.avgSpeedKmh);
    }
    return view;
  }

  _pruneFinishedRides() {
    const cutoff = this.now() - FINISHED_RIDE_TTL_MS;
    for (const ride of this.rides.values()) {
      if (FINISHED.has(ride.status) && ride.updatedAt < cutoff) {
        this.rides.delete(ride.id);
        this.ridesByToken.delete(ride.token);
      }
    }
  }

  _emitCar(car) {
    this.emit('car', car);
  }
}

module.exports = { FleetStore, CAR_STATUSES, RIDE_STATUSES };
