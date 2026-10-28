// Test cap-coadă: server real + clienți Socket.IO și HTTP pentru dispecerat, șofer și client.
const test = require('node:test');
const assert = require('node:assert/strict');
const { io: connectClient } = require('socket.io-client');
const { createApp } = require('../src/app');

const CONFIG = {
  companyName: 'Test Taxi',
  adminPassword: 'admin-secret',
  adminPasswordIsDefault: false,
  sessionIdleHours: 12,
  timeZone: 'Europe/Bucharest',
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
  publicUrl: 'https://taxi.test',
  offerTimeoutSeconds: 60,
  sms: { provider: 'console', countryCode: '40' },
  smsTransport: { log: (line) => smsLog.push(line) },
};
const smsLog = [];

let server;
let baseUrl;
let adminCookie;
let mariaCookie;
const sockets = [];

function api(path, { method = 'GET', body, cookie, origin } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (cookie) headers.cookie = cookie;
  if (origin) headers.origin = origin;
  return fetch(baseUrl + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }).then(
    async (res) => ({ status: res.status, body: await res.json().catch(() => null), setCookie: res.headers.get('set-cookie') })
  );
}

async function login(username, password) {
  const res = await api('/api/login', { method: 'POST', body: { username, password } });
  return { ...res, cookie: res.setCookie ? res.setCookie.split(';')[0] : null };
}

function client(auth, headers) {
  const socket = connectClient(baseUrl, { auth, extraHeaders: headers, transports: ['websocket'], reconnection: false });
  sockets.push(socket);
  return socket;
}

const dispatcherClient = (cookie, headers) => client({ role: 'dispatcher' }, { cookie, ...headers });

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

function connectError(auth, headers) {
  return waitFor(client(auth, headers), 'connect_error').then((err) => err.message);
}

test.before(async () => {
  server = createApp(CONFIG);
  await new Promise((resolve) => server.httpServer.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`;

  adminCookie = (await login('admin', 'admin-secret')).cookie;
  // Dispecera Maria primește o parolă temporară și o schimbă la prima autentificare.
  const created = await api('/api/users', { method: 'POST', cookie: adminCookie, body: { name: 'Maria Ionescu', username: 'maria', role: 'dispatcher' } });
  mariaCookie = (await login('maria', created.body.temporaryPassword)).cookie;
  await api('/api/me/password', { method: 'POST', cookie: mariaCookie, body: { currentPassword: created.body.temporaryPassword, newPassword: 'parola-maria' } });
});

test.after(async () => {
  sockets.forEach((s) => s.disconnect());
  await server.close();
});

test('paginile și API-ul public', async () => {
  const cars = await (await fetch(`${baseUrl}/api/cars`)).json();
  assert.deepEqual(cars, [
    { id: 'a', plate: 'B 01 AAA', model: 'Logan' },
    { id: 'b', plate: 'B 02 BBB', model: 'Octavia' },
  ]);
  const config = await (await fetch(`${baseUrl}/api/config`)).json();
  assert.equal(config.companyName, 'Test Taxi');
  assert.ok(!JSON.stringify(config).includes('secret'));
  assert.equal(config.voice, null); // asistentul vocal e opțional

  for (const page of ['/', '/driver', '/history', '/fleet', '/users', '/audit', '/track/oricare', '/vendor/leaflet/leaflet.js', '/js/common.js']) {
    const res = await fetch(baseUrl + page);
    assert.equal(res.status, 200, page);
  }
  assert.equal((await fetch(baseUrl + '/')).headers.get('x-frame-options'), 'DENY');
});

test('autentificarea cu utilizator și parolă', async () => {
  const wrong = await login('admin', 'gresit');
  assert.equal(wrong.status, 401);
  assert.equal(wrong.cookie, null);

  const ok = await login('maria', 'parola-maria');
  assert.equal(ok.status, 200);
  assert.equal(ok.body.user.name, 'Maria Ionescu');
  assert.ok(!JSON.stringify(ok.body).includes('scrypt'));
  // Cookie-ul de sesiune nu e accesibil din JavaScript și nu pleacă spre alte site-uri.
  assert.match(ok.setCookie, /^taxi_session=[\w-]{40,}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=\d+$/);
  assert.equal((await api('/api/me', { cookie: ok.cookie })).body.user.username, 'maria');

  assert.equal((await api('/api/me')).status, 401);
  assert.equal((await api('/api/rides', { cookie: 'taxi_session=fals' })).status, 401);
  assert.equal(await connectError({ role: 'dispatcher' }), 'unauthorized');
  assert.equal(await connectError({ role: 'dispatcher' }, { cookie: 'taxi_session=fals' }), 'unauthorized');
  assert.equal(await connectError({ role: 'driver', carId: 'a', pin: '9999' }), 'unauthorized');
  assert.equal(await connectError({ role: 'track', token: 'inexistent' }), 'not_found');
});

test('cu parola temporară nu se poate lucra până nu e schimbată', async () => {
  const created = await api('/api/users', { method: 'POST', cookie: adminCookie, body: { name: 'Dan Stoica', username: 'dan', role: 'dispatcher' } });
  assert.equal(created.status, 201);
  const session = await login('dan', created.body.temporaryPassword);
  assert.equal(session.body.user.mustChangePassword, true);

  const blocked = await api('/api/rides', { cookie: session.cookie });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.code, 'password_change_required');
  assert.equal(await connectError({ role: 'dispatcher' }, { cookie: session.cookie }), 'password_change_required');

  const changed = await api('/api/me/password', {
    method: 'POST',
    cookie: session.cookie,
    body: { currentPassword: created.body.temporaryPassword, newPassword: 'parola-dan-1' },
  });
  assert.equal(changed.status, 200);
  assert.equal((await api('/api/rides', { cookie: session.cookie })).status, 200);
});

test('drepturile dispecerului și ale administratorului', async () => {
  assert.equal((await api('/api/fleet', { cookie: mariaCookie })).status, 200);
  assert.equal((await api('/api/rides', { cookie: mariaCookie })).status, 200);
  for (const [path, method] of [
    ['/api/fleet', 'POST'],
    ['/api/fleet/a', 'PUT'],
    ['/api/users', 'GET'],
    ['/api/users', 'POST'],
    ['/api/audit', 'GET'],
  ]) {
    const res = await api(path, { method, cookie: mariaCookie, body: method === 'GET' ? undefined : {} });
    assert.equal(res.status, 403, `${method} ${path}`);
  }
  assert.equal((await api('/api/users', { cookie: adminCookie })).status, 200);
  assert.equal((await api('/api/audit', { cookie: adminCookie })).status, 200);
  assert.equal((await api('/api/nu-exista', { cookie: adminCookie })).status, 404);
});

test('cererile venite de pe alte site-uri sunt respinse', async () => {
  const evil = 'http://site-strain.example';
  assert.equal((await api('/api/login', { method: 'POST', origin: evil, body: { username: 'admin', password: 'admin-secret' } })).status, 403);
  assert.equal((await api('/api/users', { method: 'POST', cookie: adminCookie, origin: evil, body: { name: 'X', username: 'xyz', role: 'admin' } })).status, 403);
  assert.equal(await connectError({ role: 'dispatcher' }, { cookie: mariaCookie, origin: evil }), 'unauthorized');
  // Din pagina aplicației (aceeași origine) merge.
  const same = await api('/api/me', { cookie: mariaCookie, origin: baseUrl });
  assert.equal(same.status, 200);
});

test('fluxul complet: comanda → șoferii o acceptă sau o refuză → SMS → linkul clientului', async () => {
  const dispatcher = dispatcherClient(mariaCookie);
  const snapshot = await waitFor(dispatcher, 'fleet:snapshot');
  assert.equal(snapshot.user.name, 'Maria Ionescu');
  assert.equal(snapshot.cars.length, 2);
  assert.ok(snapshot.cars.every((c) => c.status === 'offline' && !('pin' in c) && !('pinHash' in c)));

  // Doi șoferi în tură; pozițiile lor ajung live în dispecerat.
  const driverA = client({ role: 'driver', carId: 'a', pin: '1111' });
  const driverB = client({ role: 'driver', carId: 'b', pin: '2222' });
  const initA = await waitFor(driverA, 'driver:init');
  await waitFor(driverB, 'driver:init');
  assert.deepEqual(initA.offers, []);
  const moved = waitFor(dispatcher, 'car:update', (c) => c.id === 'a' && c.position);
  driverA.emit('location', { lat: 44.42, lng: 26.1, speed: 10 });
  driverB.emit('location', { lat: 44.40, lng: 26.1 });
  assert.equal((await moved).position.lat, 44.42);

  // 1. Clientul sună; dispecerul introduce comanda, care ajunge la toate mașinile libere.
  const offerA = waitFor(driverA, 'offer:new');
  const offerB = waitFor(driverB, 'offer:new');
  const created = await dispatcher.emitWithAck('ride:create', {
    customerName: 'Ana Pop',
    phone: '0722 000 000',
    address: 'Calea Victoriei 1',
    pickup: { lat: 44.43, lng: 26.1 },
    target: { mode: 'all' },
  });
  assert.equal(created.ok, true, created.error);
  assert.equal(created.ride.status, 'pending');
  assert.equal(created.ride.createdByName, 'Maria Ionescu');
  assert.deepEqual(created.offeredTo.sort(), ['a', 'b']);
  const [seenA, seenB] = await Promise.all([offerA, offerB]);
  assert.equal(seenA.rideId, created.ride.id);
  assert.equal(seenA.address, 'Calea Victoriei 1');
  assert.ok(seenA.distanceM < seenB.distanceM); // a e mai aproape de client
  assert.ok(!/Ana|0722/.test(JSON.stringify(seenA))); // datele clientului apar doar după acceptare

  // Până acceptă cineva, linkul clientului nu funcționează și nu pleacă niciun SMS.
  const token = created.ride.trackPath.split('/').pop();
  assert.equal(await connectError({ role: 'track', token }), 'not_found');

  // 2. Șoferul B refuză; dispecerul vede refuzul.
  const declined = waitFor(dispatcher, 'ride:update', (r) => r.id === created.ride.id && r.offers.some((o) => o.response === 'declined'));
  assert.equal((await driverB.emitWithAck('offer:decline', { rideId: created.ride.id })).ok, true);
  assert.equal((await declined).offers.find((o) => o.carId === 'b').response, 'declined');

  // 3. Șoferul A acceptă: primește cursa, cu datele clientului.
  const assigned = waitFor(dispatcher, 'ride:update', (r) => r.id === created.ride.id && r.status === 'assigned');
  const smsDone = waitFor(dispatcher, 'ride:update', (r) => r.id === created.ride.id && r.sms.status === 'simulated');
  const accepted = await driverA.emitWithAck('offer:accept', { rideId: created.ride.id });
  assert.equal(accepted.ok, true, accepted.error);
  assert.equal(accepted.ride.customerName, 'Ana Pop');
  assert.equal(accepted.ride.phone, '0722 000 000');
  assert.equal((await assigned).carPlate, 'B 01 AAA');

  // 4. Clientul primește automat SMS cu linkul, mașina, șoferul și timpul estimat.
  const smsRide = await smsDone;
  assert.equal(smsRide.sms.detail, '+40722000000');
  const smsText = smsLog.find((line) => line.includes(token));
  assert.ok(smsText, smsLog.join('\n'));
  assert.match(smsText, /^\[sms simulat\] către \+40722000000: Test Taxi: Taxiul B 01 AAA \(Logan, sofer Ion\) vine spre dvs\., ajunge in cca \d+ min\. Urmariti-l: https:\/\/taxi\.test\/track\//);

  // 5. Linkul arată harta, mașina, șoferul și timpul estimat.
  const tracker = client({ role: 'track', token });
  const first = await waitFor(tracker, 'track:update');
  assert.equal(first.ride.status, 'assigned');
  assert.deepEqual([first.car.plate, first.car.model, first.car.driverFirstName], ['B 01 AAA', 'Logan', 'Ion']);
  assert.ok(first.distanceM > 1000 && first.etaMin >= 1);
  assert.ok(!/0722|Ana Pop/.test(JSON.stringify(first)));

  await new Promise((r) => setTimeout(r, 550)); // peste limita de frecvență a actualizărilor
  const closer = waitFor(tracker, 'track:update', (v) => v.car && v.car.position && v.car.position.lat === 44.428);
  driverA.emit('location', { lat: 44.428, lng: 26.1 });
  assert.ok((await closer).distanceM < first.distanceM);

  // 6. Cursa se încheie: linkul dispare (pagina deschisă e închisă, linkul nu mai funcționează).
  assert.equal((await driverA.emitWithAck('ride:status', { rideId: created.ride.id, status: 'cancelled' })).ok, false);
  for (const status of ['arrived', 'in_progress']) {
    const seen = waitFor(tracker, 'track:update', (v) => v.ride.status === status);
    assert.equal((await driverA.emitWithAck('ride:status', { rideId: created.ride.id, status })).ok, true);
    await seen;
  }
  const done = waitFor(tracker, 'track:update', (v) => v.ride.status === 'completed');
  const closed = waitFor(tracker, 'disconnect');
  const freed = waitFor(dispatcher, 'car:update', (c) => c.id === 'a' && c.status === 'free');
  assert.equal((await driverA.emitWithAck('ride:status', { rideId: created.ride.id, status: 'completed' })).ok, true);
  assert.deepEqual(await done, { ride: { status: 'completed' }, car: null, distanceM: null, etaMin: null });
  assert.equal(await closed, 'io server disconnect');
  assert.equal(await connectError({ role: 'track', token }), 'not_found');
  assert.equal((await freed).rideId, null);

  const offline = waitFor(dispatcher, 'car:update', (c) => c.id === 'a' && c.status === 'offline');
  driverA.disconnect();
  driverB.disconnect();
  await offline;
});

test('dispecerul poate anula o cursă, iar șoferul este anunțat', async () => {
  const dispatcher = dispatcherClient(mariaCookie);
  await waitFor(dispatcher, 'fleet:snapshot');
  const driver = client({ role: 'driver', carId: 'b', pin: '2222' });
  await waitFor(driver, 'driver:init');

  // Comandă trimisă direct unei mașini (o alege dispecerul); fără telefon nu se trimite SMS.
  const offered = waitFor(driver, 'offer:new');
  const created = await dispatcher.emitWithAck('ride:create', { customerName: 'Dan', pickup: { lat: 44.44, lng: 26.11 }, target: { mode: 'car', carId: 'b' } });
  assert.equal(created.ok, true, created.error);
  assert.deepEqual(created.offeredTo, ['b']);
  await offered;
  const noPhone = waitFor(dispatcher, 'ride:update', (r) => r.id === created.ride.id && r.sms.status === 'no_phone');
  assert.equal((await driver.emitWithAck('offer:accept', { rideId: created.ride.id })).ok, true);
  await noPhone;

  const cancelled = waitFor(driver, 'ride:update', (r) => r.status === 'cancelled');
  assert.equal((await dispatcher.emitWithAck('ride:status', { rideId: created.ride.id, status: 'cancelled' })).ok, true);
  await cancelled;
  assert.equal(server.store.getCarView('b').status, 'free');
  assert.equal(server.store.getRide(created.ride.id).closedByName, 'Maria Ionescu');
  driver.disconnect();
});

test('istoricul conține cursele, statisticile și traseul', async () => {
  const { status, body } = await api('/api/rides?limit=10', { cookie: mariaCookie });
  assert.equal(status, 200);
  assert.equal(body.total, 2);
  assert.equal(body.stats.total, 2);
  assert.deepEqual(body.stats.byDispatcher.map((d) => [d.name, d.total]), [['Maria Ionescu', 2]]);
  const completed = body.rides.find((r) => r.status === 'completed');
  assert.equal(completed.customerName, 'Ana Pop');
  assert.equal(completed.driverName, 'Ion Popescu');
  assert.equal(completed.createdByName, 'Maria Ionescu');
  assert.equal(completed.closedByName, 'Șofer');

  const filtered = await api('/api/rides?status=cancelled&carId=b', { cookie: mariaCookie });
  assert.deepEqual(filtered.body.rides.map((r) => [r.customerName, r.closedByName]), [['Dan', 'Maria Ionescu']]);
  assert.equal((await api('/api/rides?q=nimeni', { cookie: mariaCookie })).body.total, 0);

  const route = await api(`/api/rides/${completed.id}/route`, { cookie: mariaCookie });
  assert.equal(route.status, 200);
  assert.ok(route.body.points.some((p) => p.status === 'in_progress'));
  assert.equal((await api('/api/rides/999/route', { cookie: mariaCookie })).status, 404);

  const from = Date.now() - 86400000;
  const exported = await api(`/api/rides?export=1&limit=10000&from=${from}&to=${from + 2 * 86400000}`, { cookie: mariaCookie });
  assert.equal(exported.status, 200);
});

test('administrarea flotei: adăugare, PIN nou, dezactivare', async () => {
  const dispatcher = dispatcherClient(mariaCookie);
  await waitFor(dispatcher, 'fleet:snapshot');

  const invalid = await api('/api/fleet', { method: 'POST', cookie: adminCookie, body: { plate: 'B 01 AAA', driver: 'X', pin: '1234' } });
  assert.equal(invalid.status, 400);
  assert.match(invalid.body.error, /Există deja/);

  const created = await api('/api/fleet', { method: 'POST', cookie: adminCookie, body: { plate: 'B 77 NEW', model: 'Spring', driver: 'Radu Ene', pin: '7777' } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.car.id;
  assert.ok((await (await fetch(`${baseUrl}/api/cars`)).json()).some((c) => c.id === id));

  const driver = client({ role: 'driver', carId: id, pin: '7777' });
  await waitFor(driver, 'driver:init');

  // PIN nou: sesiunea deschisă este închisă, iar PIN-ul vechi nu mai merge.
  const kicked = waitFor(driver, 'disconnect');
  const changed = await api(`/api/fleet/${id}`, { method: 'PUT', cookie: adminCookie, body: { plate: 'B 77 NEW', model: 'Spring', driver: 'Radu Ene', pin: '8888' } });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  assert.equal(await kicked, 'io server disconnect');
  assert.equal(await connectError({ role: 'driver', carId: id, pin: '7777' }), 'unauthorized');

  // Dezactivare: dispare din dispecerat și din lista de autentificare.
  const removed = waitFor(dispatcher, 'car:update', (c) => c.id === id && c.active === false);
  const off = await api(`/api/fleet/${id}`, { method: 'PUT', cookie: adminCookie, body: { active: false } });
  assert.equal(off.status, 200, JSON.stringify(off.body));
  await removed;
  assert.ok(!(await (await fetch(`${baseUrl}/api/cars`)).json()).some((c) => c.id === id));
  assert.equal((await api('/api/fleet/nu-exista', { method: 'PUT', cookie: adminCookie, body: { active: true } })).status, 404);
});

test('administrarea utilizatorilor: resetare parolă și dezactivare deconectează imediat', async () => {
  const created = await api('/api/users', { method: 'POST', cookie: adminCookie, body: { name: 'Ion Vasile', username: 'ion', role: 'dispatcher' } });
  const id = created.body.user.id;
  const first = await login('ion', created.body.temporaryPassword);
  await api('/api/me/password', { method: 'POST', cookie: first.cookie, body: { currentPassword: created.body.temporaryPassword, newPassword: 'parola-ion-1' } });
  const socket = dispatcherClient(first.cookie);
  await waitFor(socket, 'fleet:snapshot');

  // Resetarea parolei închide conexiunea live și sesiunea.
  const kicked = waitFor(socket, 'disconnect');
  const reset = await api(`/api/users/${id}/reset-password`, { method: 'POST', cookie: adminCookie });
  assert.equal(reset.status, 200);
  assert.equal(await kicked, 'io server disconnect');
  assert.equal((await api('/api/me', { cookie: first.cookie })).status, 401);

  // Modificare: rol și nume (utilizatorul rămâne același).
  const updated = await api(`/api/users/${id}`, { method: 'PUT', cookie: adminCookie, body: { name: 'Ion V.', role: 'admin' } });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  assert.equal(updated.body.user.role, 'admin');
  assert.equal(updated.body.user.username, 'ion');

  // Dezactivare: nu se mai poate autentifica.
  const again = await login('ion', reset.body.temporaryPassword);
  assert.equal(again.status, 200);
  assert.equal((await api(`/api/users/${id}`, { method: 'PUT', cookie: adminCookie, body: { active: false } })).status, 200);
  assert.equal((await api('/api/me', { cookie: again.cookie })).status, 401);
  assert.equal((await login('ion', reset.body.temporaryPassword)).status, 401);

  // Administratorul nu se poate dezactiva singur.
  const me = (await api('/api/me', { cookie: adminCookie })).body.user;
  assert.equal((await api(`/api/users/${me.id}`, { method: 'PUT', cookie: adminCookie, body: { active: false } })).status, 400);
  assert.equal((await api('/api/users/999', { method: 'PUT', cookie: adminCookie, body: { active: false } })).status, 404);
});

test('ieșirea închide sesiunea și conexiunea live', async () => {
  const session = await login('maria', 'parola-maria');
  const socket = dispatcherClient(session.cookie);
  await waitFor(socket, 'fleet:snapshot');
  const other = dispatcherClient(mariaCookie);
  await waitFor(other, 'fleet:snapshot');

  const kicked = waitFor(socket, 'disconnect');
  const out = await api('/api/logout', { method: 'POST', cookie: session.cookie });
  assert.equal(out.status, 200);
  assert.match(out.setCookie, /^taxi_session=; .*Max-Age=0/);
  assert.equal(await kicked, 'io server disconnect');
  assert.equal((await api('/api/me', { cookie: session.cookie })).status, 401);
  // Cealaltă sesiune a Mariei (alt calculator) rămâne conectată.
  assert.equal(other.connected, true);
  assert.equal((await api('/api/me', { cookie: mariaCookie })).status, 200);
});

test('jurnalul arată cine ce a făcut', async () => {
  const { status, body } = await api('/api/audit?limit=500', { cookie: adminCookie });
  assert.equal(status, 200);
  const entries = body.entries;
  // Există o intrare cu acțiunea, utilizatorul și (opțional) rezumatul dat?
  const has = (action, user, summary) =>
    entries.some((e) => e.action === action && (user === null || e.userName === user) && (!summary || summary.test(e.summary)));

  assert.ok(has('auth_login_failed', '', /^utilizator „admin”$/));
  assert.ok(has('auth_login_failed', '', /^utilizator „ion”$/));
  assert.ok(has('auth_login', 'Maria Ionescu'));
  assert.ok(has('auth_password_change', 'Maria Ionescu'));
  assert.ok(has('auth_logout', 'Maria Ionescu'));
  assert.ok(has('user_create', 'Administrator', /^Maria Ionescu \(maria\), dispecer$/));
  assert.ok(has('ride_create', 'Maria Ionescu', /^Cursa #1 · Ana Pop · trimisă la 2 mașini$/));
  assert.ok(has('ride_cancel', 'Maria Ionescu', /^Cursa #2 · Dan · B 02 BBB$/));
  assert.ok(has('car_create', 'Administrator', /^B 77 NEW · Radu Ene$/));
  assert.ok(has('car_update', 'Administrator', /^B 77 NEW: PIN nou$/));
  assert.ok(has('car_deactivate', 'Administrator', /^B 77 NEW · Radu Ene$/));
  assert.ok(has('history_export', 'Maria Ionescu', /^2 curse · \d\d\.\d\d\.\d{4} – \d\d\.\d\d\.\d{4}$/));
  assert.ok(has('user_password_reset', 'Administrator', /^Ion Vasile \(ion\)$/));
  assert.ok(has('user_update', 'Administrator', /^Ion Vasile: nume: Ion Vasile → Ion V\.; rol: dispecer → administrator$/));
  assert.ok(has('user_deactivate', 'Administrator', /^Ion V\. \(ion\)$/));
  assert.ok(entries.filter((e) => e.action === 'auth_login_failed').every((e) => e.userId === null));
  assert.ok(entries.every((e) => e.ip));
  // Cele mai noi primele.
  assert.ok(entries.every((e, i) => i === 0 || e.ts <= entries[i - 1].ts));

  const rides = await api('/api/audit?category=ride', { cookie: adminCookie });
  assert.ok(rides.body.entries.length >= 2 && rides.body.entries.every((e) => e.action.startsWith('ride_')));
  const maria = entries.find((e) => e.action === 'auth_login' && e.userName === 'Maria Ionescu').userId;
  const mine = await api(`/api/audit?userId=${maria}`, { cookie: adminCookie });
  assert.ok(mine.body.entries.length > 0 && mine.body.entries.every((e) => e.userId === maria));
  assert.equal((await api(`/api/audit?from=${Date.now() + 60000}`, { cookie: adminCookie })).body.total, 0);
});

function driverApi(path, { method = 'POST', body, token } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  return fetch(baseUrl + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }).then(
    async (res) => ({ status: res.status, body: await res.json().catch(() => null) })
  );
}

test('aplicația șoferului: token, poziție prin HTTP și cursa în răspuns', async () => {
  assert.equal((await driverApi('/api/driver/login', { body: { carId: 'b', pin: '0000' } })).status, 401);
  assert.equal((await driverApi('/api/driver/location', { body: { lat: 44.4, lng: 26.1 } })).status, 401);
  assert.equal((await driverApi('/api/driver/location', { token: 'fals', body: { lat: 44.4, lng: 26.1 } })).status, 401);

  const login = await driverApi('/api/driver/login', { body: { carId: 'b', pin: '2222', device: 'test' } });
  assert.equal(login.status, 200);
  assert.equal(login.body.car.plate, 'B 02 BBB');
  const { token } = login.body;

  // Prima poziție trimisă prin HTTP face mașina „liberă” în dispecerat, fără WebSocket.
  const dispatcher = dispatcherClient(mariaCookie);
  await waitFor(dispatcher, 'fleet:snapshot');
  const online = waitFor(dispatcher, 'car:update', (c) => c.id === 'b' && c.status === 'free' && c.position && c.position.lat === 44.41);
  const first = await driverApi('/api/driver/location', { token, body: { lat: 44.41, lng: 26.1, accuracy: 8, speed: 0 } });
  assert.equal(first.status, 200);
  // Fără cursă activă (poate apărea doar ultima cursă, anulată în testul anterior).
  assert.equal(first.body.car.rideId, null);
  assert.ok(first.body.ride === null || first.body.ride.status === 'cancelled');
  assert.equal(first.body.car.status, 'free');
  await online;
  assert.equal((await driverApi('/api/driver/location', { token, body: { lat: 999, lng: 0 } })).status, 400);

  // Dispecerul trimite o comandă; aplicația o află din răspunsul următor (chiar fiind în fundal).
  const created = await dispatcher.emitWithAck('ride:create', { customerName: 'Elena', phone: '0733', pickup: { lat: 44.42, lng: 26.1 }, target: { mode: 'car', carId: 'b' } });
  assert.equal(created.ok, true, created.error);
  await new Promise((r) => setTimeout(r, 550));
  const next = await driverApi('/api/driver/location', { token, body: { lat: 44.412, lng: 26.1 } });
  assert.equal(next.body.car.rideId, null);
  assert.deepEqual(next.body.offers.map((o) => o.rideId), [created.ride.id]);
  assert.equal(next.body.offers[0].address, '');
  assert.ok(next.body.offers[0].expiresAt > Date.now());
  assert.ok(!JSON.stringify(next.body.offers).includes('Elena'));

  // Acceptarea prin HTTP (merge și când WebSocket-ul aplicației e întrerupt).
  const accept = await driverApi(`/api/driver/offers/${created.ride.id}/accept`, { token });
  assert.equal(accept.status, 200, JSON.stringify(accept.body));
  assert.equal(accept.body.ride.id, created.ride.id);
  assert.equal(accept.body.ride.status, 'assigned');
  assert.equal(accept.body.ride.customerName, 'Elena');
  assert.deepEqual(accept.body.offers, []);
  assert.equal('trackPath' in accept.body.ride, false);
  assert.equal((await driverApi('/api/driver/state', { method: 'GET', token })).body.ride.id, created.ride.id);
  assert.equal((await driverApi('/api/driver/offers/999/accept', { token })).status, 409);

  // Cu același token se conectează și WebSocket-ul (cursele live când aplicația e deschisă).
  const socket = client({ role: 'driver', token });
  const init = await waitFor(socket, 'driver:init');
  assert.equal(init.ride.id, created.ride.id);
  assert.equal((await socket.emitWithAck('ride:status', { rideId: created.ride.id, status: 'arrived' })).ok, true);
  // Statusul cursei se poate trimite și prin HTTP.
  const started = await driverApi(`/api/driver/rides/${created.ride.id}/status`, { token, body: { status: 'in_progress' } });
  assert.equal(started.body.ride.status, 'in_progress');
  assert.equal((await driverApi(`/api/driver/rides/${created.ride.id}/status`, { token, body: { status: 'cancelled' } })).status, 400);
  assert.equal(await connectError({ role: 'driver', token: 'fals' }), 'unauthorized');
  await dispatcher.emitWithAck('ride:status', { rideId: created.ride.id, status: 'cancelled' });
  // Din fundal (fără WebSocket), aplicația află anularea din răspunsul următor.
  await new Promise((r) => setTimeout(r, 550));
  const afterCancel = await driverApi('/api/driver/location', { token, body: { lat: 44.413, lng: 26.1 } });
  assert.deepEqual([afterCancel.body.ride.id, afterCancel.body.ride.status], [created.ride.id, 'cancelled']);
  assert.equal(afterCancel.body.car.rideId, null);
  assert.equal(afterCancel.body.car.gpsOk, true);

  // Fără GPS nu se lucrează: tura încheiată → dispecerul vede „fără GPS”, comenzile nu mai ajung la mașină.
  const noGps = waitFor(dispatcher, 'car:update', (c) => c.id === 'b' && c.gpsOk === false);
  const off = await driverApi('/api/driver/gps-off', { token });
  assert.equal(off.body.car.gpsOk, false);
  await noGps;
  const refused = await dispatcher.emitWithAck('ride:create', { customerName: 'Ion', pickup: { lat: 44.42, lng: 26.1 }, target: { mode: 'car', carId: 'b' } });
  assert.match(refused.error, /nu are GPS/);
  // O poziție veche retrimisă (telefon fără semnal) nu repornește GPS-ul; una nouă, da.
  await new Promise((r) => setTimeout(r, 550));
  const stale = await driverApi('/api/driver/location', { token, body: { lat: 44.414, lng: 26.1, age: 5 * 60 * 1000 } });
  assert.equal(stale.body.car.gpsOk, false);
  const fresh = await driverApi('/api/driver/location', { token, body: { lat: 44.414, lng: 26.1, age: 300 } });
  assert.equal(fresh.body.car.gpsOk, true);
  // Și prin WebSocket (pagina șoferului din browser).
  assert.equal((await socket.emitWithAck('gps:off', {})).ok, true);
  assert.equal((await driverApi('/api/driver/state', { method: 'GET', token })).body.car.gpsOk, false);

  // Ieșirea: tokenul nu mai e valid, mașina apare deconectată după închiderea WebSocket-ului.
  const offline = waitFor(dispatcher, 'car:update', (c) => c.id === 'b' && c.status === 'offline');
  assert.equal((await driverApi('/api/driver/logout', { token })).status, 200);
  socket.disconnect();
  await offline;
  assert.equal((await driverApi('/api/driver/location', { token, body: { lat: 44.41, lng: 26.1 } })).status, 401);
});

test('doi șoferi acceptă în același timp: doar primul primește cursa', async () => {
  const dispatcher = dispatcherClient(mariaCookie);
  await waitFor(dispatcher, 'fleet:snapshot');
  const a = client({ role: 'driver', carId: 'a', pin: '1111' });
  const b = client({ role: 'driver', carId: 'b', pin: '2222' });
  await Promise.all([waitFor(a, 'driver:init'), waitFor(b, 'driver:init')]);
  // Comenzile ajung doar la mașinile cu GPS.
  await Promise.all([a.emitWithAck('location', { lat: 44.421, lng: 26.1 }), b.emitWithAck('location', { lat: 44.422, lng: 26.1 })]);
  const offers = Promise.all([waitFor(a, 'offer:new'), waitFor(b, 'offer:new')]);
  const created = await dispatcher.emitWithAck('ride:create', { customerName: 'Ioana', pickup: { lat: 44.43, lng: 26.1 }, target: { mode: 'all' } });
  await offers;

  const gone = Promise.race([waitFor(a, 'offer:gone'), waitFor(b, 'offer:gone')]);
  const results = await Promise.all([a.emitWithAck('offer:accept', { rideId: created.ride.id }), b.emitWithAck('offer:accept', { rideId: created.ride.id })]);
  assert.deepEqual(results.map((r) => r.ok).sort(), [false, true]);
  assert.match(results.find((r) => !r.ok).error, /preluată de alt coleg/);
  assert.deepEqual(await gone, { rideId: created.ride.id, reason: 'taken' });

  // O comandă anulată înainte de acceptare dispare de pe telefoane.
  const second = await dispatcher.emitWithAck('ride:create', { customerName: 'Radu', pickup: { lat: 44.43, lng: 26.1 }, target: { mode: 'all' } });
  const winner = results[0].ok ? b : a; // mașina rămasă liberă
  const withdrawn = waitFor(winner, 'offer:gone', (g) => g.rideId === second.ride.id);
  await dispatcher.emitWithAck('ride:status', { rideId: second.ride.id, status: 'cancelled' });
  assert.equal((await withdrawn).reason, 'withdrawn');
  await dispatcher.emitWithAck('ride:status', { rideId: created.ride.id, status: 'cancelled' });
  a.disconnect();
  b.disconnect();
});

test('după prea multe încercări greșite, IP-ul este blocat temporar', async () => {
  const other = createApp(CONFIG);
  await new Promise((resolve) => other.httpServer.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${other.httpServer.address().port}`;
  const attempt = (password) =>
    fetch(url + '/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password }),
    }).then((r) => r.status);
  try {
    for (let i = 0; i < 20; i++) assert.equal(await attempt('gresit-' + i), 401);
    // Chiar și cu parola corectă, cererile sunt refuzate până expiră fereastra; la fel PIN-urile șoferilor.
    assert.equal(await attempt('admin-secret'), 429);
    const driver = connectClient(url, { auth: { role: 'driver', carId: 'a', pin: '1111' }, transports: ['websocket'], reconnection: false });
    sockets.push(driver);
    assert.equal((await waitFor(driver, 'connect_error')).message, 'too_many_attempts');
  } finally {
    await other.close();
  }
});
