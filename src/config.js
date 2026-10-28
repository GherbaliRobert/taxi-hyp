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

/** Furnizorul de SMS pentru linkul trimis clientului (vezi src/sms.js). */
function loadSmsConfig(env) {
  const sms = {
    provider: env.SMS_PROVIDER || 'console',
    countryCode: env.SMS_COUNTRY_CODE || '40',
    smsgateUrl: env.SMSGATE_URL || '',
    smsgateUser: env.SMSGATE_USER || '',
    smsgatePassword: env.SMSGATE_PASSWORD || '',
    twilioAccountSid: env.TWILIO_ACCOUNT_SID || '',
    twilioAuthToken: env.TWILIO_AUTH_TOKEN || '',
    twilioFrom: env.TWILIO_FROM || '',
    twilioMessagingServiceSid: env.TWILIO_MESSAGING_SERVICE_SID || '',
  };
  const missing = {
    console: [],
    smsgate: ['SMSGATE_USER', 'SMSGATE_PASSWORD'].filter((k) => !env[k]),
    twilio: [
      ...['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'].filter((k) => !env[k]),
      ...(env.TWILIO_FROM || env.TWILIO_MESSAGING_SERVICE_SID ? [] : ['TWILIO_FROM']),
    ],
  }[sms.provider];
  if (!missing) throw new Error(`SMS_PROVIDER necunoscut: „${sms.provider}” (console, smsgate sau twilio)`);
  if (missing.length) throw new Error(`SMS_PROVIDER=${sms.provider} are nevoie de: ${missing.join(', ')}`);
  return sms;
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
    // Adresa publică a serverului, folosită în linkul din SMS (ex. https://taxi.firma-mea.ro).
    // Fără ea se folosește adresa de pe care lucrează dispecerul.
    publicUrl: (env.PUBLIC_URL || '').replace(/\/+$/, ''),
    // Câte secunde are un șofer să accepte o comandă.
    offerTimeoutSeconds: number(env.OFFER_TIMEOUT_SECONDS, 60),
    sms: loadSmsConfig(env),
  };
}

module.exports = { loadConfig, loadCars, loadSmsConfig };
