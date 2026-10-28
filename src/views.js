// Ce date despre o cursă vede fiecare rol.
const Geo = require('../shared/geo');

/** Vederea dispecerului; `offers` sunt ofertele trimise șoferilor (cu numărul mașinii). */
function rideViewForDispatcher(ride, offers = []) {
  return {
    id: ride.id,
    customerName: ride.customerName,
    phone: ride.phone,
    address: ride.address,
    notes: ride.notes,
    pickup: ride.pickup,
    carId: ride.carId,
    carPlate: ride.carPlate,
    driverName: ride.driverName,
    status: ride.status,
    createdAt: ride.createdAt,
    updatedAt: ride.updatedAt,
    statusTimes: ride.statusTimes,
    distanceM: Math.round(ride.distanceM),
    createdByName: ride.createdByName || '',
    closedByName: ride.closedByName || '',
    sms: ride.sms || { status: '', detail: '', at: null },
    offers: offers.map((o) => ({
      carId: o.carId,
      plate: o.plate,
      offeredAt: o.offeredAt,
      expiresAt: o.expiresAt,
      response: o.response,
      respondedAt: o.respondedAt,
    })),
    trackPath: `/track/${ride.token}`,
  };
}

/** Vederea șoferului după ce a acceptat cursa (abia atunci vede datele clientului). */
function rideViewForDriver(ride) {
  return {
    id: ride.id,
    customerName: ride.customerName,
    phone: ride.phone,
    address: ride.address,
    notes: ride.notes,
    pickup: ride.pickup,
    status: ride.status,
    createdAt: ride.createdAt,
  };
}

/** O comandă oferită șoferului: unde e clientul și cât de departe, fără numele sau telefonul lui. */
function offerViewForDriver(offer, ride, car, avgSpeedKmh) {
  const distanceM = car && car.position ? Math.round(Geo.distanceMeters(car.position, ride.pickup)) : null;
  return {
    rideId: ride.id,
    address: ride.address,
    pickup: ride.pickup,
    notes: ride.notes,
    offeredAt: offer.offeredAt,
    expiresAt: offer.expiresAt,
    distanceM,
    etaMin: distanceM === null ? null : Geo.etaMinutes(distanceM, avgSpeedKmh),
  };
}

module.exports = { rideViewForDispatcher, rideViewForDriver, offerViewForDriver };
