// API-ul șoferilor: autentificare cu mașină + PIN și trimiterea poziției prin HTTP.
// Aplicația de telefon folosește HTTP nativ, care funcționează și când aplicația e în fundal
// (Android încetinește conexiunile paginii după câteva minute în fundal).
const express = require('express');
const { rideViewForDriver, offerViewForDriver } = require('./views');

function bearerToken(req) {
  const header = req.get('authorization') || '';
  return header.startsWith('Bearer ') ? header.slice(7) : '';
}

function createDriverApi({ store, limiter }) {
  const router = express.Router();
  router.use(express.json({ limit: '10kb' }));

  /**
   * Starea curentă a șoferului: mașina, cursa (activă sau abia încheiată) și comenzile oferite acum.
   * Aplicația o primește la fiecare poziție trimisă, deci află de comenzi noi și din fundal.
   */
  function driverState(carId) {
    const car = store.getCarView(carId);
    const ride = store.driverRide(carId);
    const offers = store.carOffers(carId).map(({ offer, ride: order }) => offerViewForDriver(offer, order, car, store.avgSpeedKmh));
    return {
      car: { id: car.id, plate: car.plate, status: car.status, rideId: car.rideId },
      ride: ride ? rideViewForDriver(ride) : null,
      offers,
    };
  }

  router.post('/login', (req, res) => {
    if (limiter.blocked(req.ip)) {
      return res.status(429).json({ error: 'Prea multe încercări greșite. Reîncercați peste câteva minute.' });
    }
    const { carId, pin, device } = req.body || {};
    const result = store.createDriverSession(carId, typeof pin === 'string' ? pin : '', { device: typeof device === 'string' ? device : '' });
    if (!result.ok) {
      limiter.fail(req.ip);
      return res.status(401).json({ error: result.error });
    }
    res.json({ token: result.token, car: result.car });
  });

  router.use((req, res, next) => {
    const token = bearerToken(req);
    const carId = store.authenticateDriverToken(token);
    if (!carId) return res.status(401).json({ error: 'Sesiunea a expirat. Intrați din nou.', code: 'unauthenticated' });
    req.carId = carId;
    req.driverToken = token;
    next();
  });

  router.get('/state', (req, res) => res.json(driverState(req.carId)));

  router.post('/location', (req, res) => {
    store.driverHeartbeat(req.carId);
    const result = store.updateLocation(req.carId, req.body);
    if (!result.ok) return res.status(400).json(result);
    // Răspunsul conține și cursa curentă: așa află aplicația de o cursă nouă chiar din fundal.
    res.json({ ok: true, ...driverState(req.carId) });
  });

  router.post('/offers/:rideId/accept', (req, res) => {
    const result = store.acceptOffer(req.params.rideId, req.carId);
    if (!result.ok) return res.status(409).json({ ...result, ...driverState(req.carId) });
    res.json({ ok: true, ...driverState(req.carId) });
  });

  router.post('/offers/:rideId/decline', (req, res) => {
    store.declineOffer(req.params.rideId, req.carId);
    res.json({ ok: true, ...driverState(req.carId) });
  });

  router.post('/rides/:rideId/status', (req, res) => {
    const status = req.body && req.body.status;
    const result = store.updateRideStatus(req.params.rideId, status, { role: 'driver', carId: req.carId });
    if (!result.ok) return res.status(400).json({ ...result, ...driverState(req.carId) });
    res.json({ ok: true, ...driverState(req.carId) });
  });

  router.post('/logout', (req, res) => {
    store.endDriverSession(req.driverToken);
    res.json({ ok: true });
  });

  router.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON invalid' });
    next(err);
  });

  return router;
}

module.exports = { createDriverApi };
