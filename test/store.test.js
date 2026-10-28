const test = require('node:test');
const assert = require('node:assert/strict');
const { FleetStore } = require('../src/store');

const CARS = [
  { id: 'a', plate: 'B 01 AAA', model: 'Logan', driver: 'Ion Popescu', pin: '1111' },
  { id: 'b', plate: 'B 02 BBB', model: 'Octavia', driver: 'Maria Ionescu', pin: '2222' },
];
const PICKUP = { lat: 44.43, lng: 26.1 };

function setup() {
  let t = 1_000_000;
  const clock = { now: () => t, advance: (ms) => (t += ms) };
  const store = new FleetStore({ cars: CARS, avgSpeedKmh: 25, now: clock.now });
  return { store, clock };
}

function newRide(store, overrides) {
  return store.createRide({ customerName: 'Ana', phone: '0722', address: 'Str. X 1', pickup: PICKUP, carId: 'a', ...overrides });
}

test('verifică PIN-ul șoferului', () => {
  const { store } = setup();
  assert.equal(store.verifyDriver('a', '1111'), true);
  assert.equal(store.verifyDriver('a', '2222'), false);
  assert.equal(store.verifyDriver('a', undefined), false);
  assert.equal(store.verifyDriver('zzz', '1111'), false);
});

test('lista publică de mașini nu conține PIN-uri', () => {
  const { store } = setup();
  for (const car of [...store.carDirectory(), ...store.listCars()]) {
    assert.equal('pin' in car, false);
  }
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
  for (let i = 0; i < 50; i++) {
    clock.advance(1000);
    store.updateLocation('a', { lat: 44.4 + i * 0.001, lng: 26.1 });
  }
  const [car] = store.listCars();
  assert.equal(car.trail.length, 30);
  assert.deepEqual(car.trail[29], [44.4 + 49 * 0.001, 26.1]);
});

test('cursa se poate trimite doar la o mașină liberă', () => {
  const { store } = setup();
  assert.match(newRide(store).error, /nu este liberă/);

  store.driverConnected('a');
  const result = newRide(store);
  assert.equal(result.ok, true);
  assert.equal(result.ride.status, 'assigned');
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
  assert.equal(store.createRide(null).ok, false);
  assert.equal(newRide(store, { customerName: 'x'.repeat(500) }).ride.customerName.length, 80);
});

test('șoferul conduce cursa până la final, iar mașina redevine liberă', () => {
  const { store } = setup();
  store.driverConnected('a');
  store.driverConnected('b');
  const { ride } = newRide(store);
  const driver = { role: 'driver', carId: 'a' };

  assert.equal(store.updateRideStatus(ride.id, 'arrived', { role: 'driver', carId: 'b' }).ok, false);
  assert.equal(store.updateRideStatus(ride.id, 'cancelled', driver).ok, false);
  assert.equal(store.updateRideStatus(ride.id, 'bogus', driver).ok, false);

  assert.equal(store.updateRideStatus(ride.id, 'arrived', driver).ok, true);
  assert.equal(store.updateRideStatus(ride.id, 'in_progress', driver).ok, true);
  assert.equal(store.updateRideStatus(ride.id, 'arrived', driver).ok, false);
  assert.equal(store.updateRideStatus(ride.id, 'completed', driver).ok, true);
  assert.equal(store.updateRideStatus(ride.id, 'cancelled', { role: 'dispatcher' }).ok, false);

  assert.deepEqual(Object.keys(ride.statusTimes), ['assigned', 'arrived', 'in_progress', 'completed']);
  const car = store.getCarView('a');
  assert.equal(car.status, 'free');
  assert.equal(car.rideId, null);
});

test('anularea unei curse pentru o mașină deconectată o lasă deconectată', () => {
  const { store } = setup();
  store.driverConnected('a');
  const { ride } = newRide(store);
  store.driverDisconnected('a');
  assert.equal(store.updateRideStatus(ride.id, 'cancelled', { role: 'dispatcher' }).ok, true);
  assert.equal(store.getCarView('a').status, 'offline');
  // La reconectare e liberă, fiindcă nu mai are cursă.
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

  store.updateRideStatus(ride.id, 'arrived', { role: 'dispatcher' });
  assert.equal(store.trackingView(ride).etaMin, null);

  store.updateRideStatus(ride.id, 'completed', { role: 'dispatcher' });
  clock.advance(1000);
  store.updateLocation('a', { lat: 44.5, lng: 26.2 });
  // După încheierea cursei clientul nu mai vede unde e mașina.
  assert.equal(store.trackingView(ride).car.position, null);
});

test('cursele încheiate de peste 24h sunt șterse', () => {
  const { store, clock } = setup();
  store.driverConnected('a');
  const { ride } = newRide(store);
  store.updateRideStatus(ride.id, 'completed', { role: 'dispatcher' });
  clock.advance(25 * 60 * 60 * 1000);
  newRide(store);
  assert.equal(store.getRide(ride.id), null);
  assert.equal(store.getRideByToken(ride.token), null);
  assert.equal(store.listRides().length, 1);
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
    ['car', 'a', 'busy'],
    ['ride', '1', 'assigned'],
  ]);
});
