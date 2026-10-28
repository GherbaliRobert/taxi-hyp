// Fluxul comenzii: dispecerul o trimite șoferilor, primul care acceptă o primește.
const test = require('node:test');
const assert = require('node:assert/strict');
const { FleetStore, importCars } = require('../src/store');
const { openDatabase, createRepository } = require('../src/db');

const CARS = [
  { id: 'a', plate: 'B 01 AAA', model: 'Logan', driver: 'Ion Popescu', pin: '1111' },
  { id: 'b', plate: 'B 02 BBB', model: 'Octavia', driver: 'Maria Ionescu', pin: '2222' },
  { id: 'c', plate: 'B 03 CCC', model: 'Corolla', driver: 'Dan Stan', pin: '3333' },
];
const PICKUP = { lat: 44.43, lng: 26.1 };
const OFFER_MS = 60 * 1000;

function setup() {
  let t = 1_700_000_000_000;
  const clock = { now: () => t, advance: (ms) => (t += ms) };
  const repo = createRepository(openDatabase(':memory:'));
  importCars(repo, CARS, t);
  const make = () => new FleetStore({ repo, now: clock.now, offerTimeoutMs: OFFER_MS });
  const store = make();
  // Trei mașini libere: a la ~1 km de client, b la ~3 km, c la ~5 km.
  for (const [id, lat] of [['a', 44.421], ['b', 44.403], ['c', 44.385]]) {
    store.driverConnected(id);
    store.updateLocation(id, { lat, lng: 26.1 });
  }
  const offers = [];
  store.on('offer', (o) => offers.push([o.carId, o.response]));
  return { store, clock, repo, offers, restart: make };
}

function order(store, target, extra) {
  return store.createOrder({ customerName: 'Ana Pop', phone: '0722 111 222', address: 'Calea Victoriei 1', pickup: PICKUP, target, ...extra }, { userId: null, name: 'Maria' });
}

test('comanda ajunge la mașinile libere, cele mai apropiate primele', () => {
  const { store } = setup();
  const all = order(store, { mode: 'all' });
  assert.equal(all.ok, true);
  assert.deepEqual(all.offeredTo, ['a', 'b', 'c']);
  assert.equal(all.ride.status, 'pending');
  assert.equal(all.ride.carId, null);

  // Mașinile rămân libere până acceptă cineva.
  assert.ok(['a', 'b', 'c'].every((id) => store.getCarView(id).status === 'free'));
  assert.deepEqual(order(store, { mode: 'nearest', count: 2 }).offeredTo, ['a', 'b']);
  assert.deepEqual(order(store, { mode: 'car', carId: 'c' }).offeredTo, ['c']);
  assert.deepEqual(order(store, undefined).offeredTo, ['a', 'b', 'c']); // implicit: toate

  store.setCarStatus('b', 'busy');
  assert.match(order(store, { mode: 'car', carId: 'b' }).error, /nu este liberă/);
  assert.match(order(store, { mode: 'car', carId: 'x' }).error, /inexistentă/);
  assert.match(order(store, { mode: 'ciudat' }).error, /Alegeți cui/);
  assert.match(store.createOrder({ customerName: '', pickup: PICKUP }).error, /numele/);
});

test('fără mașini libere comanda așteaptă și poate fi retrimisă', () => {
  const { store } = setup();
  ['a', 'b', 'c'].forEach((id) => store.setCarStatus(id, 'busy'));
  const result = order(store, { mode: 'all' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.offeredTo, []);
  store.setCarStatus('c', 'free');
  assert.deepEqual(store.resendOrder(result.ride.id, { mode: 'all' }).offeredTo, ['c']);
});

test('șoferul vede comanda fără datele clientului, cu distanța până la el', () => {
  const { store } = setup();
  const { ride } = order(store, { mode: 'all' }, { notes: 'bagaj mare' });
  const [{ offer, ride: offered }] = store.carOffers('a');
  assert.equal(offered.id, ride.id);
  assert.equal(offer.expiresAt - offer.offeredAt, OFFER_MS);
  const { offerViewForDriver } = require('../src/views');
  const view = offerViewForDriver(offer, offered, store.getCarView('a'), 25);
  assert.equal(view.address, 'Calea Victoriei 1');
  assert.equal(view.notes, 'bagaj mare');
  assert.ok(view.distanceM > 900 && view.distanceM < 1100, String(view.distanceM));
  assert.ok(view.etaMin >= 3);
  assert.ok(!JSON.stringify(view).includes('Ana') && !JSON.stringify(view).includes('0722'));
});

test('primul șofer care acceptă primește cursa; ceilalți văd că a fost preluată', () => {
  const { store, offers } = setup();
  const { ride } = order(store, { mode: 'all' });
  offers.length = 0;

  const accepted = store.acceptOffer(ride.id, 'b');
  assert.equal(accepted.ok, true);
  assert.equal(accepted.ride.status, 'assigned');
  assert.equal(accepted.ride.carPlate, 'B 02 BBB');
  assert.equal(accepted.ride.driverName, 'Maria Ionescu');
  assert.equal(store.getCarView('b').status, 'busy');
  assert.equal(store.getCarView('b').rideId, ride.id);
  assert.deepEqual(offers.sort(), [['a', 'taken'], ['b', 'accepted'], ['c', 'taken']]);

  assert.match(store.acceptOffer(ride.id, 'a').error, /preluată de alt coleg/);
  assert.equal(store.acceptOffer(ride.id, 'b').ok, true); // al doilea „Accept” al aceluiași șofer
  assert.deepEqual(store.carOffers('a'), []);
  assert.equal(store.getCarView('a').status, 'free');
  assert.deepEqual(
    store.rideOffers(ride.id).map((o) => [o.plate, o.response]),
    [['B 01 AAA', 'taken'], ['B 02 BBB', 'accepted'], ['B 03 CCC', 'taken']]
  );
});

test('refuzul, expirarea și retrimiterea comenzii', () => {
  const { store, clock } = setup();
  const { ride } = order(store, { mode: 'nearest', count: 2 });
  assert.equal(store.declineOffer(ride.id, 'a').ok, true);
  assert.match(store.acceptOffer(ride.id, 'a').error, /expirat/);
  assert.equal(store.declineOffer(ride.id, 'c').ok, true); // c nu avea ofertă: nimic de refuzat

  clock.advance(OFFER_MS + 1);
  store.expireOffers();
  assert.deepEqual(store.rideOffers(ride.id).map((o) => o.response), ['declined', 'expired']);
  assert.match(store.acceptOffer(ride.id, 'b').error, /expirat/);
  assert.equal(store.getRide(ride.id).status, 'pending'); // dispecerul decide: retrimite sau anulează

  const resent = store.resendOrder(ride.id, { mode: 'all' });
  assert.deepEqual(resent.offeredTo, ['a', 'b', 'c']);
  assert.equal(store.acceptOffer(ride.id, 'c').ok, true);
  assert.match(store.resendOrder(ride.id, { mode: 'all' }).error, /nu mai așteaptă/);
});

test('dispecerul anulează o comandă încă neacceptată', () => {
  const { store } = setup();
  const { ride } = order(store, { mode: 'all' });
  const result = store.updateRideStatus(ride.id, 'cancelled', { role: 'dispatcher', name: 'Maria' });
  assert.equal(result.ok, true);
  assert.equal(store.getRide(ride.id).closedByName, 'Maria');
  assert.deepEqual(store.rideOffers(ride.id).map((o) => o.response), ['withdrawn', 'withdrawn', 'withdrawn']);
  assert.match(store.acceptOffer(ride.id, 'a').error, /nu mai este disponibilă/);
  assert.deepEqual(store.carOffers('a'), []);
  // O comandă neacceptată nu poate fi „finalizată”, doar anulată.
  const other = order(store, { mode: 'all' }).ride;
  assert.equal(store.updateRideStatus(other.id, 'completed', { role: 'dispatcher' }).ok, false);
});

test('mașina ocupată, deconectată sau cu altă cursă nu mai are oferta', () => {
  const { store, clock } = setup();
  const first = order(store, { mode: 'all' }).ride;
  const second = order(store, { mode: 'all' }).ride;

  store.setCarStatus('b', 'busy');
  assert.deepEqual(store.carOffers('b'), []);
  assert.match(store.acceptOffer(first.id, 'b').error, /expirat/);

  // Mașina a acceptă prima comandă: oferta pentru a doua i se retrage.
  assert.equal(store.acceptOffer(first.id, 'a').ok, true);
  assert.deepEqual(store.carOffers('a'), []);
  assert.equal(store.rideOffers(second.id).find((o) => o.carId === 'a').response, 'withdrawn');

  // c se deconectează: și oferta ei se retrage.
  store.driverDisconnected('c');
  clock.advance(1000);
  assert.equal(store.getCarView('c').status, 'offline');
  assert.equal(store.rideOffers(second.id).find((o) => o.carId === 'c').response, 'withdrawn');
});

test('linkul clientului există doar cât timp cursa e în desfășurare', () => {
  const { store } = setup();
  const { ride } = order(store, { mode: 'all' });
  assert.equal(store.getRideByToken(ride.token), null); // încă nu a acceptat nimeni

  store.acceptOffer(ride.id, 'a');
  assert.equal(store.getRideByToken(ride.token).id, ride.id);
  const view = store.trackingView(ride);
  assert.equal(view.car.plate, 'B 01 AAA');
  assert.equal(view.car.driverFirstName, 'Ion');
  assert.ok(view.etaMin >= 1);

  const driver = { role: 'driver', carId: 'a' };
  store.updateRideStatus(ride.id, 'arrived', driver);
  store.updateRideStatus(ride.id, 'in_progress', driver);
  assert.ok(store.getRideByToken(ride.token));
  store.updateRideStatus(ride.id, 'completed', driver);
  assert.equal(store.getRideByToken(ride.token), null);
});

test('comenzile și ofertele continuă după repornirea serverului', () => {
  const { store, restart, clock } = setup();
  const { ride } = order(store, { mode: 'all' });
  store.declineOffer(ride.id, 'a');

  const after = restart();
  ['b', 'c'].forEach((id) => {
    after.driverConnected(id);
    after.updateLocation(id, { lat: 44.41, lng: 26.1 });
  });
  assert.equal(after.getRide(ride.id).status, 'pending');
  assert.deepEqual(after.carOffers('a'), []);
  assert.equal(after.carOffers('b').length, 1);
  assert.equal(after.acceptOffer(ride.id, 'b').ok, true);
  clock.advance(1);
  assert.equal(after.getRide(ride.id).carId, 'b');
});

test('starea SMS-ului către client se păstrează', () => {
  const { store, restart } = setup();
  const { ride } = order(store, { mode: 'all' }, {});
  store.acceptOffer(ride.id, 'a');
  store.setRideSms(ride.id, 'sent', '+40722111222');
  assert.equal(store.getRide(ride.id).sms.status, 'sent');
  assert.equal(restart().getRide(ride.id).sms.detail, '+40722111222');
});

test('statisticile: timpul până la acceptare și comenzile fără șofer', () => {
  const { store, clock } = setup();
  const accepted = order(store, { mode: 'all' }).ride;
  clock.advance(30 * 1000);
  store.acceptOffer(accepted.id, 'a');
  const lost = order(store, { mode: 'all' }).ride;
  store.updateRideStatus(lost.id, 'cancelled', { role: 'dispatcher', name: 'Maria' });
  order(store, { mode: 'all' }); // încă se caută șofer: nu e „fără șofer”

  const stats = store.rideStats({});
  assert.equal(stats.total, 3);
  assert.equal(stats.unassigned, 1);
  assert.equal(stats.avgAcceptMs, 30 * 1000);
  assert.deepEqual(stats.byDriver.map((d) => [d.carPlate, d.total]), [['B 01 AAA', 1]]);
});
