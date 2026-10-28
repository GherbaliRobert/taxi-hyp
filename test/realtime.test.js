// Test cap-coadă: server real + clienți Socket.IO pentru dispecerat, șofer și client.
const test = require('node:test');
const assert = require('node:assert/strict');
const { io: connectClient } = require('socket.io-client');
const { createApp } = require('../src/app');

const CONFIG = {
  companyName: 'Test Taxi',
  dispatcherPassword: 'secret',
  databaseFile: ':memory:',
  seedCars: [
    { id: 'a', plate: 'B 01 AAA', model: 'Logan', driver: 'Ion Popescu', pin: '1111' },
    { id: 'b', plate: 'B 02 BBB', model: 'Octavia', driver: 'Maria Ionescu', pin: '2222' },
  ],
  mapCenter: [44.4268, 26.1025],
  mapZoom: 13,
  geocodeCountry: 'ro',
  avgSpeedKmh: 25,
  trustProxy: false,
  routeRetentionDays: 180,
};

let server;
let baseUrl;
const sockets = [];

test.before(async () => {
  server = createApp(CONFIG);
  await new Promise((resolve) => server.httpServer.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`;
});

test.after(async () => {
  sockets.forEach((s) => s.disconnect());
  await server.close();
});

function client(auth) {
  const socket = connectClient(baseUrl, { auth, transports: ['websocket'], reconnection: false });
  sockets.push(socket);
  return socket;
}

/** Așteaptă evenimentul `event` care satisface `predicate` (implicit primul). */
function waitFor(socket, event, predicate = () => true, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`timeout așteptând "${event}"`));
    }, timeoutMs);
    function handler(payload) {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    }
    socket.on(event, handler);
  });
}

function connectError(auth) {
  const socket = client(auth);
  return waitFor(socket, 'connect_error').then((err) => err.message);
}

test('API-ul HTTP', async () => {
  const cars = await (await fetch(`${baseUrl}/api/cars`)).json();
  assert.deepEqual(cars, [
    { id: 'a', plate: 'B 01 AAA', model: 'Logan' },
    { id: 'b', plate: 'B 02 BBB', model: 'Octavia' },
  ]);
  const config = await (await fetch(`${baseUrl}/api/config`)).json();
  assert.equal(config.companyName, 'Test Taxi');
  assert.equal('dispatcherPassword' in config, false);

  for (const page of ['/', '/driver', '/track/oricare', '/vendor/leaflet/leaflet.js', '/shared/geo.js', '/js/common.js']) {
    const res = await fetch(baseUrl + page);
    assert.equal(res.status, 200, page);
  }
});

test('autentificarea respinge parola și PIN-ul greșite și linkurile necunoscute', async () => {
  assert.equal(await connectError({ role: 'dispatcher', password: 'gresit' }), 'unauthorized');
  assert.equal(await connectError({ role: 'driver', carId: 'a', pin: '9999' }), 'unauthorized');
  assert.equal(await connectError({ role: 'track', token: 'inexistent' }), 'not_found');
  assert.equal(await connectError({}), 'unauthorized');
});

test('fluxul complet: șofer → dispecerat → cursă → client', async () => {
  const dispatcher = client({ role: 'dispatcher', password: 'secret' });
  const snapshot = await waitFor(dispatcher, 'fleet:snapshot');
  assert.equal(snapshot.cars.length, 2);
  assert.ok(snapshot.cars.every((c) => c.status === 'offline' && !('pin' in c)));

  // Șoferul se conectează și apare liber în dispecerat.
  const freeUpdate = waitFor(dispatcher, 'car:update', (c) => c.id === 'a' && c.status === 'free');
  const driver = client({ role: 'driver', carId: 'a', pin: '1111' });
  const init = await waitFor(driver, 'driver:init');
  assert.equal(init.car.plate, 'B 01 AAA');
  assert.equal(init.ride, null);
  await freeUpdate;

  // Poziția trimisă de telefon ajunge în timp real la dispecerat.
  const moved = waitFor(dispatcher, 'car:update', (c) => c.id === 'a' && c.position);
  driver.emit('location', { lat: 44.42, lng: 26.1, speed: 10 });
  const carUpdate = await moved;
  assert.equal(carUpdate.position.lat, 44.42);

  // Dispeceratul trimite o cursă; șoferul o primește.
  const rideForDriver = waitFor(driver, 'ride:update', (r) => r.status === 'assigned');
  const created = await dispatcher.emitWithAck('ride:create', {
    customerName: 'Ana Pop',
    phone: '0722000000',
    address: 'Calea Victoriei 1',
    pickup: { lat: 44.43, lng: 26.1 },
    carId: 'a',
  });
  assert.equal(created.ok, true, created.error);
  assert.match(created.ride.trackPath, /^\/track\/[\w-]{20,}$/);
  const driverRide = await rideForDriver;
  assert.equal(driverRide.customerName, 'Ana Pop');
  assert.equal('trackPath' in driverRide, false);

  // A doua cursă pe aceeași mașină e refuzată.
  const second = await dispatcher.emitWithAck('ride:create', {
    customerName: 'Altcineva',
    pickup: { lat: 44.43, lng: 26.1 },
    carId: 'a',
  });
  assert.equal(second.ok, false);

  // Clientul deschide linkul și vede mașina apropiindu-se.
  const token = created.ride.trackPath.split('/').pop();
  const tracker = client({ role: 'track', token });
  const first = await waitFor(tracker, 'track:update');
  assert.equal(first.ride.status, 'assigned');
  assert.equal(first.car.plate, 'B 01 AAA');
  assert.ok(first.distanceM > 1000);
  assert.ok(!JSON.stringify(first).includes('0722000000'));

  await new Promise((r) => setTimeout(r, 550)); // peste limita de frecvență a actualizărilor
  const closer = waitFor(tracker, 'track:update', (v) => v.car.position && v.car.position.lat === 44.428);
  driver.emit('location', { lat: 44.428, lng: 26.1 });
  const second_ = await closer;
  assert.ok(second_.distanceM < first.distanceM);

  // Un alt client cu alt link nu primește actualizările acestei curse.
  const other = client({ role: 'track', token: 'x' });
  assert.equal((await waitFor(other, 'connect_error')).message, 'not_found');

  // Șoferul termină cursa; clientul vede finalul, mașina redevine liberă.
  assert.equal((await driver.emitWithAck('ride:status', { rideId: created.ride.id, status: 'cancelled' })).ok, false);
  for (const status of ['arrived', 'in_progress']) {
    const seen = waitFor(tracker, 'track:update', (v) => v.ride.status === status);
    assert.equal((await driver.emitWithAck('ride:status', { rideId: created.ride.id, status })).ok, true);
    await seen;
  }
  const done = waitFor(tracker, 'track:update', (v) => v.ride.status === 'completed');
  const freed = waitFor(dispatcher, 'car:update', (c) => c.id === 'a' && c.status === 'free');
  assert.equal((await driver.emitWithAck('ride:status', { rideId: created.ride.id, status: 'completed' })).ok, true);
  const final = await done;
  assert.equal(final.car.position, null);
  assert.equal((await freed).rideId, null);

  // Deconectarea șoferului apare în dispecerat.
  const offline = waitFor(dispatcher, 'car:update', (c) => c.id === 'a' && c.status === 'offline');
  driver.disconnect();
  await offline;
});

test('dispeceratul poate anula o cursă, iar șoferul este anunțat', async () => {
  const dispatcher = client({ role: 'dispatcher', password: 'secret' });
  await waitFor(dispatcher, 'fleet:snapshot');
  const driver = client({ role: 'driver', carId: 'b', pin: '2222' });
  await waitFor(driver, 'driver:init');

  const created = await dispatcher.emitWithAck('ride:create', {
    customerName: 'Dan',
    pickup: { lat: 44.44, lng: 26.11 },
    carId: 'b',
  });
  assert.equal(created.ok, true, created.error);

  const cancelled = waitFor(driver, 'ride:update', (r) => r.status === 'cancelled');
  assert.equal((await dispatcher.emitWithAck('ride:status', { rideId: created.ride.id, status: 'cancelled' })).ok, true);
  await cancelled;
  assert.equal(server.store.getCarView('b').status, 'free');
});

test('după prea multe încercări greșite, IP-ul este blocat temporar', async () => {
  const other = createApp(CONFIG);
  await new Promise((resolve) => other.httpServer.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${other.httpServer.address().port}`;
  const attempt = (auth) => {
    const socket = connectClient(url, { auth, transports: ['websocket'], reconnection: false });
    sockets.push(socket);
    return waitFor(socket, 'connect_error').then((err) => err.message);
  };
  try {
    for (let i = 0; i < 20; i++) {
      assert.equal(await attempt({ role: 'driver', carId: 'a', pin: String(i) }), 'unauthorized');
    }
    // Chiar și cu parola corectă, cererile sunt refuzate până expiră fereastra.
    assert.equal(await attempt({ role: 'dispatcher', password: 'secret' }), 'too_many_attempts');
  } finally {
    await other.close();
  }
});

function api(path, { method = 'GET', body, password = 'secret' } = {}) {
  return fetch(baseUrl + path, {
    method,
    headers: { authorization: `Bearer ${password}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (res) => ({ status: res.status, body: await res.json() }));
}

test('API-ul de istoric cere parola dispeceratului', async () => {
  assert.equal((await fetch(`${baseUrl}/api/rides`)).status, 401);
  assert.equal((await api('/api/rides', { password: 'gresit' })).status, 401);
  assert.equal((await api('/api/fleet', { password: '' })).status, 401);
});

test('istoricul conține cursele, statisticile și traseul', async () => {
  const { status, body } = await api('/api/rides?limit=10');
  assert.equal(status, 200);
  assert.ok(body.total >= 2);
  assert.equal(body.stats.total, body.total);
  const completed = body.rides.find((r) => r.status === 'completed');
  assert.equal(completed.customerName, 'Ana Pop');
  assert.equal(completed.carPlate, 'B 01 AAA');
  assert.equal(completed.driverName, 'Ion Popescu');

  const filtered = await api('/api/rides?status=cancelled&carId=b');
  assert.deepEqual(filtered.body.rides.map((r) => r.customerName), ['Dan']);
  assert.equal((await api('/api/rides?q=nimeni')).body.total, 0);

  const route = await api(`/api/rides/${completed.id}/route`);
  assert.equal(route.status, 200);
  assert.equal(route.body.ride.id, completed.id);
  assert.ok(route.body.points.length >= 2);
  assert.ok(route.body.points.some((p) => p.status === 'in_progress'));
  assert.equal((await api('/api/rides/999/route')).status, 404);
});

test('administrarea flotei: adăugare, PIN nou, dezactivare', async () => {
  const dispatcher = client({ role: 'dispatcher', password: 'secret' });
  await waitFor(dispatcher, 'fleet:snapshot');

  const invalid = await api('/api/fleet', { method: 'POST', body: { plate: 'B 01 AAA', driver: 'X', pin: '1234' } });
  assert.equal(invalid.status, 400);
  assert.match(invalid.body.error, /Există deja/);

  const created = await api('/api/fleet', { method: 'POST', body: { plate: 'B 77 NEW', model: 'Spring', driver: 'Radu Ene', pin: '7777' } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.car.id;
  assert.equal('pin' in created.body.car, false);
  assert.ok((await (await fetch(`${baseUrl}/api/cars`)).json()).some((c) => c.id === id));

  // Șoferul noii mașini se poate conecta imediat.
  const driver = client({ role: 'driver', carId: id, pin: '7777' });
  await waitFor(driver, 'driver:init');

  // PIN nou: sesiunea deschisă este închisă, iar PIN-ul vechi nu mai merge.
  const kicked = waitFor(driver, 'disconnect');
  const changed = await api(`/api/fleet/${id}`, { method: 'PUT', body: { plate: 'B 77 NEW', model: 'Spring', driver: 'Radu Ene', pin: '8888' } });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  assert.equal(await kicked, 'io server disconnect');
  assert.equal(await connectError({ role: 'driver', carId: id, pin: '7777' }), 'unauthorized');

  // Dezactivare: dispare din dispecerat și din lista de autentificare.
  const removed = waitFor(dispatcher, 'car:update', (c) => c.id === id && c.active === false);
  const off = await api(`/api/fleet/${id}`, { method: 'PUT', body: { active: false } });
  assert.equal(off.status, 200, JSON.stringify(off.body));
  assert.equal(off.body.car.active, false);
  await removed;
  assert.ok(!(await (await fetch(`${baseUrl}/api/cars`)).json()).some((c) => c.id === id));
  assert.ok((await api('/api/fleet')).body.some((c) => c.id === id && !c.active));

  assert.equal((await api('/api/fleet/nu-exista', { method: 'PUT', body: { active: true } })).status, 404);
});
