// Baza de date SQLite: flota, cursele și traseele parcurse.
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const ACTIVE_STATUSES = ['assigned', 'arrived', 'in_progress'];

// Fiecare element este o migrare; versiunea curentă se ține în PRAGMA user_version.
const MIGRATIONS = [
  `
  CREATE TABLE cars (
    id TEXT PRIMARY KEY,
    plate TEXT NOT NULL,
    model TEXT NOT NULL DEFAULT '',
    driver TEXT NOT NULL,
    pin_hash TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    last_lat REAL,
    last_lng REAL,
    last_heading REAL,
    last_ts INTEGER
  );
  CREATE UNIQUE INDEX cars_plate ON cars (plate COLLATE NOCASE);

  CREATE TABLE rides (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT NOT NULL UNIQUE,
    customer_name TEXT NOT NULL,
    phone TEXT NOT NULL DEFAULT '',
    address TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    pickup_lat REAL NOT NULL,
    pickup_lng REAL NOT NULL,
    car_id TEXT NOT NULL REFERENCES cars (id),
    -- Numărul și șoferul de la momentul cursei (pot fi schimbate ulterior în flotă).
    car_plate TEXT NOT NULL,
    driver_name TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    arrived_at INTEGER,
    started_at INTEGER,
    finished_at INTEGER,
    -- Distanța parcursă cu clientul în mașină.
    distance_m REAL NOT NULL DEFAULT 0
  );
  CREATE INDEX rides_created ON rides (created_at);
  CREATE INDEX rides_status ON rides (status);

  CREATE TABLE ride_points (
    ride_id INTEGER NOT NULL REFERENCES rides (id) ON DELETE CASCADE,
    ts INTEGER NOT NULL,
    lat REAL NOT NULL,
    lng REAL NOT NULL,
    status TEXT NOT NULL
  );
  CREATE INDEX ride_points_ride ON ride_points (ride_id, ts);
  CREATE INDEX ride_points_ts ON ride_points (ts);
  `,
];

function openDatabase(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db) {
  const current = db.pragma('user_version', { simple: true });
  for (let version = current; version < MIGRATIONS.length; version++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[version]);
      db.pragma(`user_version = ${version + 1}`);
    })();
  }
}

function rowToCar(r) {
  return {
    id: r.id,
    plate: r.plate,
    model: r.model,
    driver: r.driver,
    pinHash: r.pin_hash,
    active: r.active === 1,
    createdAt: r.created_at,
    lastPosition:
      r.last_ts === null
        ? null
        : { lat: r.last_lat, lng: r.last_lng, heading: r.last_heading, speed: null, accuracy: null, ts: r.last_ts },
  };
}

function rowToRide(r) {
  const statusTimes = { assigned: r.created_at };
  if (r.arrived_at !== null) statusTimes.arrived = r.arrived_at;
  if (r.started_at !== null) statusTimes.in_progress = r.started_at;
  if (r.finished_at !== null) statusTimes[r.status] = r.finished_at;
  return {
    id: String(r.id),
    token: r.token,
    customerName: r.customer_name,
    phone: r.phone,
    address: r.address,
    notes: r.notes,
    pickup: { lat: r.pickup_lat, lng: r.pickup_lng },
    carId: r.car_id,
    carPlate: r.car_plate,
    driverName: r.driver_name,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    statusTimes,
    distanceM: r.distance_m,
  };
}

function rideParams(ride) {
  const t = ride.statusTimes;
  return {
    id: Number(ride.id),
    status: ride.status,
    updatedAt: ride.updatedAt,
    arrivedAt: t.arrived ?? null,
    startedAt: t.in_progress ?? null,
    finishedAt: t.completed ?? t.cancelled ?? null,
    distanceM: ride.distanceM,
  };
}

/**
 * Construiește clauza WHERE pentru căutarea în istoric.
 * Filtre: from/to (ms), carId, status ('active' | 'completed' | 'cancelled'), q (text).
 */
function rideFilter(filters) {
  const where = [];
  const params = {};
  if (Number.isFinite(filters.from)) {
    where.push('r.created_at >= @from');
    params.from = filters.from;
  }
  if (Number.isFinite(filters.to)) {
    where.push('r.created_at < @to');
    params.to = filters.to;
  }
  if (filters.carId) {
    where.push('r.car_id = @carId');
    params.carId = filters.carId;
  }
  if (filters.status === 'active') {
    where.push(`r.status IN (${ACTIVE_STATUSES.map((s) => `'${s}'`).join(', ')})`);
  } else if (filters.status) {
    where.push('r.status = @status');
    params.status = filters.status;
  }
  if (filters.q) {
    where.push("(r.customer_name LIKE @q ESCAPE '\\' OR r.phone LIKE @q ESCAPE '\\' OR r.address LIKE @q ESCAPE '\\')");
    params.q = '%' + filters.q.replace(/[\\%_]/g, (ch) => '\\' + ch) + '%';
  }
  return { sql: where.length ? 'WHERE ' + where.join(' AND ') : '', params };
}

function createRepository(db) {
  const st = {
    countCars: db.prepare('SELECT COUNT(*) AS n FROM cars'),
    allCars: db.prepare('SELECT * FROM cars ORDER BY plate'),
    insertCar: db.prepare(
      `INSERT INTO cars (id, plate, model, driver, pin_hash, active, created_at)
       VALUES (@id, @plate, @model, @driver, @pinHash, @active, @createdAt)`
    ),
    updateCar: db.prepare(
      'UPDATE cars SET plate = @plate, model = @model, driver = @driver, pin_hash = @pinHash, active = @active WHERE id = @id'
    ),
    savePosition: db.prepare(
      'UPDATE cars SET last_lat = @lat, last_lng = @lng, last_heading = @heading, last_ts = @ts WHERE id = @id'
    ),
    insertRide: db.prepare(
      `INSERT INTO rides (token, customer_name, phone, address, notes, pickup_lat, pickup_lng,
                          car_id, car_plate, driver_name, status, created_at, updated_at)
       VALUES (@token, @customerName, @phone, @address, @notes, @pickupLat, @pickupLng,
               @carId, @carPlate, @driverName, @status, @createdAt, @updatedAt)`
    ),
    updateRide: db.prepare(
      `UPDATE rides SET status = @status, updated_at = @updatedAt, arrived_at = @arrivedAt,
                        started_at = @startedAt, finished_at = @finishedAt, distance_m = @distanceM
       WHERE id = @id`
    ),
    saveDistance: db.prepare('UPDATE rides SET distance_m = ? WHERE id = ?'),
    insertPoint: db.prepare('INSERT INTO ride_points (ride_id, ts, lat, lng, status) VALUES (?, ?, ?, ?, ?)'),
    activeRides: db.prepare(
      `SELECT * FROM rides WHERE status IN (${ACTIVE_STATUSES.map((s) => `'${s}'`).join(', ')}) ORDER BY created_at`
    ),
    rideById: db.prepare('SELECT * FROM rides WHERE id = ?'),
    rideByToken: db.prepare('SELECT * FROM rides WHERE token = ?'),
    recentFinished: db.prepare(
      `SELECT * FROM rides WHERE status IN ('completed', 'cancelled') AND finished_at >= ?
       ORDER BY finished_at DESC LIMIT ?`
    ),
    ridePoints: db.prepare('SELECT ts, lat, lng, status FROM ride_points WHERE ride_id = ? ORDER BY ts, rowid'),
    prunePoints: db.prepare('DELETE FROM ride_points WHERE ts < ?'),
  };

  return {
    countCars: () => st.countCars.get().n,
    listCars: () => st.allCars.all().map(rowToCar),
    insertCar: (car) => st.insertCar.run({ ...car, active: car.active ? 1 : 0 }),
    updateCar: (car) => st.updateCar.run({ ...car, active: car.active ? 1 : 0 }),
    saveCarPosition: (id, pos) => st.savePosition.run({ id, lat: pos.lat, lng: pos.lng, heading: pos.heading, ts: pos.ts }),

    /** Salvează o cursă nouă și întoarce id-ul ei (ca text). */
    insertRide(ride) {
      const info = st.insertRide.run({
        ...ride,
        pickupLat: ride.pickup.lat,
        pickupLng: ride.pickup.lng,
      });
      return String(info.lastInsertRowid);
    },
    updateRide: (ride) => st.updateRide.run(rideParams(ride)),
    saveRideDistance: (id, meters) => st.saveDistance.run(meters, Number(id)),
    addRidePoint: (id, pos, status) => st.insertPoint.run(Number(id), pos.ts, pos.lat, pos.lng, status),
    activeRides: () => st.activeRides.all().map(rowToRide),
    rideById(id) {
      const row = /^\d+$/.test(String(id)) ? st.rideById.get(Number(id)) : null;
      return row ? rowToRide(row) : null;
    },
    rideByToken(token) {
      const row = st.rideByToken.get(token);
      return row ? rowToRide(row) : null;
    },
    recentFinished: (since, limit) => st.recentFinished.all(since, limit).map(rowToRide),
    ridePoints: (id) => st.ridePoints.all(Number(id)),
    pruneRidePoints: (before) => st.prunePoints.run(before).changes,

    searchRides(filters, { limit, offset }) {
      const { sql, params } = rideFilter(filters);
      const rows = db
        .prepare(`SELECT r.* FROM rides r ${sql} ORDER BY r.created_at DESC, r.id DESC LIMIT @limit OFFSET @offset`)
        .all({ ...params, limit, offset });
      const { total } = db.prepare(`SELECT COUNT(*) AS total FROM rides r ${sql}`).get(params);
      return { rides: rows.map(rowToRide), total };
    },

    rideStats(filters) {
      const { sql, params } = rideFilter(filters);
      const totals = db
        .prepare(
          `SELECT COUNT(*) AS total,
                  COALESCE(SUM(r.status = 'completed'), 0) AS completed,
                  COALESCE(SUM(r.status = 'cancelled'), 0) AS cancelled,
                  COALESCE(SUM(CASE WHEN r.status = 'completed' THEN r.distance_m END), 0) AS distanceM,
                  AVG(r.arrived_at - r.created_at) AS avgPickupMs,
                  AVG(CASE WHEN r.status = 'completed' THEN r.finished_at - r.started_at END) AS avgRideMs
           FROM rides r ${sql}`
        )
        .get(params);
      const byDriver = db
        .prepare(
          `SELECT r.car_id AS carId, MAX(r.car_plate) AS carPlate, r.driver_name AS driverName,
                  COUNT(*) AS total,
                  SUM(r.status = 'completed') AS completed,
                  SUM(r.status = 'cancelled') AS cancelled,
                  COALESCE(SUM(CASE WHEN r.status = 'completed' THEN r.distance_m END), 0) AS distanceM
           FROM rides r ${sql}
           GROUP BY r.car_id, r.driver_name
           ORDER BY completed DESC, total DESC`
        )
        .all(params);
      return { ...totals, byDriver };
    },
  };
}

module.exports = { openDatabase, createRepository };
