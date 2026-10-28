// Pagina șoferului: transmite poziția GPS a telefonului și primește cursele de la dispecerat.
(function () {
  const UI = window.TaxiUI;
  const { el } = UI;
  const $ = (id) => document.getElementById(id);

  const CREDENTIALS_KEY = 'taxi.driver';
  const GPS_ON_KEY = 'taxi.driver.gps';
  const SEND_INTERVAL_MS = 1000;
  // Telefonul nu raportează poziții noi când mașina stă pe loc; retrimitem ca dispeceratul să știe că suntem activi.
  const HEARTBEAT_MS = 15000;

  let config;
  let socket;
  let car = null;
  let ride = null;
  let watchId = null;
  let wakeLock = null;
  let lastFix = null;
  let lastSentAt = 0;
  let map;
  let carMarker = null;
  let pickupMarker = null;
  let centeredOnce = false;
  let audio = null;

  init().catch((err) => {
    console.error(err);
    UI.toast('Eroare la pornire: ' + err.message, 'error');
  });

  async function init() {
    config = await UI.loadConfig();
    document.querySelectorAll('.company-name').forEach((n) => (n.textContent = config.companyName));

    $('login-form').addEventListener('submit', (e) => {
      e.preventDefault();
      unlockAudio();
      $('login-error').textContent = '';
      connect($('car-select').value, $('pin').value);
    });
    $('logout').addEventListener('click', logout);
    $('gps-toggle').addEventListener('click', () => {
      unlockAudio();
      if (watchId === null) startGps();
      else stopGps();
    });
    document.querySelectorAll('#status-toggle button').forEach((btn) =>
      btn.addEventListener('click', () => setStatus(btn.dataset.status))
    );
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && watchId !== null) requestWakeLock();
    });
    setInterval(heartbeat, 5000);

    const saved = readCredentials();
    if (saved) connect(saved.carId, saved.pin);
    else showLogin();
  }

  // ---------- Autentificare și conexiune ----------

  async function showLogin(error) {
    $('app').hidden = true;
    $('login').hidden = false;
    $('login-error').textContent = error || '';
    const select = $('car-select');
    if (!select.options.length) {
      try {
        const res = await fetch('/api/cars');
        const list = await res.json();
        select.replaceChildren(
          ...list.map((c) => el('option', { value: c.id }, c.plate + (c.model ? ' · ' + c.model : '')))
        );
      } catch {
        $('login-error').textContent = 'Nu s-a putut încărca lista de mașini.';
      }
    }
  }

  function connect(carId, pin) {
    if (socket) socket.disconnect();
    socket = io({ auth: { role: 'driver', carId, pin } });
    UI.setConnection($('conn'), 'connecting');

    socket.on('connect', () => {
      saveCredentials({ carId, pin });
      UI.setConnection($('conn'), 'online');
      showApp();
      // Trimitem imediat ultima poziție cunoscută, ca mașina să apară pe hartă fără întârziere.
      if (lastFix) sendLocation(true);
    });
    socket.on('disconnect', (reason) => {
      UI.setConnection($('conn'), 'offline');
      // Serverul a închis sesiunea: PIN schimbat sau mașină dezactivată de dispecerat.
      if (reason === 'io server disconnect') {
        clearCredentials();
        stopGps();
        showLogin('Sesiunea a fost închisă de dispecerat (PIN schimbat sau mașină dezactivată). Intrați din nou.');
      }
    });
    socket.on('connect_error', (err) => {
      if (err.message === 'unauthorized' || err.message === 'too_many_attempts') {
        socket.disconnect();
        clearCredentials();
        stopGps();
        showLogin(
          err.message === 'too_many_attempts'
            ? 'Prea multe încercări greșite. Reîncercați peste câteva minute.'
            : 'PIN greșit pentru mașina aleasă.'
        );
      } else {
        UI.setConnection($('conn'), 'offline');
      }
    });

    socket.on('driver:init', (data) => {
      car = data.car;
      setRide(data.ride, false);
      renderStatus();
    });
    socket.on('car:update', (data) => {
      car = data;
      renderStatus();
    });
    socket.on('ride:update', (data) => setRide(data, true));
  }

  function showApp() {
    $('login').hidden = true;
    $('app').hidden = false;
    if (!map) {
      map = UI.createMap($('map'), config);
    }
    map.invalidateSize();
    if (watchId === null && readGpsPreference()) startGps();
  }

  function logout() {
    if (ride && !confirm('Aveți o cursă activă. Sigur ieșiți?')) return;
    stopGps();
    clearCredentials();
    if (socket) socket.disconnect();
    location.reload();
  }

  // ---------- Status liber / ocupat ----------

  function renderStatus() {
    if (!car) return;
    $('car-plate').textContent = car.plate;
    document.title = car.plate + ' · Șofer';
    for (const btn of document.querySelectorAll('#status-toggle button')) {
      btn.setAttribute('aria-pressed', String(btn.dataset.status === car.status));
      // Cât timp are o cursă, mașina rămâne ocupată.
      btn.disabled = Boolean(car.rideId);
    }
    if (carMarker) UI.styleCarMarker(carMarker, car.status, lastFix);
  }

  function setStatus(status) {
    if (!socket || !socket.connected) return UI.toast('Nu sunteți conectat la dispecerat', 'error');
    socket.emit('status', { status }, (res) => {
      if (!res.ok) UI.toast(res.error, 'error');
    });
  }

  // ---------- Cursa curentă ----------

  function setRide(data, fromUpdate) {
    const finished = !data || data.status === 'completed' || data.status === 'cancelled';
    if (finished) {
      if (fromUpdate && data && data.status === 'cancelled' && ride && ride.id === data.id) {
        UI.toast('Cursa #' + data.id + ' a fost anulată de dispecerat', 'error');
        alertDriver();
      }
      ride = null;
    } else {
      const isNew = !ride || ride.id !== data.id;
      ride = data;
      if (isNew && fromUpdate) alertDriver();
    }
    renderRide();
  }

  function renderRide() {
    const card = $('ride-card');
    if (pickupMarker) {
      pickupMarker.remove();
      pickupMarker = null;
    }
    if (!ride) {
      card.hidden = true;
      card.replaceChildren();
      return;
    }

    const { lat, lng } = ride.pickup;
    const buttons = [];
    if (ride.status === 'assigned') buttons.push(rideButton('Am ajuns la client', 'arrived', 'btn-dark'));
    if (ride.status === 'assigned' || ride.status === 'arrived') {
      buttons.push(rideButton('Client preluat', 'in_progress', 'btn-primary'));
    }
    if (ride.status === 'in_progress') buttons.push(rideButton('Cursă finalizată', 'completed', 'btn-primary'));

    const navigation =
      ride.status !== 'in_progress'
        ? el(
            'div',
            { class: 'grid' },
            el('a', { class: 'btn', target: '_blank', rel: 'noopener', href: 'https://www.google.com/maps/dir/?api=1&destination=' + lat + ',' + lng }, 'Google Maps'),
            el('a', { class: 'btn', target: '_blank', rel: 'noopener', href: 'https://waze.com/ul?ll=' + lat + ',' + lng + '&navigate=yes' }, 'Waze')
          )
        : null;

    card.replaceChildren(
      el('div', { class: 'gps-line' }, el('h2', {}, 'Cursa #' + ride.id), el('span', { class: 'badge', dataset: { status: ride.status } }, UI.RIDE_STATUS_LABELS[ride.status])),
      el('div', { class: 'address' }, ride.address || 'Punct pe hartă: ' + lat.toFixed(5) + ', ' + lng.toFixed(5)),
      el('div', {}, 'Client: ', el('strong', {}, ride.customerName)),
      ride.phone ? el('div', {}, 'Telefon: ', el('a', { href: 'tel:' + ride.phone }, ride.phone)) : null,
      ride.notes ? el('div', {}, 'Observații: ' + ride.notes) : null,
      navigation,
      el('div', { class: 'grid' }, buttons)
    );
    card.hidden = false;

    if (map && ride.status !== 'in_progress') {
      pickupMarker = L.marker([lat, lng], { icon: UI.pickupIcon() }).addTo(map);
      const points = [[lat, lng]];
      if (carMarker) points.push(carMarker.getLatLng());
      map.fitBounds(points, { padding: [40, 40], maxZoom: 16 });
    }
  }

  function rideButton(label, status, style) {
    return el(
      'button',
      {
        class: 'btn ' + style,
        type: 'button',
        style: 'grid-column: span 2; padding: 14px',
        onclick: (e) => {
          e.currentTarget.disabled = true;
          socket.emit('ride:status', { rideId: ride.id, status }, (res) => {
            if (!res.ok) {
              UI.toast(res.error, 'error');
              renderRide();
            }
          });
        },
      },
      label
    );
  }

  /** Semnal sonor + vibrație la o cursă nouă. */
  function alertDriver() {
    $('ride-card').classList.remove('flash');
    void $('ride-card').offsetWidth;
    $('ride-card').classList.add('flash');
    if (navigator.vibrate) navigator.vibrate([300, 150, 300, 150, 300]);
    if (!audio) return;
    try {
      const now = audio.currentTime;
      [0, 0.25, 0.5].forEach((offset) => {
        const osc = audio.createOscillator();
        const gain = audio.createGain();
        osc.frequency.value = 880;
        gain.gain.setValueAtTime(0.25, now + offset);
        gain.gain.exponentialRampToValueAtTime(0.001, now + offset + 0.2);
        osc.connect(gain).connect(audio.destination);
        osc.start(now + offset);
        osc.stop(now + offset + 0.2);
      });
    } catch {
      // Sunetul e opțional.
    }
  }

  function unlockAudio() {
    // Browserele permit sunet doar după o interacțiune a utilizatorului.
    try {
      if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)();
      if (audio.state === 'suspended') audio.resume();
    } catch {
      audio = null;
    }
  }

  // ---------- GPS ----------

  function startGps() {
    $('gps-error').textContent = '';
    if (!('geolocation' in navigator)) {
      $('gps-error').textContent = 'Acest browser nu suportă localizarea.';
      return;
    }
    if (!window.isSecureContext) {
      $('gps-error').textContent =
        'Locația funcționează doar pe o adresă HTTPS (sau localhost). Cereți administratorului adresa securizată.';
      return;
    }
    watchId = navigator.geolocation.watchPosition(onPosition, onGpsError, {
      enableHighAccuracy: true,
      maximumAge: 5000,
      timeout: 20000,
    });
    saveGpsPreference(true);
    requestWakeLock();
    $('gps-toggle').textContent = 'Oprește GPS';
    $('gps-toggle').classList.replace('btn-primary', 'btn-dark');
    $('gps-info').textContent = 'Se caută semnal…';
  }

  function stopGps() {
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    watchId = null;
    saveGpsPreference(false);
    if (wakeLock) wakeLock.release().catch(() => {});
    wakeLock = null;
    $('gps-toggle').textContent = 'Pornește GPS';
    $('gps-toggle').classList.replace('btn-dark', 'btn-primary');
    $('gps-info').textContent = 'Oprită';
  }

  function onPosition(pos) {
    const c = pos.coords;
    lastFix = {
      lat: c.latitude,
      lng: c.longitude,
      accuracy: c.accuracy,
      speed: typeof c.speed === 'number' && !Number.isNaN(c.speed) ? c.speed : null,
      heading: typeof c.heading === 'number' && !Number.isNaN(c.heading) && c.speed > 0.5 ? c.heading : null,
      ts: Date.now(),
    };
    $('gps-error').textContent = '';
    showOwnPosition();
    if (Date.now() - lastSentAt >= SEND_INTERVAL_MS) sendLocation(false);
  }

  function onGpsError(err) {
    const messages = {
      1: 'Accesul la locație a fost refuzat. Permiteți locația pentru acest site din setările browserului.',
      2: 'Locația nu este disponibilă. Verificați că GPS-ul telefonului este pornit.',
      3: 'Semnalul GPS întârzie… se reîncearcă.',
    };
    $('gps-error').textContent = messages[err.code] || 'Eroare GPS: ' + err.message;
    if (err.code === 1) stopGps();
  }

  function sendLocation(force) {
    if (!lastFix || !socket || !socket.connected) return;
    if (!force && watchId === null) return;
    lastSentAt = Date.now();
    const { lat, lng, accuracy, speed, heading } = lastFix;
    socket.emit('location', { lat, lng, accuracy, speed, heading });
    $('gps-info').textContent =
      'Transmisă ' + UI.formatTime(lastSentAt) + (accuracy ? ' · precizie ±' + Math.round(accuracy) + ' m' : '');
  }

  function heartbeat() {
    // O poziție mai veche de 2 minute nu o mai retrimitem ca fiind actuală (ex. semnal pierdut în tunel).
    const fresh = lastFix && Date.now() - lastFix.ts < 2 * 60 * 1000;
    if (watchId !== null && fresh && Date.now() - lastSentAt >= HEARTBEAT_MS) sendLocation(false);
  }

  function showOwnPosition() {
    if (!map) return;
    const latlng = [lastFix.lat, lastFix.lng];
    if (!carMarker) {
      carMarker = L.marker(latlng, { icon: UI.carIcon(null) }).addTo(map);
    } else {
      UI.animateMarker(carMarker, lastFix.lat, lastFix.lng, 600);
    }
    UI.styleCarMarker(carMarker, car ? car.status : 'free', lastFix);
    if (!centeredOnce) {
      centeredOnce = true;
      map.setView(latlng, 16);
    } else if (!map.getBounds().contains(latlng)) {
      map.panTo(latlng);
    }
  }

  async function requestWakeLock() {
    // Ține ecranul aprins ca browserul să nu oprească transmiterea locației.
    try {
      if ('wakeLock' in navigator && !wakeLock) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => (wakeLock = null));
      }
    } catch {
      wakeLock = null;
    }
  }

  // ---------- Memorare locală ----------

  function readCredentials() {
    try {
      const value = JSON.parse(localStorage.getItem(CREDENTIALS_KEY));
      return value && value.carId && value.pin ? value : null;
    } catch {
      return null;
    }
  }

  function saveCredentials(value) {
    try {
      localStorage.setItem(CREDENTIALS_KEY, JSON.stringify(value));
    } catch {
      // Fără memorare: șoferul se va autentifica din nou la reîncărcare.
    }
  }

  function clearCredentials() {
    try {
      localStorage.removeItem(CREDENTIALS_KEY);
      localStorage.removeItem(GPS_ON_KEY);
    } catch {
      // ignorat
    }
  }

  function readGpsPreference() {
    try {
      return localStorage.getItem(GPS_ON_KEY) === '1';
    } catch {
      return false;
    }
  }

  function saveGpsPreference(on) {
    try {
      if (on) localStorage.setItem(GPS_ON_KEY, '1');
      else localStorage.removeItem(GPS_ON_KEY);
    } catch {
      // ignorat
    }
  }
})();
