#!/usr/bin/env node
// Simulator pentru demonstrații: conectează mașinile din flotă ca „șoferi” și le plimbă prin oraș.
// Mașinile răspund la cursele trimise din dispecerat: merg la client, îl preiau și îl duc la destinație.
//
//   npm run simulate                    toate mașinile, pe străzi (rutare OSRM)
//   npm run simulate -- --cars 3        doar primele 3 mașini
//   npm run simulate -- --straight      fără rutare pe străzi (linie dreaptă)
//   npm run simulate -- --speed 3       demo accelerat (mașinile merg de 3 ori mai repede)
//   npm run simulate -- --url http://server:3000

const path = require('path');
const { io } = require('socket.io-client');
const Geo = require('../shared/geo');
const { loadCars } = require('../src/config');

const args = parseArgs(process.argv.slice(2));
const SERVER_URL = args.url || process.env.SERVER_URL || `http://localhost:${process.env.PORT || 3000}`;
const CENTER = {
  lat: Number(process.env.MAP_CENTER_LAT) || 44.4268,
  lng: Number(process.env.MAP_CENTER_LNG) || 26.1025,
};
const AREA_RADIUS_M = 4000;
const TICK_MS = 1000;
const USE_ROADS = !args.straight;
// Peste ~4× vitezele ar depăși filtrul de salturi GPS din kilometraj (216 km/h).
const SPEED_FACTOR = Math.min(4, Math.max(1, Number(args.speed) || 1));
const OSRM_URL = process.env.OSRM_URL || 'https://router.project-osrm.org';

const allCars = loadCars(process.env.CARS_FILE || path.join(__dirname, '..', 'data', 'cars.json'));
const cars = allCars.slice(0, args.cars ? Number(args.cars) : allCars.length);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '');
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

const rand = (min, max) => min + Math.random() * (max - min);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Punct aleatoriu la cel mult `radius` metri de `center`. */
function randomPoint(center, radius) {
  const r = radius * Math.sqrt(Math.random());
  const angle = Math.random() * 2 * Math.PI;
  const dLat = (r * Math.cos(angle)) / 111320;
  const dLng = (r * Math.sin(angle)) / (111320 * Math.cos((center.lat * Math.PI) / 180));
  return { lat: center.lat + dLat, lng: center.lng + dLng };
}

// Serverul public OSRM acceptă cel mult ~1 cerere pe secundă, așa că le punem la coadă.
let routeQueue = Promise.resolve();
let warnedNoRoads = false;

function routeTo(from, to) {
  if (!USE_ROADS) return Promise.resolve([to]);
  const job = routeQueue.then(async () => {
    try {
      const url = `${OSRM_URL}/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}?overview=full&geometries=geojson`;
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        const data = await res.json();
        const coords = data.routes && data.routes[0] && data.routes[0].geometry.coordinates;
        if (coords && coords.length) return [...coords.map(([lng, lat]) => ({ lat, lng })), to];
      }
    } catch {
      // cădem pe linie dreaptă mai jos
    }
    if (!warnedNoRoads) {
      warnedNoRoads = true;
      console.warn('Rutarea pe străzi (OSRM) nu este disponibilă — mașinile merg în linie dreaptă.');
    }
    return [to];
  });
  routeQueue = job.then(() => sleep(1100));
  return job;
}

class SimulatedCar {
  constructor(car) {
    this.car = car;
    this.pos = randomPoint(CENTER, AREA_RADIUS_M * 0.8);
    this.heading = null;
    this.speed = 0;
    this.route = [];
    this.phase = 'cruise'; // cruise | to_pickup | boarding | to_destination
    this.ride = null;
    this.waitUntil = 0;
    this.routing = false;
    this.planVersion = 0;
  }

  log(message) {
    console.log(`[${this.car.plate}] ${message}`);
  }

  start() {
    this.socket = io(SERVER_URL, { auth: { role: 'driver', carId: this.car.id, pin: this.car.pin } });
    this.socket.on('connect', () => this.log('conectat'));
    this.socket.on('disconnect', () => this.log('deconectat'));
    this.socket.on('connect_error', (err) => this.log(`eroare de conectare: ${err.message}`));
    this.socket.on('driver:init', ({ ride }) => ride && this.onRide(ride));
    this.socket.on('ride:update', (ride) => this.onRide(ride));
    this.cruise();
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  stop() {
    clearInterval(this.timer);
    this.socket.disconnect();
  }

  async goTo(target) {
    const version = ++this.planVersion;
    this.routing = true;
    this.route = [];
    const route = await routeTo(this.pos, target);
    // Între timp poate a venit altă comandă (ex. o cursă nouă); păstrăm doar ultimul plan.
    if (version !== this.planVersion) return;
    this.route = route;
    this.routing = false;
    this.speed = rand(8, 13) * SPEED_FACTOR; // 30–47 km/h în modul normal
  }

  cruise() {
    this.phase = 'cruise';
    this.goTo(randomPoint(CENTER, AREA_RADIUS_M));
  }

  onRide(ride) {
    if (ride.status === 'completed' || ride.status === 'cancelled') {
      if (this.ride && this.ride.id === ride.id) {
        this.log(`cursa #${ride.id} ${ride.status === 'cancelled' ? 'anulată de dispecerat' : 'încheiată'}`);
        this.ride = null;
        this.cruise();
      }
      return;
    }
    const isNew = !this.ride || this.ride.id !== ride.id;
    this.ride = ride;
    if (isNew && ride.status === 'assigned') {
      this.log(`cursă nouă #${ride.id} → ${ride.address || 'punct pe hartă'} (${ride.customerName})`);
      this.phase = 'to_pickup';
      this.waitUntil = 0;
      this.goTo(ride.pickup);
    }
  }

  tick() {
    if (this.routing || Date.now() < this.waitUntil) {
      this.speed = 0;
      return this.send();
    }
    if (!this.route.length) {
      this.arrived();
      return this.send();
    }

    // Avansăm de-a lungul traseului cât parcurge mașina într-o secundă.
    let remaining = (this.speed * TICK_MS) / 1000;
    const before = this.pos;
    while (remaining > 0 && this.route.length) {
      const next = this.route[0];
      const d = Geo.distanceMeters(this.pos, next);
      if (d <= remaining) {
        this.pos = next;
        this.route.shift();
        remaining -= d;
      } else {
        this.pos = Geo.moveTowards(this.pos, next, remaining);
        remaining = 0;
      }
    }
    if (Geo.distanceMeters(before, this.pos) > 1) this.heading = Geo.bearingDegrees(before, this.pos);
    this.send();
  }

  arrived() {
    const rideId = this.ride && this.ride.id;
    switch (this.phase) {
      case 'to_pickup':
        this.log(`a ajuns la client (cursa #${rideId})`);
        this.setRideStatus('arrived');
        this.phase = 'boarding';
        this.waitUntil = Date.now() + rand(6000, 12000) / SPEED_FACTOR;
        break;
      case 'boarding':
        this.log(`client preluat (cursa #${rideId})`);
        this.setRideStatus('in_progress');
        this.phase = 'to_destination';
        this.goTo(randomPoint(this.pos, 3000));
        break;
      case 'to_destination':
        this.log(`cursa #${rideId} finalizată`);
        this.setRideStatus('completed');
        this.ride = null;
        this.waitUntil = Date.now() + rand(3000, 8000) / SPEED_FACTOR;
        this.cruise();
        break;
      default:
        // Mică pauză (semafor, client pe stradă) și apoi alt drum prin oraș.
        this.waitUntil = Date.now() + rand(0, 6000);
        this.cruise();
    }
  }

  setRideStatus(status) {
    if (!this.ride) return;
    this.socket.emit('ride:status', { rideId: this.ride.id, status }, (res) => {
      if (!res.ok) this.log(`nu s-a putut schimba statusul: ${res.error}`);
    });
  }

  send() {
    if (!this.socket.connected) return;
    this.socket.emit('location', {
      lat: this.pos.lat,
      lng: this.pos.lng,
      heading: this.heading,
      speed: this.speed,
      accuracy: 5,
    });
  }
}

async function main() {
  const mode = [USE_ROADS ? '' : 'linie dreaptă', SPEED_FACTOR > 1 ? `viteză ×${SPEED_FACTOR}` : ''].filter(Boolean);
  console.log(`Simulez ${cars.length} mașini către ${SERVER_URL}${mode.length ? ` (${mode.join(', ')})` : ''}`);
  const sims = [];
  for (const car of cars) {
    const sim = new SimulatedCar(car);
    sim.start();
    sims.push(sim);
    await sleep(300);
  }
  process.on('SIGINT', () => {
    sims.forEach((s) => s.stop());
    process.exit(0);
  });
}

main();
