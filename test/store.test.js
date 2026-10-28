const test = require('node:test');
const assert = require('node:assert/strict');
const { FleetStore, importCars } = require('../src/store');
const { openDatabase, createRepository } = require('../src/db');
const { hashSecret: hashPin, verifySecret: verifyPin } = require('../src/secret');

const CARS = [
  { id: 'a', plate: 'B 01 AAA', model: 'Logan', driver: 'Ion Popescu', pin: '1111' },
  { id: 'b', plate: 'B 02 BBB', model: 'Octavia', driver: 'Maria Ionescu', pin: '2222' },
];
const PICKUP = { lat: 44.43, lng: 26.1 };
const DRIVER_A = { role: 'driver', carId: 'a' };
const DISPATCHER = { role: 'dispatcher' };

function setup() {
  let t = 1_700_000_000_000;
  const clock = { now: () => t, advance: (ms) => (t += ms) };
  const db = openDatabase(':memory:');
  const repo = createRepository(db);
  importCars(repo, CARS, t);
  const store = new FleetStore({ repo, avgSpeedKmh: 25, now: clock.now });
  // „Repornirea” serverului: un store nou peste aceeași bază de date.
  const restart = () => new FleetStore({ repo, avgSpeedKmh: 25, now: clock.now });
  return { store, clock, repo, restart };
}

/** Comandă trimisă unei mașini și acceptată de șoferul ei (dispecer → șofer). */
function newRide(store, overrides = {}, actor) {
  const { carId = 'a', ...fields } = overrides;
  const order = store.createOrder(
    { customerName: 'Ana', phone: '0722', address: 'Str. X 1', pickup: PICKUP, target: { mode: 'car', carId }, ...fields },
    actor
  );
  if (!order.ok) return order;
  return store.acceptOffer(order.ride.id, carId);
}

/** Trimite poziții la câte o secundă, deplasându-se spre nord cu `stepDeg` grade. */
function drive(store, clock, carId, from, steps, stepDeg = 0.0001) {
  let lat = from.lat;
  for (let i = 0; i < steps; i++) {
    clock.advance(1000);
    lat += stepDeg;
    store.updateLocation(carId, { lat, lng: from.lng, accuracy: 5 });
  }
  return { lat, lng: from.lng };
}

// ---------- Mașini ----------

test('PIN-urile se păstrează doar ca hash', () => {
  const hash = hashPin('1234');
  assert.match(hash, /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
  assert.equal(verifyPin('1234', hash), true);
  assert.equal(verifyPin('1235', hash), false);
  assert.equal(verifyPin(undefined, hash), false);
  assert.equal(verifyPin('1234', 'invalid'), false);
});

test('verifică PIN-ul șoferului', () => {
  const { store } = setup();
  assert.equal(store.verifyDriver('a', '1111'), true);
  assert.equal(store.verifyDriver('a', '2222'), false);
  assert.equal(store.verifyDriver('a', undefined), false);
  assert.equal(store.verifyDriver('zzz', '1111'), false);
});

test('listele de mașini nu conțin PIN-uri', () => {
  const { store } = setup();
  const json = JSON.stringify([store.carDirectory(), store.listCars(), store.adminCars()]);
  assert.ok(!/pin/i.test(json), json);
});

test('mașina devine liberă la conectare și deconectată când pleacă ultimul telefon', () => {
  const { store } = setup();
  assert.equal(store.getCarView('a').status, 'offline');
  store.driverConnected('a');
  store.driverConnected('a');
  assert.equal(store.getCarView('a').status, 'free');
  store.driverDisconnected('a');
  assert.equal(store.getCarView('a').status, 'free');
  store.driverDisconnected('a');
  assert.equal(store.getCarView('a').status, 'offline');
});

test('actualizarea locației validează coordonatele și limitează frecvența', () => {
  const { store, clock } = setup();
  assert.equal(store.updateLocation('a', { lat: 200, lng: 26 }).ok, false);
  assert.equal(store.updateLocation('a', { lat: '44', lng: 26 }).ok, false);
  assert.equal(store.updateLocation('a', null).ok, false);

  assert.deepEqual(store.updateLocation('a', { lat: 44.4, lng: 26.1, speed: 10 }), { ok: true });
  // Prea repede după actualizarea anterioară: ignorată.
  clock.advance(100);
  assert.equal(store.updateLocation('a', { lat: 44.5, lng: 26.1 }).ignored, true);
  assert.equal(store.getCarView('a').position.lat, 44.4);

  clock.advance(1000);
  store.updateLocation('a', { lat: 44.41, lng: 26.1 });
  const pos = store.getCarView('a').position;
  assert.equal(pos.lat, 44.41);
  // Fără direcție de la telefon, se calculează din deplasare (spre nord ≈ 0°).
  assert.ok(pos.heading < 1 || pos.heading > 359);
});

test('traseul recent are lungime limitată', () => {
  const { store, clock } = setup();
  drive(store, clock, 'a', { lat: 44.4, lng: 26.1 }, 50, 0.001);
  const car = store.listCars().find((c) => c.id === 'a');
  assert.equal(car.trail.length, 30);
});

test('ultima poziție a mașinii se păstrează după repornire', () => {
  const { store, clock, restart } = setup();
  store.driverConnected('a');
  store.updateLocation('a', { lat: 44.4, lng: 26.1 });
  clock.advance(1000);
  store.updateLocation('a', { lat: 44.41, lng: 26.1 }); // prea devreme pentru salvare…
  store.driverDisconnected('a'); // …dar la deconectare se salvează
  const car = restart().getCarView('a');
  assert.equal(car.status, 'offline');
  assert.equal(car.position.lat, 44.41);
});

// ---------- Administrarea flotei ----------

test('adăugarea unei mașini validează datele și generează un id', () => {
  const { store } = setup();
  assert.match(store.createCar({ plate: '', driver: 'X', pin: '1234' }).error, /înmatriculare/);
  assert.match(store.createCar({ plate: 'B 03 CCC', driver: '', pin: '1234' }).error, /șoferului/);
  assert.match(store.createCar({ plate: 'B 03 CCC', driver: 'X', pin: '12' }).error, /PIN/);
  assert.match(store.createCar({ plate: 'b  01 aaa', driver: 'X', pin: '1234' }).error, /Există deja/);

  const result = store.createCar({ plate: ' b 03  ccc ', model: 'Ioniq', driver: 'Dan Pop', pin: '987654' });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.car.id, 'b-03-ccc');
  assert.equal(result.car.plate, 'B 03 CCC');
  assert.equal(store.verifyDriver('b-03-ccc', '987654'), true);
  assert.ok(store.carDirectory().some((c) => c.id === 'b-03-ccc'));
});

test('modificarea mașinii și schimbarea PIN-ului', () => {
  const { store, restart } = setup();
  const revoked = [];
  store.on('car:revoked', (c) => revoked.push(c.id));

  assert.equal(store.updateCar('a', { plate: 'B 02 BBB', driver: 'X' }).ok, false);
  assert.equal(store.updateCar('a', { plate: 'B 01 AAA', model: 'Spring', driver: 'Ion Popescu' }).ok, true);
  assert.deepEqual(revoked, []); // fără PIN nou, șoferul rămâne conectat
  assert.equal(store.verifyDriver('a', '1111'), true);

  assert.equal(store.updateCar('a', { plate: 'B 01 AAA', driver: 'Ion Popescu', pin: '5555' }).ok, true);
  assert.deepEqual(revoked, ['a']);
  assert.equal(store.verifyDriver('a', '1111'), false);

  const after = restart();
  assert.equal(after.verifyDriver('a', '5555'), true);
  assert.equal(after.getCarView('a').model, '');
});

test('dezactivarea scoate mașina din flotă, dar nu în timpul unei curse', () => {
  const { store, restart } = setup();
  const revoked = [];
  store.on('car:revoked', (c) => revoked.push(c.id));
  store.driverConnected('a');
  const { ride } = newRide(store);
  assert.match(store.setCarActive('a', false).error, /cursă activă/);

  store.updateRideStatus(ride.id, 'completed', DISPATCHER);
  assert.equal(store.setCarActive('a', false).ok, true);
  assert.deepEqual(revoked, ['a']);
  assert.equal(store.verifyDriver('a', '1111'), false);
  assert.ok(!store.carDirectory().some((c) => c.id === 'a'));
  assert.ok(!store.listCars().some((c) => c.id === 'a'));
  assert.equal(store.adminCars().find((c) => c.id === 'a').active, false);
  assert.equal(newRide(store).ok, false);

  assert.equal(restart().verifyDriver('a', '1111'), false);
  assert.equal(store.setCarActive('a', true).ok, true);
  assert.equal(store.verifyDriver('a', '1111'), true);
});

// ---------- Curse ----------

test('cursa se poate trimite doar la o mașină liberă', () => {
  const { store } = setup();
  assert.match(newRide(store).error, /nu este liberă/);

  store.driverConnected('a');
  const result = newRide(store);
  assert.equal(result.ok, true);
  assert.equal(result.ride.status, 'assigned');
  assert.equal(result.ride.carPlate, 'B 01 AAA');
  assert.ok(result.ride.token.length >= 20);
  assert.equal(store.getRideByToken(result.ride.token), result.ride);

  const car = store.getCarView('a');
  assert.equal(car.status, 'busy');
  assert.equal(car.rideId, result.ride.id);
  assert.match(newRide(store).error, /nu este liberă/);
});

test('validarea datelor cursei', () => {
  const { store } = setup();
  store.driverConnected('a');
  assert.equal(newRide(store, { customerName: '  ' }).ok, false);
  assert.equal(newRide(store, { customerName: { x: 1 } }).ok, false);
  assert.equal(newRide(store, { pickup: { lat: 91, lng: 0 } }).ok, false);
  assert.equal(newRide(store, { pickup: null }).ok, false);
  assert.equal(newRide(store, { carId: 'nu-exista' }).ok, false);
  assert.equal(store.createOrder(null).ok, false);
  assert.equal(newRide(store, { customerName: 'x'.repeat(500) }).ride.customerName.length, 80);
});

test('șoferul conduce cursa până la final, iar mașina redevine liberă', () => {
  const { store } = setup();
  store.driverConnected('a');
  store.driverConnected('b');
  const { ride } = newRide(store);

  assert.equal(store.updateRideStatus(ride.id, 'arrived', { role: 'driver', carId: 'b' }).ok, false);
  assert.equal(store.updateRideStatus(ride.id, 'cancelled', DRIVER_A).ok, false);
  assert.equal(store.updateRideStatus(ride.id, 'bogus', DRIVER_A).ok, false);

  assert.equal(store.updateRideStatus(ride.id, 'arrived', DRIVER_A).ok, true);
  assert.equal(store.updateRideStatus(ride.id, 'in_progress', DRIVER_A).ok, true);
  assert.equal(store.updateRideStatus(ride.id, 'arrived', DRIVER_A).ok, false);
  assert.equal(store.updateRideStatus(ride.id, 'completed', DRIVER_A).ok, true);
  assert.match(store.updateRideStatus(ride.id, 'cancelled', DISPATCHER).error, /deja încheiată/);
  assert.match(store.updateRideStatus('999', 'cancelled', DISPATCHER).error, /inexistentă/);

  const stored = store.getRide(ride.id);
  assert.deepEqual(Object.keys(stored.statusTimes), ['pending', 'assigned', 'arrived', 'in_progress', 'completed']);
  assert.equal(stored.status, 'completed');
  const car = store.getCarView('a');
  assert.equal(car.status, 'free');
  assert.equal(car.rideId, null);
});

test('cursele active continuă după repornirea serverului', () => {
  const { store, clock, restart } = setup();
  store.driverConnected('a');
  const { ride } = newRide(store);
  store.updateRideStatus(ride.id, 'arrived', DRIVER_A);

  const after = restart();
  const restored = after.getRideByToken(ride.token);
  assert.equal(restored.status, 'arrived');
  assert.equal(restored.id, ride.id);
  assert.equal(after.getCarView('a').rideId, ride.id);
  assert.equal(after.listRides().length, 1);

  // Șoferul se reconectează și termină cursa normal.
  after.driverConnected('a');
  assert.equal(after.getCarView('a').status, 'busy');
  clock.advance(1000);
  assert.equal(after.updateRideStatus(ride.id, 'in_progress', DRIVER_A).ok, true);
  assert.equal(after.updateRideStatus(ride.id, 'completed', DRIVER_A).ok, true);
  assert.equal(after.getCarView('a').status, 'free');
});

test('anularea unei curse pentru o mașină deconectată o lasă deconectată', () => {
  const { store } = setup();
  store.driverConnected('a');
  const { ride } = newRide(store);
  store.driverDisconnected('a');
  assert.equal(store.updateRideStatus(ride.id, 'cancelled', DISPATCHER).ok, true);
  assert.equal(store.getCarView('a').status, 'offline');
  store.driverConnected('a');
  assert.equal(store.getCarView('a').status, 'free');
});

test('șoferul cu cursă activă nu se poate declara liber', () => {
  const { store } = setup();
  store.driverConnected('a');
  assert.equal(store.setCarStatus('a', 'busy').ok, true);
  assert.equal(store.setCarStatus('a', 'free').ok, true);
  newRide(store);
  assert.equal(store.setCarStatus('a', 'free').ok, false);
  assert.equal(store.setCarStatus('a', 'offline').ok, false);
});

test('pagina clientului primește distanța și timpul estimat, fără date despre alți clienți', () => {
  const { store, clock } = setup();
  store.driverConnected('a');
  store.updateLocation('a', { lat: 44.42, lng: 26.1 }); // ~1,1 km sud de preluare
  const { ride } = newRide(store);

  const view = store.trackingView(ride);
  assert.equal(view.car.plate, 'B 01 AAA');
  assert.equal(view.car.driverFirstName, 'Ion');
  assert.ok(view.distanceM > 1000 && view.distanceM < 1200, `distanța ${view.distanceM}`);
  assert.ok(view.etaMin >= 3 && view.etaMin <= 5, `ETA ${view.etaMin}`);
  const json = JSON.stringify(view);
  assert.ok(!json.includes('0722') && !json.includes('Ana') && !json.includes(ride.token));

  store.updateRideStatus(ride.id, 'arrived', DISPATCHER);
  assert.equal(store.trackingView(ride).etaMin, null);

  store.updateRideStatus(ride.id, 'completed', DISPATCHER);
  // După încheierea cursei linkul dispare și nu mai arată nimic despre mașină sau șofer.
  assert.equal(store.getRideByToken(ride.token), null);
  assert.deepEqual(store.trackingView(store.getRide(ride.id)), { ride: { status: 'completed' }, car: null, distanceM: null, etaMin: null });
});

test('cursele încheiate rămân o zi în lista dispecerului și oricât în istoric', () => {
  const { store, clock } = setup();
  store.driverConnected('a');
  const { ride } = newRide(store);
  store.updateRideStatus(ride.id, 'completed', DISPATCHER);
  assert.equal(store.listRides().length, 1);

  clock.advance(25 * 60 * 60 * 1000);
  assert.equal(store.listRides().length, 0);
  assert.equal(store.getRide(ride.id).status, 'completed');
  assert.equal(store.searchRides({}, { limit: 10, offset: 0 }).total, 1);
});

// ---------- Traseu, kilometraj, istoric ----------

test('traseul cursei și kilometrajul cu clientul în mașină', () => {
  const { store, clock } = setup();
  store.driverConnected('a');
  store.updateLocation('a', { lat: 44.42, lng: 26.1, accuracy: 5 });
  const { ride } = newRide(store);

  // Drumul până la client nu intră în kilometraj.
  const atPickup = drive(store, clock, 'a', { lat: 44.42, lng: 26.1 }, 30);
  store.updateRideStatus(ride.id, 'arrived', DRIVER_A);
  clock.advance(5000);
  store.updateRideStatus(ride.id, 'in_progress', DRIVER_A);

  // 60 × 0,0001° ≈ 667 m cu clientul; o poziție imprecisă și un salt GPS sunt ignorate.
  const end = drive(store, clock, 'a', atPickup, 30);
  clock.advance(1000);
  store.updateLocation('a', { lat: end.lat + 0.01, lng: end.lng, accuracy: 200 });
  clock.advance(1000);
  store.updateLocation('a', { lat: end.lat + 0.05, lng: end.lng, accuracy: 5 }); // salt de ~5 km într-o secundă
  clock.advance(1000);
  store.updateLocation('a', { lat: end.lat, lng: end.lng, accuracy: 5 });
  drive(store, clock, 'a', end, 30);
  store.updateRideStatus(ride.id, 'completed', DRIVER_A);

  const stored = store.getRide(ride.id);
  assert.ok(stored.distanceM > 640 && stored.distanceM < 700, `distanța ${stored.distanceM}`);

  const points = store.rideRoute(ride.id);
  const phases = [...new Set(points.map((p) => p.status))];
  assert.deepEqual(phases, ['assigned', 'arrived', 'in_progress', 'completed']);
  // Un punct la 10 s (+ unul la fiecare schimbare de status), nu la fiecare secundă.
  assert.ok(points.length >= 10 && points.length <= 20, `${points.length} puncte`);
  assert.ok(points.every((p, i) => i === 0 || p.ts >= points[i - 1].ts));
});

test('punctele de traseu vechi se șterg, cursele rămân', () => {
  const { store, clock } = setup();
  store.driverConnected('a');
  store.updateLocation('a', { lat: 44.42, lng: 26.1 });
  const { ride } = newRide(store);
  store.updateRideStatus(ride.id, 'completed', DISPATCHER);
  assert.ok(store.rideRoute(ride.id).length > 0);

  clock.advance(10 * 24 * 60 * 60 * 1000);
  assert.ok(store.pruneRoutes(7) > 0);
  assert.equal(store.rideRoute(ride.id).length, 0);
  assert.equal(store.getRide(ride.id).status, 'completed');
});

test('căutarea în istoric și statisticile', () => {
  const { store, clock } = setup();
  store.driverConnected('a');
  store.driverConnected('b');
  const start = clock.now();

  const r1 = newRide(store, { customerName: 'Ana Pop', phone: '0711 111 111' }).ride;
  clock.advance(4 * 60 * 1000);
  store.updateRideStatus(r1.id, 'arrived', DRIVER_A); // 4 min până la client
  store.updateRideStatus(r1.id, 'in_progress', DRIVER_A);
  clock.advance(10 * 60 * 1000);
  store.updateRideStatus(r1.id, 'completed', DRIVER_A); // 10 min de cursă

  const r2 = newRide(store, { customerName: 'Dan_Ion 100%', carId: 'b', address: 'Bd. Unirii' }).ride;
  store.updateRideStatus(r2.id, 'cancelled', DISPATCHER);
  clock.advance(1000);
  const r3 = newRide(store, { customerName: 'Elena' }).ride;

  const page = { limit: 50, offset: 0 };
  const all = store.searchRides({}, page);
  assert.equal(all.total, 3);
  assert.deepEqual(all.rides.map((r) => r.id), [r3.id, r2.id, r1.id]);

  assert.deepEqual(store.searchRides({ status: 'active' }, page).rides.map((r) => r.id), [r3.id]);
  assert.deepEqual(store.searchRides({ status: 'cancelled' }, page).rides.map((r) => r.id), [r2.id]);
  assert.deepEqual(store.searchRides({ carId: 'b' }, page).rides.map((r) => r.id), [r2.id]);
  assert.deepEqual(store.searchRides({ q: '0711' }, page).rides.map((r) => r.id), [r1.id]);
  assert.deepEqual(store.searchRides({ q: 'unirii' }, page).rides.map((r) => r.id), [r2.id]);
  // Caracterele speciale din LIKE (%, _) se caută literal.
  assert.deepEqual(store.searchRides({ q: '100%' }, page).rides.map((r) => r.id), [r2.id]);
  assert.equal(store.searchRides({ q: '_' }, page).total, 1);
  assert.equal(store.searchRides({ from: start + 1000 }, page).total, 2);
  assert.equal(store.searchRides({ to: start + 1 }, page).total, 1);
  assert.deepEqual(store.searchRides({}, { limit: 1, offset: 1 }).rides.map((r) => r.id), [r2.id]);

  const stats = store.rideStats({});
  assert.equal(stats.total, 3);
  assert.equal(stats.completed, 1);
  assert.equal(stats.cancelled, 1);
  assert.equal(stats.avgPickupMs, 4 * 60 * 1000);
  assert.equal(stats.avgRideMs, 10 * 60 * 1000);
  assert.deepEqual(
    stats.byDriver.map((d) => [d.carPlate, d.driverName, d.total, d.completed, d.cancelled]),
    [
      ['B 01 AAA', 'Ion Popescu', 2, 1, 0],
      ['B 02 BBB', 'Maria Ionescu', 1, 0, 1],
    ]
  );

  const empty = store.rideStats({ from: clock.now() + 1 });
  assert.equal(empty.total, 0);
  assert.equal(empty.avgPickupMs, null);
  assert.deepEqual(empty.byDriver, []);
});

test('istoricul păstrează numărul și șoferul de la momentul cursei', () => {
  const { store } = setup();
  store.driverConnected('a');
  const { ride } = newRide(store);
  store.updateRideStatus(ride.id, 'completed', DISPATCHER);
  store.updateCar('a', { plate: 'B 99 NEW', driver: 'Alt Șofer' });
  const stored = store.getRide(ride.id);
  assert.equal(stored.carPlate, 'B 01 AAA');
  assert.equal(stored.driverName, 'Ion Popescu');
});

test('emite evenimente la schimbări', () => {
  const { store } = setup();
  const events = [];
  store.on('car', (c) => events.push(['car', c.id, c.status]));
  store.on('ride', (r) => events.push(['ride', r.id, r.status]));
  store.driverConnected('a');
  newRide(store);
  assert.deepEqual(events, [
    ['car', 'a', 'free'],
    ['ride', '1', 'pending'],
    ['car', 'a', 'busy'],
    ['ride', '1', 'assigned'],
  ]);
});

test('cursa reține dispecerul care a creat-o și cine a închis-o', () => {
  const { store, repo } = setup();
  store.driverConnected('a');
  store.driverConnected('b');
  const userId = repo.insertUser({ username: 'maria', name: 'Maria', passwordHash: 'x', role: 'dispatcher', active: true, mustChangePassword: false, createdAt: 1 });
  const maria = { role: 'dispatcher', userId, name: 'Maria' };

  const r1 = newRide(store).ride;
  assert.equal(r1.createdByName, '');
  const r2 = newRide(store, { customerName: 'Dan', carId: 'b' }, maria).ride;
  assert.equal(r2.createdByName, 'Maria');
  assert.equal(r2.createdById, userId);

  store.updateRideStatus(r1.id, 'completed', DRIVER_A);
  store.updateRideStatus(r2.id, 'cancelled', maria);
  assert.equal(store.getRide(r1.id).closedByName, 'Șofer');
  assert.equal(store.getRide(r2.id).closedByName, 'Maria');
  assert.equal(store.getRide(r2.id).createdByName, 'Maria');

  assert.deepEqual(
    store.rideStats({}).byDispatcher.map((d) => [d.name, d.total, d.completed, d.cancelled]),
    [
      ['', 1, 1, 0],
      ['Maria', 1, 0, 1],
    ]
  );
});

// ---------- Aplicația șoferului: sesiuni și prezență prin HTTP ----------

test('sesiunea șoferului: token în loc de PIN, închisă la PIN nou sau dezactivare', () => {
  const { store, repo } = setup();
  const revoked = [];
  store.on('car:revoked', (c) => revoked.push(c.id));
  assert.match(store.createDriverSession('a', '9999').error, /PIN greșit/);
  assert.equal(store.createDriverSession('zzz', '1111').ok, false);

  const { token, car } = store.createDriverSession('a', '1111', { device: 'Android 14' });
  assert.deepEqual(car, { id: 'a', plate: 'B 01 AAA', model: 'Logan' });
  assert.equal(store.authenticateDriverToken(token), 'a');
  assert.equal(repo.driverSession(token), null); // în baza de date doar hash-ul
  assert.equal(store.authenticateDriverToken(token + 'x'), null);
  assert.equal(store.authenticateDriverToken(undefined), null);

  store.updateCar('a', { plate: 'B 01 AAA', model: 'Logan', driver: 'Ion Popescu', pin: '4321' });
  assert.equal(store.authenticateDriverToken(token), null);
  const second = store.createDriverSession('a', '4321').token;
  store.setCarActive('a', false);
  assert.equal(store.authenticateDriverToken(second), null);
  assert.deepEqual(revoked, ['a', 'a']);
});

test('sesiunea șoferului expiră după 30 de zile fără activitate', () => {
  const { store, clock } = setup();
  const { token } = store.createDriverSession('a', '1111');
  clock.advance(29 * 24 * 60 * 60 * 1000);
  assert.equal(store.authenticateDriverToken(token), 'a'); // activitatea o prelungește
  clock.advance(29 * 24 * 60 * 60 * 1000);
  assert.equal(store.authenticateDriverToken(token), 'a');
  clock.advance(31 * 24 * 60 * 60 * 1000);
  assert.equal(store.authenticateDriverToken(token), null);
});

test('prezența prin HTTP: aplicația din fundal ține mașina conectată', () => {
  const { store, clock } = setup();
  store.driverHeartbeat('a');
  assert.equal(store.getCarView('a').status, 'free');

  // WebSocket-ul se întrerupe (Android îl încetinește în fundal), dar aplicația trimite încă poziția.
  store.driverConnected('a');
  store.driverDisconnected('a');
  assert.equal(store.getCarView('a').status, 'free');

  clock.advance(30 * 1000);
  store.driverHeartbeat('a');
  clock.advance(45 * 1000);
  store.sweepPresence();
  assert.equal(store.getCarView('a').status, 'free');

  clock.advance(20 * 1000); // peste un minut fără semnal
  store.sweepPresence();
  assert.equal(store.getCarView('a').status, 'offline');

  store.driverHeartbeat('a');
  const { ride } = newRide(store);
  assert.equal(store.getCarView('a').status, 'busy');
  store.updateRideStatus(ride.id, 'cancelled', DISPATCHER);
  assert.equal(store.getCarView('a').status, 'free');

  const { token } = store.createDriverSession('a', '1111');
  store.endDriverSession(token);
  assert.equal(store.getCarView('a').status, 'offline');
  assert.equal(store.authenticateDriverToken(token), null);
});

test('aplicația șoferului află și de cursa abia anulată', () => {
  const { store, clock } = setup();
  store.driverHeartbeat('a');
  assert.equal(store.driverRide('a'), null);
  const { ride } = newRide(store);
  assert.equal(store.driverRide('a').status, 'assigned');
  store.updateRideStatus(ride.id, 'cancelled', DISPATCHER);
  assert.equal(store.driverRide('a').status, 'cancelled');
  assert.equal(store.driverRide('a').id, ride.id);
  clock.advance(11 * 60 * 1000);
  assert.equal(store.driverRide('a'), null);
  assert.equal(store.driverRide('nu-exista'), null);
});
