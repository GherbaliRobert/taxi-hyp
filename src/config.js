const fs = require('fs');
const path = require('path');

function loadCars(file) {
  const cars = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(cars) || cars.length === 0) {
    throw new Error(`${file}: trebuie să conțină o listă nevidă de mașini`);
  }
  const ids = new Set();
  for (const car of cars) {
    for (const field of ['id', 'plate', 'driver', 'pin']) {
      if (typeof car[field] !== 'string' || car[field].trim() === '') {
        throw new Error(`${file}: mașina ${JSON.stringify(car)} nu are câmpul "${field}"`);
      }
    }
    if (ids.has(car.id)) throw new Error(`${file}: id duplicat "${car.id}"`);
    ids.add(car.id);
  }
  return cars;
}

function number(value, fallback) {
  const n = Number(value);
  return value !== undefined && value !== '' && Number.isFinite(n) ? n : fallback;
}

function loadConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  // Parola contului „admin”, folosită o singură dată: la prima pornire, când nu există niciun cont.
  // DISPATCHER_PASSWORD este acceptată pentru compatibilitate cu versiunea anterioară.
  const adminPassword = env.ADMIN_PASSWORD || env.DISPATCHER_PASSWORD || '';

  return {
    port: number(env.PORT, 3000),
    companyName: env.COMPANY_NAME || 'Taxi Hyp',
    // În dezvoltare, fără parolă setată: „admin”, care trebuie schimbată la prima autentificare.
    adminPassword: adminPassword || (production ? '' : 'admin'),
    adminPasswordIsDefault: !adminPassword,
    sessionIdleHours: number(env.SESSION_IDLE_HOURS, 12),
    // Fusul orar pentru datele scrise de server (ex. perioada din jurnal la exporturi).
    timeZone: env.TIME_ZONE || 'Europe/Bucharest',
    databaseFile: env.DATABASE_FILE || path.join(__dirname, '..', 'data', 'taxi.db'),
    // Flota inițială, importată doar la prima pornire (când baza de date nu are mașini).
    seedCarsFile: env.CARS_FILE || path.join(__dirname, '..', 'data', 'cars.json'),
    // Câte zile se păstrează traseele GPS ale curselor (cursele rămân oricum în istoric).
    routeRetentionDays: number(env.ROUTE_RETENTION_DAYS, 180),
    // Centrul inițial al hărții (implicit: București).
    mapCenter: [number(env.MAP_CENTER_LAT, 44.4268), number(env.MAP_CENTER_LNG, 26.1025)],
    mapZoom: number(env.MAP_ZOOM, 13),
    // Țara în care se caută adresele (cod ISO, ex. "ro"); gol = oriunde.
    geocodeCountry: env.GEOCODE_COUNTRY === undefined ? 'ro' : env.GEOCODE_COUNTRY,
    // Viteza medie în oraș folosită pentru timpul estimat de sosire.
    avgSpeedKmh: number(env.AVG_SPEED_KMH, 25),
    // Activați doar când aplicația rulează în spatele unui reverse proxy (nginx, Caddy).
    trustProxy: env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true',
  };
}

module.exports = { loadConfig, loadCars };
