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
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'dispatcher')),
    active INTEGER NOT NULL DEFAULT 1,
    must_change_password INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_login_at INTEGER
  );
  CREATE UNIQUE INDEX users_username ON users (username COLLATE NOCASE);

  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    ip TEXT NOT NULL DEFAULT '',
    user_agent TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX sessions_user ON sessions (user_id);

  -- Jurnalul de acțiuni: cine, ce, când. Numele utilizatorului se copiază (rămâne și dacă se schimbă).
  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    user_id INTEGER REFERENCES users (id),
    user_name TEXT NOT NULL DEFAULT '',
    action TEXT NOT NULL,
    target TEXT NOT NULL DEFAULT '',
    summary TEXT NOT NULL DEFAULT '',
    ip TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX audit_ts ON audit_log (ts);
  CREATE INDEX audit_user ON audit_log (user_id, ts);

  ALTER TABLE rides ADD COLUMN created_by_id INTEGER REFERENCES users (id);
  ALTER TABLE rides ADD COLUMN created_by_name TEXT NOT NULL DEFAULT '';
  ALTER TABLE rides ADD COLUMN closed_by_name TEXT NOT NULL DEFAULT '';
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
    createdById: r.created_by_id,
    createdByName: r.created_by_name,
    closedByName: r.closed_by_name,
  };
}

function rowToUser(r) {
  return {
    id: r.id,
    username: r.username,
    name: r.name,
    passwordHash: r.password_hash,
    role: r.role,
    active: r.active === 1,
    mustChangePassword: r.must_change_password === 1,
    createdAt: r.created_at,
    lastLoginAt: r.last_login_at,
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
    closedByName: ride.closedByName || '',
  };
}

/** Filtrele jurnalului: from/to (ms), userId, category (prefixul acțiunii: 'ride', 'car', …). */
function auditFilter(filters) {
  const where = [];
  const params = {};
  if (Number.isFinite(filters.from)) {
    where.push('ts >= @from');
    params.from = filters.from;
  }
  if (Number.isFinite(filters.to)) {
    where.push('ts < @to');
    params.to = filters.to;
  }
  if (Number.isInteger(filters.userId)) {
    where.push('user_id = @userId');
    params.userId = filters.userId;
  }
  if (filters.category) {
    where.push("action LIKE @category ESCAPE '\\'");
    params.category = filters.category.replace(/[\\%_]/g, (ch) => '\\' + ch) + '\\_%';
  }
  return { sql: where.length ? 'WHERE ' + where.join(' AND ') : '', params };
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
                          car_id, car_plate, driver_name, status, created_at, updated_at,
                          created_by_id, created_by_name)
       VALUES (@token, @customerName, @phone, @address, @notes, @pickupLat, @pickupLng,
               @carId, @carPlate, @driverName, @status, @createdAt, @updatedAt,
               @createdById, @createdByName)`
    ),
    updateRide: db.prepare(
      `UPDATE rides SET status = @status, updated_at = @updatedAt, arrived_at = @arrivedAt,
                        started_at = @startedAt, finished_at = @finishedAt, distance_m = @distanceM,
                        closed_by_name = @closedByName
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

    countUsers: db.prepare('SELECT COUNT(*) AS n FROM users'),
    countActiveAdmins: db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1"),
    allUsers: db.prepare('SELECT * FROM users ORDER BY active DESC, name COLLATE NOCASE'),
    userById: db.prepare('SELECT * FROM users WHERE id = ?'),
    userByUsername: db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE'),
    insertUser: db.prepare(
      `INSERT INTO users (username, name, password_hash, role, active, must_change_password, created_at)
       VALUES (@username, @name, @passwordHash, @role, @active, @mustChangePassword, @createdAt)`
    ),
    updateUser: db.prepare(
      `UPDATE users SET username = @username, name = @name, password_hash = @passwordHash, role = @role,
                        active = @active, must_change_password = @mustChangePassword, last_login_at = @lastLoginAt
       WHERE id = @id`
    ),
    insertSession: db.prepare(
      `INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at, ip, user_agent)
       VALUES (@tokenHash, @userId, @createdAt, @lastSeenAt, @ip, @userAgent)`
    ),
    session: db.prepare('SELECT * FROM sessions WHERE token_hash = ?'),
    touchSession: db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?'),
    deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
    deleteUserSessions: db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?'),
    pruneSessions: db.prepare('DELETE FROM sessions WHERE last_seen_at < ? OR created_at < ?'),
    sessionCounts: db.prepare('SELECT user_id AS userId, COUNT(*) AS n FROM sessions WHERE last_seen_at >= ? GROUP BY user_id'),
    insertAudit: db.prepare(
      `INSERT INTO audit_log (ts, user_id, user_name, action, target, summary, ip)
       VALUES (@ts, @userId, @userName, @action, @target, @summary, @ip)`
    ),
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
      const byDispatcher = db
        .prepare(
          `SELECT r.created_by_name AS name, COUNT(*) AS total,
                  SUM(r.status = 'completed') AS completed,
                  SUM(r.status = 'cancelled') AS cancelled
           FROM rides r ${sql}
           GROUP BY r.created_by_name
           ORDER BY total DESC, name`
        )
        .all(params);
      const byDriver = db
        .prepare(
          `SELECT r.car_id AS carId, MAX(r.car_plate) AS carPlate, r.driver_name AS driverName,
                  COUNT(*) AS total,
                  SUM(r.status = 'completed') AS completed,
                  SUM(r.status = 'cancelled') AS cancelled,
                  COALESCE(SUM(CASE WHEN r.status = 'completed' THEN r.distance_m END), 0) AS distanceM
           FROM rides r ${sql}
           GROUP BY r.car_id, r.driver_name
           ORDER BY completed DESC, total DESC, carPlate`
        )
        .all(params);
      return { ...totals, byDriver, byDispatcher };
    },

    // ---- Utilizatori și sesiuni ----

    countUsers: () => st.countUsers.get().n,
    countActiveAdmins: () => st.countActiveAdmins.get().n,
    listUsers: () => st.allUsers.all().map(rowToUser),
    userById(id) {
      const row = st.userById.get(id);
      return row ? rowToUser(row) : null;
    },
    userByUsername(username) {
      const row = st.userByUsername.get(username);
      return row ? rowToUser(row) : null;
    },
    insertUser(user) {
      const info = st.insertUser.run({
        ...user,
        active: user.active ? 1 : 0,
        mustChangePassword: user.mustChangePassword ? 1 : 0,
      });
      return Number(info.lastInsertRowid);
    },
    updateUser: (user) =>
      st.updateUser.run({
        ...user,
        active: user.active ? 1 : 0,
        mustChangePassword: user.mustChangePassword ? 1 : 0,
        lastLoginAt: user.lastLoginAt ?? null,
      }),
    insertSession: (session) => st.insertSession.run(session),
    session: (tokenHash) => st.session.get(tokenHash) || null,
    touchSession: (tokenHash, ts) => st.touchSession.run(ts, tokenHash),
    deleteSession: (tokenHash) => st.deleteSession.run(tokenHash),
    /** Închide toate sesiunile utilizatorului, eventual cu excepția celei curente. */
    deleteUserSessions: (userId, exceptTokenHash = '') => st.deleteUserSessions.run(userId, exceptTokenHash),
    pruneSessions: (idleBefore, createdBefore) => st.pruneSessions.run(idleBefore, createdBefore).changes,
    sessionCounts: (since) => new Map(st.sessionCounts.all(since).map((r) => [r.userId, r.n])),

    // ---- Jurnal ----

    insertAudit: (entry) => st.insertAudit.run(entry),
    searchAudit(filters, { limit, offset }) {
      const { sql, params } = auditFilter(filters);
      const entries = db
        .prepare(
          `SELECT id, ts, user_id AS userId, user_name AS userName, action, target, summary, ip
           FROM audit_log ${sql} ORDER BY ts DESC, id DESC LIMIT @limit OFFSET @offset`
        )
        .all({ ...params, limit, offset });
      const { total } = db.prepare(`SELECT COUNT(*) AS total FROM audit_log ${sql}`).get(params);
      return { entries, total };
    },
  };
}

module.exports = { openDatabase, createRepository };
