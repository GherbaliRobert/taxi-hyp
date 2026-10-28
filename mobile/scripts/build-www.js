#!/usr/bin/env node
// Construiește conținutul aplicației (www/) din pagina șoferului a serverului (public/driver.html),
// ca aplicația și pagina web să aibă aceeași interfață.
//
//   npm run build:www                                     → adresa serverului se introduce în aplicație
//   TAXI_SERVER_URL=https://taxi.firma-mea.ro npm run build:www   → adresa e completată din start

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(__dirname, '..', 'www');
const SERVER_URL = (process.env.TAXI_SERVER_URL || '').replace(/\/+$/, '');

if (SERVER_URL && !/^https:\/\//.test(SERVER_URL)) {
  console.error('TAXI_SERVER_URL trebuie să înceapă cu https:// (Android nu permite conexiuni necriptate).');
  process.exit(1);
}

function copy(from, to) {
  fs.mkdirSync(path.dirname(path.join(OUT, to)), { recursive: true });
  fs.cpSync(from, path.join(OUT, to), { recursive: true });
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

copy(path.join(ROOT, 'public', 'css', 'style.css'), 'css/style.css');
copy(path.join(ROOT, 'public', 'js', 'common.js'), 'js/common.js');
copy(path.join(ROOT, 'public', 'js', 'driver.js'), 'js/driver.js');
copy(path.join(ROOT, 'shared', 'geo.js'), 'shared/geo.js');
copy(path.join(ROOT, 'node_modules', 'leaflet', 'dist'), 'vendor/leaflet');
copy(path.join(ROOT, 'node_modules', 'socket.io-client', 'dist', 'socket.io.min.js'), 'vendor/socket.io.min.js');
copy(path.join(__dirname, '..', 'node_modules', '@capacitor', 'core', 'dist', 'capacitor.js'), 'vendor/capacitor.js');

// Căile absolute ale serverului devin relative la aplicație; se adaugă Capacitor și configurația.
let html = fs.readFileSync(path.join(ROOT, 'public', 'driver.html'), 'utf8');
html = html
  .replace('<script src="/socket.io/socket.io.js"></script>', '<script src="vendor/socket.io.min.js"></script>')
  .replace(/(href|src)="\/(?!\/)/g, '$1="')
  .replace(
    '<script src="js/common.js"></script>',
    '<script src="vendor/capacitor.js"></script>\n  <script src="app-config.js"></script>\n  <script src="js/common.js"></script>'
  );
if (!html.includes('vendor/capacitor.js') || /(href|src)="\//.test(html)) {
  throw new Error('public/driver.html are o structură neașteptată; verificați build-www.js');
}
fs.writeFileSync(path.join(OUT, 'index.html'), html);
fs.writeFileSync(
  path.join(OUT, 'app-config.js'),
  `// Generat de scripts/build-www.js\nwindow.TAXI_APP = ${JSON.stringify({ serverUrl: SERVER_URL })};\n`
);

console.log(`www/ construit${SERVER_URL ? ` pentru ${SERVER_URL}` : ' (adresa serverului se introduce în aplicație)'}`);
