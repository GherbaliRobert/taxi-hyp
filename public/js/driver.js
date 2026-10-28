// Pagina șoferului: transmite poziția GPS a telefonului și primește cursele de la dispecerat.
// Același cod rulează în browser și în aplicația Android (mobile/). În aplicație, poziția se
// transmite și cu ecranul stins, prin pluginurile native (GPS în fundal, HTTP nativ, notificări).
(function () {
  const UI = window.TaxiUI;
  const { el } = UI;
  const $ = (id) => document.getElementById(id);

  const NATIVE = Boolean(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  const Cap = NATIVE ? window.capacitorExports : null;
  const BackgroundGeolocation = NATIVE ? Cap.registerPlugin('BackgroundGeolocation') : null;
  const LocalNotifications = NATIVE ? Cap.registerPlugin('LocalNotifications') : null;
  const AppState = NATIVE ? Cap.registerPlugin('App') : null;

  const CREDENTIALS_KEY = 'taxi.driver';
  const GPS_ON_KEY = 'taxi.driver.gps';
  const SERVER_KEY = 'taxi.server';
  const RIDE_CHANNEL = 'curse';
  // În browser poziția pleacă prin WebSocket la fiecare secundă.
  const SEND_INTERVAL_MS = 1000;
  // Telefonul nu raportează poziții noi când mașina stă pe loc; retrimitem ca dispeceratul să știe că suntem activi.
  const HEARTBEAT_MS = 15000;
  // În aplicație poziția pleacă prin HTTP: la 2 s în mers, cel puțin la 10 s pe loc. Răspunsul
  // aduce și cursa curentă, deci o cursă nouă se află în cel mult ~10 s, chiar din fundal.
  const NATIVE_MOVING_INTERVAL_MS = 2000;
  const NATIVE_IDLE_INTERVAL_MS = 10000;
  const NATIVE_MIN_MOVE_M = 5;

  let config;
  let serverUrl = NATIVE ? storageGet(SERVER_KEY) || (window.TAXI_APP && window.TAXI_APP.serverUrl) || '' : '';
  let session = null; // { carId, token, plate }
  let socket;
  let car = null;
  let ride = null;
  let gpsOn = false;
  let watchId = null; // browser
  let watcherId = null; // aplicație
  let wakeLock = null;
  let lastFix = null;
  let lastSent = null;
  let lastSentAt = 0;
  let sending = false;
  let appActive = true;
  let map;
  let carMarker = null;
  let pickupMarker = null;
  let centeredOnce = false;
  let audio = null;
  // Comenzile oferite acum acestei mașini (id comandă -> ofertă), și cea pe care tocmai o acceptăm.
  const offers = new Map();
  let accepting = null;
  let offerPins = [];
  let shownOffers = '';

  init().catch((err) => {
    console.error(err);
    UI.toast('Eroare la pornire: ' + err.message, 'error');
  });

  async function init() {
    $('login-form').addEventListener('submit', (e) => {
      e.preventDefault();
      unlockAudio();
      login($('car-select').value, $('pin').value);
    });
    $('server-form').addEventListener('submit', (e) => {
      e.preventDefault();
      setServer($('server-url').value);
    });
    $('change-server').addEventListener('click', () => showServerStep());
    $('logout').addEventListener('click', logout);
    // Secundele rămase pentru a accepta comenzile.
    setInterval(updateOfferCountdowns, 1000);
    $('gps-toggle').addEventListener('click', () => {
      unlockAudio();
      if (gpsOn) stopGps();
      else startGps();
    });
    document.querySelectorAll('#status-toggle button').forEach((btn) =>
      btn.addEventListener('click', () => setStatus(btn.dataset.status))
    );

    if (NATIVE) {
      document.body.classList.add('native-app');
      setGpsUi(false, 'Oprită');
      $('gps-hint').textContent =
        'Locația se transmite și cu ecranul stins sau când folosiți alte aplicații (ex. Waze). ' +
        'Cât timp tura este activă, în bara de notificări apare „Tură activă”.';
      AppState.addListener('appStateChange', ({ isActive }) => {
        appActive = isActive;
        if (isActive && session) refreshState();
      });
      LocalNotifications.createChannel({
        id: RIDE_CHANNEL,
        name: 'Curse noi',
        description: 'Cursele primite de la dispecerat',
        importance: 5,
        visibility: 1,
        vibration: true,
      }).catch(() => {});
      if (!serverUrl) return showServerStep();
    } else {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && gpsOn) requestWakeLock();
      });
      setInterval(heartbeat, 5000);
    }
    await start();
  }

  async function start() {
    config = await loadConfig();
    document.querySelectorAll('.company-name').forEach((n) => (n.textContent = config.companyName));
    session = await restoreSession();
    if (session) connect();
    else showLogin();
  }

  // ---------- Comunicarea cu serverul ----------

  /** Cerere către server; în aplicație prin HTTP nativ (merge și din fundal, fără restricții CORS). */
  async function request(method, path, body, token) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    if (NATIVE) {
      const res = await Cap.CapacitorHttp.request({
        url: serverUrl + path,
        method,
        headers,
        data: body,
        connectTimeout: 10000,
        readTimeout: 10000,
      });
      let data = res.data;
      if (typeof data === 'string') {
        try {
          data = JSON.parse(data);
        } catch {
          data = null;
        }
      }
      return { status: res.status, data };
    }
    const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, data: await res.json().catch(() => null) };
  }

  async function loadConfig() {
    const res = await request('GET', '/api/config');
    if (res.status !== 200 || !res.data) throw new Error('Serverul nu răspunde');
    return res.data;
  }

  // ---------- Serverul (doar în aplicație) ----------

  function showServerStep(error) {
    $('app').hidden = true;
    $('login').hidden = false;
    $('login-form').hidden = true;
    $('server-form').hidden = false;
    $('server-url').value = serverUrl;
    $('server-error').textContent = error || '';
  }

  async function setServer(value) {
    let url = value.trim().replace(/\/+$/, '');
    if (url && !/^https?:\/\//.test(url)) url = 'https://' + url;
    if (!/^https:\/\/[^/]+$/.test(url)) {
      $('server-error').textContent = 'Introduceți adresa serverului, ex. https://taxi.firma-mea.ro';
      return;
    }
    const previous = serverUrl;
    serverUrl = url;
    try {
      await loadConfig();
    } catch {
      serverUrl = previous;
      $('server-error').textContent = 'Serverul nu răspunde la această adresă. Verificați adresa și conexiunea la internet.';
      return;
    }
    if (url !== previous) clearCredentials();
    storageSet(SERVER_KEY, url);
    $('server-form').hidden = true;
    $('login-form').hidden = false;
    await start();
  }

  // ---------- Autentificare și conexiune ----------

  async function showLogin(error) {
    $('app').hidden = true;
    $('login').hidden = false;
    $('server-form').hidden = true;
    $('login-form').hidden = false;
    $('login-error').textContent = error || '';
    $('server-name').textContent = NATIVE ? serverUrl.replace(/^https:\/\//, '') : '';
    const select = $('car-select');
    if (!select.options.length) {
      try {
        const { data } = await request('GET', '/api/cars');
        select.replaceChildren(...data.map((c) => el('option', { value: c.id }, c.plate + (c.model ? ' · ' + c.model : ''))));
      } catch {
        $('login-error').textContent = 'Nu s-a putut încărca lista de mașini.';
      }
    }
  }

  async function login(carId, pin) {
    $('login-error').textContent = '';
    const device = NATIVE ? 'Aplicația Android' : 'Browser';
    let res;
    try {
      res = await request('POST', '/api/driver/login', { carId, pin, device });
    } catch {
      $('login-error').textContent = 'Serverul nu răspunde. Verificați conexiunea la internet.';
      return;
    }
    if (res.status !== 200) {
      $('login-error').textContent = (res.data && res.data.error) || 'Autentificarea nu a reușit';
      return;
    }
    // Pe telefon se păstrează doar tokenul de sesiune, nu și PIN-ul.
    session = { carId: res.data.car.id, token: res.data.token, plate: res.data.car.plate };
    saveCredentials(session);
    $('pin').value = '';
    connect();
  }

  /** Sesiunea salvată; cei autentificați cu versiunea veche (PIN salvat) primesc automat un token. */
  async function restoreSession() {
    const saved = readCredentials();
    if (!saved) return null;
    if (saved.token) return saved;
    if (saved.carId && saved.pin) {
      try {
        const res = await request('POST', '/api/driver/login', { carId: saved.carId, pin: saved.pin, device: 'Browser' });
        if (res.status === 200) {
          const upgraded = { carId: res.data.car.id, token: res.data.token, plate: res.data.car.plate };
          saveCredentials(upgraded);
          return upgraded;
        }
      } catch {
        // rămâne ecranul de autentificare
      }
    }
    clearCredentials();
    return null;
  }

  /** Sesiunea nu mai e valabilă (PIN schimbat, mașină dezactivată, ieșire de pe alt telefon). */
  function sessionEnded(message) {
    if (socket) socket.disconnect();
    stopGps();
    clearCredentials();
    session = null;
    notify(9001, 'Tura a fost închisă', message);
    showLogin(message);
  }

  function connect() {
    if (socket) socket.disconnect();
    const options = { auth: { role: 'driver', token: session.token } };
    // În aplicație: direct WebSocket către server (fără cereri HTTP din pagină, deci fără CORS).
    socket = NATIVE ? io(serverUrl, { ...options, transports: ['websocket'] }) : io(options);
    UI.setConnection($('conn'), 'connecting');

    socket.on('connect', () => {
      UI.setConnection($('conn'), 'online');
      showApp();
      // Trimitem imediat ultima poziție cunoscută, ca mașina să apară pe hartă fără întârziere.
      if (lastFix) sendLocation(true);
    });
    socket.on('disconnect', (reason) => {
      UI.setConnection($('conn'), 'offline');
      if (reason === 'io server disconnect') {
        sessionEnded('Sesiunea a fost închisă de dispecerat (PIN schimbat sau mașină dezactivată). Intrați din nou.');
      }
    });
    socket.on('connect_error', (err) => {
      if (err.message === 'unauthorized') {
        sessionEnded('Sesiunea a expirat sau PIN-ul a fost schimbat. Intrați din nou.');
      } else {
        UI.setConnection($('conn'), 'offline');
      }
    });

    socket.on('driver:init', (data) => {
      car = data.car;
      setRide(data.ride, false);
      setOffers(data.offers || [], true);
      renderStatus();
    });
    socket.on('offer:new', (offer) => addOffer(offer, true));
    socket.on('offer:gone', ({ rideId, reason }) => removeOffer(rideId, reason));
    socket.on('car:update', (data) => {
      car = data;
      renderStatus();
    });
    socket.on('ride:update', (data) => setRide(data, true));
  }

  function showApp() {
    $('login').hidden = true;
    $('app').hidden = false;
    if (!map) map = UI.createMap($('map'), config);
    map.invalidateSize();
    if (!gpsOn && readGpsPreference()) startGps();
  }

  async function logout() {
    if (ride && !confirm('Aveți o cursă activă. Sigur ieșiți?')) return;
    await stopGps();
    if (session) request('POST', '/api/driver/logout', {}, session.token).catch(() => {});
    clearCredentials();
    if (socket) socket.disconnect();
    location.reload();
  }

  /** Aplicația revine în prim-plan: aducem starea la zi (WebSocket-ul poate fi fost întrerupt). */
  async function refreshState() {
    try {
      const res = await request('GET', '/api/driver/state', undefined, session.token);
      if (res.status === 401) return sessionEnded('Sesiunea a expirat. Intrați din nou.');
      if (res.status === 200) applyServerState(res.data);
    } catch {
      // fără rețea: se reîncearcă la următoarea poziție
    }
  }

  /** Starea primită prin HTTP (cu aplicația în fundal WebSocket-ul poate lipsi). */
  function applyServerState(state) {
    if (car) {
      car = { ...car, status: state.car.status, rideId: state.car.rideId };
      renderStatus();
    }
    if (state.offers) setOffers(state.offers, true);
    // `state.ride` este cursa activă sau ultima încheiată recent (ex. anulată de dispecer).
    const incoming = state.ride;
    if (!incoming) {
      if (ride) setRide(null, true);
      return;
    }
    const incomingFinished = incoming.status === 'completed' || incoming.status === 'cancelled';
    if (!ride && incomingFinished) return;
    if (!ride || ride.id !== incoming.id || ride.status !== incoming.status) setRide(incoming, true);
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
        notify(Number(data.id), 'Cursa #' + data.id + ' a fost anulată', 'Anulată de dispecerat.');
      }
      ride = null;
    } else {
      const isNew = !ride || ride.id !== data.id;
      ride = data;
      offers.delete(data.id);
      // O cursă primită fără ca șoferul s-o fi acceptat chiar acum (ex. reluată după repornire).
      if (isNew && fromUpdate && data.id !== accepting) {
        alertDriver();
        notify(Number(data.id), 'Cursă nouă #' + data.id, (data.address || 'Punct pe hartă') + ' · ' + data.customerName);
      }
    }
    renderRide();
    renderOffers();
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

    // replaceChildren() ar afișa „null” pentru câmpurile lipsă, așa că le filtrăm.
    const content = [
      el('div', { class: 'gps-line' }, el('h2', {}, 'Cursa #' + ride.id), el('span', { class: 'badge', dataset: { status: ride.status } }, UI.RIDE_STATUS_LABELS[ride.status])),
      el('div', { class: 'address' }, ride.address || 'Punct pe hartă: ' + lat.toFixed(5) + ', ' + lng.toFixed(5)),
      el('div', {}, 'Client: ', el('strong', {}, ride.customerName)),
      ride.phone ? el('div', {}, 'Telefon: ', el('a', { href: 'tel:' + ride.phone }, ride.phone)) : null,
      ride.notes ? el('div', {}, 'Observații: ' + ride.notes) : null,
      navigation,
      el('div', { class: 'grid' }, buttons),
    ];
    card.replaceChildren(...content.filter(Boolean));
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
        onclick: async (e) => {
          e.currentTarget.disabled = true;
          try {
            const res = await request('POST', '/api/driver/rides/' + encodeURIComponent(ride.id) + '/status', { status }, session.token);
            if (res.status === 401) return sessionEnded('Sesiunea a expirat. Intrați din nou.');
            if (res.status !== 200) UI.toast((res.data && res.data.error) || 'Eroare', 'error');
            if (res.data && res.data.car) applyServerState(res.data);
            else renderRide();
          } catch {
            UI.toast('Fără conexiune la server — încercați din nou', 'error');
            renderRide();
          }
        },
      },
      label
    );
  }

  // ---------- Comenzi oferite: șoferul le acceptă sau le refuză ----------

  /** Lista completă de la server (la conectare sau din răspunsul HTTP); anunță comenzile noi. */
  function setOffers(list, announce) {
    const incoming = new Map(list.map((o) => [o.rideId, o]));
    for (const id of [...offers.keys()]) if (!incoming.has(id)) offers.delete(id);
    for (const offer of list) addOffer(offer, announce, false);
    renderOffers();
  }

  function addOffer(offer, announce, render = true) {
    if (offers.has(offer.rideId) || (ride && ride.id === offer.rideId)) return;
    offers.set(offer.rideId, offer);
    if (announce) {
      alertDriver();
      const where = (offer.address || 'Punct pe hartă') + (offer.distanceM !== null ? ' · la ' + Geo.formatDistance(offer.distanceM) : '');
      notify(Number(offer.rideId), 'Comandă nouă', where + '. Deschideți aplicația ca s-o acceptați.');
    }
    if (render) renderOffers();
  }

  function removeOffer(rideId, reason) {
    if (!offers.delete(rideId)) return;
    if (reason === 'taken' && accepting !== rideId) UI.toast('Comanda a fost preluată de alt coleg');
    if (reason === 'withdrawn') UI.toast('Comanda a fost anulată de dispecerat');
    renderOffers();
  }

  function renderOffers() {
    const box = $('offers');
    const now = Date.now();
    const list = [...offers.values()].filter((o) => o.expiresAt > now).sort((a, b) => a.offeredAt - b.offeredAt);
    box.replaceChildren(...list.map(offerCard));
    // Pe hartă: unde sunt clienții care așteaptă.
    offerPins.forEach((pin) => pin.remove());
    offerPins = map && !ride ? list.map((o) => L.marker([o.pickup.lat, o.pickup.lng], { icon: UI.pickupIcon('pending') }).addTo(map)) : [];
    // Harta se reîncadrează doar când apare sau dispare o comandă, nu la fiecare actualizare.
    const key = list.map((o) => o.rideId).join(',');
    if (map && !ride && list.length && key !== shownOffers) {
      const points = list.map((o) => [o.pickup.lat, o.pickup.lng]);
      if (carMarker) points.push(carMarker.getLatLng());
      map.fitBounds(points, { padding: [40, 40], maxZoom: 16 });
    }
    shownOffers = key;
  }

  function offerCard(offer) {
    const total = offer.expiresAt - offer.offeredAt;
    const distance =
      offer.distanceM !== null
        ? 'La ' + Geo.formatDistance(offer.distanceM) + ' de dvs.' + (offer.etaMin ? ' · ajungeți în cca ' + offer.etaMin + ' min' : '')
        : 'Porniți GPS-ul ca să vedeți distanța';
    return el(
      'div',
      { class: 'card offer-card' },
      el('div', { class: 'gps-line' }, el('h2', {}, 'Comandă nouă'), el('span', { class: 'offer-countdown', dataset: { expires: offer.expiresAt } }, secondsLeft(offer.expiresAt))),
      el('div', { class: 'address' }, offer.address || 'Punct pe hartă: ' + offer.pickup.lat.toFixed(5) + ', ' + offer.pickup.lng.toFixed(5)),
      el('div', {}, distance),
      offer.notes ? el('div', {}, 'Observații: ' + offer.notes) : null,
      el('div', { class: 'offer-progress' }, el('span', { dataset: { expires: offer.expiresAt, total }, style: 'width:' + progress(offer.expiresAt, total) + '%' })),
      el(
        'div',
        { class: 'grid' },
        el('button', { class: 'btn btn-accept', type: 'button', onclick: (e) => acceptOffer(offer.rideId, e.currentTarget) }, 'Accept'),
        el('button', { class: 'btn', type: 'button', onclick: () => declineOffer(offer.rideId) }, 'Refuz')
      )
    );
  }

  function secondsLeft(expiresAt) {
    return Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)) + ' s';
  }

  function progress(expiresAt, total) {
    return Math.max(0, Math.min(100, ((expiresAt - Date.now()) / total) * 100));
  }

  function updateOfferCountdowns() {
    if (![...offers.values()].length) return;
    if ([...offers.values()].some((o) => o.expiresAt <= Date.now())) {
      for (const [id, o] of offers) if (o.expiresAt <= Date.now()) offers.delete(id);
      return renderOffers();
    }
    document.querySelectorAll('.offer-countdown[data-expires]').forEach((n) => (n.textContent = secondsLeft(Number(n.dataset.expires))));
    document.querySelectorAll('.offer-progress span').forEach((n) => (n.style.width = progress(Number(n.dataset.expires), Number(n.dataset.total)) + '%'));
  }

  async function acceptOffer(rideId, button) {
    button.disabled = true;
    accepting = rideId;
    try {
      const res = await request('POST', '/api/driver/offers/' + encodeURIComponent(rideId) + '/accept', {}, session.token);
      if (res.status === 401) return sessionEnded('Sesiunea a expirat. Intrați din nou.');
      // Cursa acceptată de dvs. apare fără alarmă; datele clientului sunt vizibile abia acum.
      if (res.data && res.data.ride && res.data.ride.id === rideId) setRide(res.data.ride, false);
      if (res.data && res.data.car) applyServerState(res.data);
      if (res.status === 200) {
        UI.toast('Ați preluat comanda. Clientul primește SMS cu linkul de urmărire.', 'success');
      } else {
        UI.toast((res.data && res.data.error) || 'Comanda nu mai este disponibilă', 'error');
        offers.delete(rideId);
        renderOffers();
      }
    } catch {
      button.disabled = false;
      UI.toast('Fără conexiune la server — încercați din nou', 'error');
    } finally {
      accepting = null;
    }
  }

  async function declineOffer(rideId) {
    offers.delete(rideId);
    renderOffers();
    try {
      await request('POST', '/api/driver/offers/' + encodeURIComponent(rideId) + '/decline', {}, session.token);
    } catch {
      // Fără rețea: oferta expiră oricum la server.
    }
  }

  /** Semnal sonor + vibrație la o cursă nouă (cu aplicația deschisă). */
  function alertDriver() {
    const target = offers.size ? $('offers') : $('ride-card');
    target.classList.remove('flash');
    void target.offsetWidth;
    target.classList.add('flash');
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

  /** Notificare de sistem, doar în aplicație și doar când aceasta nu e pe ecran (ex. în buzunar, în Waze). */
  function notify(id, title, body) {
    if (!NATIVE || appActive) return;
    LocalNotifications.schedule({
      notifications: [{ id: id % 2147483647, title, body, channelId: RIDE_CHANNEL, smallIcon: 'ic_stat_taxi' }],
    }).catch(() => {});
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

  function setGpsUi(on, info) {
    gpsOn = on;
    const toggle = $('gps-toggle');
    toggle.textContent = NATIVE ? (on ? 'Încheie tura' : 'Începe tura') : on ? 'Oprește GPS' : 'Pornește GPS';
    toggle.classList.toggle('btn-dark', on);
    toggle.classList.toggle('btn-primary', !on);
    $('gps-info').textContent = info;
  }

  async function startGps() {
    $('gps-error').textContent = '';
    if (NATIVE) return startNativeGps();
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
    setGpsUi(true, 'Se caută semnal…');
  }

  async function startNativeGps() {
    // Android 13+: fără această permisiune nu apar notificarea turei și cele pentru curse noi.
    try {
      const permission = await LocalNotifications.checkPermissions();
      if (permission.display !== 'granted') await LocalNotifications.requestPermissions();
    } catch {
      // notificările sunt utile, dar nu obligatorii
    }
    setGpsUi(true, 'Se caută semnal…');
    try {
      watcherId = await BackgroundGeolocation.addWatcher(
        {
          backgroundTitle: 'Tură activă' + (session ? ' · ' + session.plate : ''),
          backgroundMessage: 'Locația se transmite dispeceratului. Atingeți pentru a deschide aplicația.',
          requestPermissions: true,
          stale: false,
          distanceFilter: 0,
        },
        (location, error) => {
          if (error) return onNativeGpsError(error);
          onPosition({
            coords: {
              latitude: location.latitude,
              longitude: location.longitude,
              accuracy: location.accuracy,
              speed: location.speed,
              heading: location.bearing,
            },
          });
        }
      );
      saveGpsPreference(true);
    } catch (err) {
      setGpsUi(false, 'Oprită');
      $('gps-error').textContent = 'GPS-ul nu a putut porni: ' + err.message;
    }
  }

  function onNativeGpsError(error) {
    if (error.code === 'NOT_AUTHORIZED') {
      stopGps();
      $('gps-error').replaceChildren(
        'Aplicația nu are acces la locație. ',
        el('button', { class: 'btn btn-sm', type: 'button', onclick: () => BackgroundGeolocation.openSettings() }, 'Deschide setările')
      );
    } else {
      $('gps-error').textContent = 'Eroare GPS: ' + error.message;
    }
  }

  async function stopGps() {
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    watchId = null;
    if (watcherId !== null) {
      const id = watcherId;
      watcherId = null;
      await BackgroundGeolocation.removeWatcher({ id }).catch(() => {});
    }
    saveGpsPreference(false);
    if (wakeLock) wakeLock.release().catch(() => {});
    wakeLock = null;
    setGpsUi(false, 'Oprită');
  }

  function onPosition(pos) {
    const c = pos.coords;
    const speed = typeof c.speed === 'number' && !Number.isNaN(c.speed) ? c.speed : null;
    lastFix = {
      lat: c.latitude,
      lng: c.longitude,
      accuracy: c.accuracy,
      speed,
      heading: typeof c.heading === 'number' && !Number.isNaN(c.heading) && speed > 0.5 ? c.heading : null,
      ts: Date.now(),
    };
    $('gps-error').textContent = '';
    showOwnPosition();
    if (NATIVE) sendNativeLocation();
    else if (Date.now() - lastSentAt >= SEND_INTERVAL_MS) sendLocation(false);
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

  function showSent(ts) {
    $('gps-info').textContent =
      'Transmisă ' + UI.formatTime(ts) + (lastFix.accuracy ? ' · precizie ±' + Math.round(lastFix.accuracy) + ' m' : '');
  }

  /** Browser: poziția pleacă prin WebSocket. */
  function sendLocation(force) {
    if (NATIVE) return sendNativeLocation(force);
    if (!lastFix || !socket || !socket.connected) return;
    if (!force && !gpsOn) return;
    lastSentAt = Date.now();
    const { lat, lng, accuracy, speed, heading } = lastFix;
    socket.emit('location', { lat, lng, accuracy, speed, heading });
    showSent(lastSentAt);
  }

  /** Aplicație: poziția pleacă prin HTTP nativ, care nu e încetinit de Android când aplicația e în fundal. */
  async function sendNativeLocation(force) {
    if (!lastFix || !session || sending) return;
    const now = Date.now();
    const moved = lastSent ? Geo.distanceMeters(lastSent, lastFix) : Infinity;
    const due =
      force ||
      (now - lastSentAt >= NATIVE_MOVING_INTERVAL_MS && moved >= NATIVE_MIN_MOVE_M) ||
      now - lastSentAt >= NATIVE_IDLE_INTERVAL_MS;
    if (!due) return;

    sending = true;
    const fix = lastFix;
    try {
      const { lat, lng, accuracy, speed, heading } = fix;
      const res = await request('POST', '/api/driver/location', { lat, lng, accuracy, speed, heading }, session.token);
      if (res.status === 401) return sessionEnded('Sesiunea a fost închisă (PIN schimbat sau mașină dezactivată). Intrați din nou.');
      if (res.status === 200) {
        lastSent = fix;
        lastSentAt = now;
        showSent(now);
        applyServerState(res.data);
      }
    } catch {
      $('gps-info').textContent = 'Fără conexiune la server — se reîncearcă…';
    } finally {
      sending = false;
    }
  }

  function heartbeat() {
    // O poziție mai veche de 2 minute nu o mai retrimitem ca fiind actuală (ex. semnal pierdut în tunel).
    const fresh = lastFix && Date.now() - lastFix.ts < 2 * 60 * 1000;
    if (gpsOn && fresh && Date.now() - lastSentAt >= HEARTBEAT_MS) sendLocation(false);
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
    // Browser: ține ecranul aprins ca acesta să nu oprească transmiterea locației.
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

  function storageGet(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  function storageSet(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // Fără memorare: datele se cer din nou la următoarea pornire.
    }
  }

  function readCredentials() {
    try {
      const value = JSON.parse(storageGet(CREDENTIALS_KEY));
      return value && value.carId && (value.token || value.pin) ? value : null;
    } catch {
      return null;
    }
  }

  function saveCredentials(value) {
    storageSet(CREDENTIALS_KEY, JSON.stringify(value));
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
    return storageGet(GPS_ON_KEY) === '1';
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
