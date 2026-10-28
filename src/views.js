// Ce date despre o cursă vede fiecare rol.

function rideViewForDispatcher(ride) {
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
    trackPath: `/track/${ride.token}`,
  };
}

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

module.exports = { rideViewForDispatcher, rideViewForDriver };
