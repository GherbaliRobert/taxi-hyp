// Dispecerat: toate mașinile în timp real pe hartă, cursele active și formularul de cursă nouă.
(function () {
  const UI = window.TaxiUI;
  const { el } = UI;
  const $ = (id) => document.getElementById(id);

  const STATUS_ORDER = { free: 0, busy: 1, offline: 2 };
  const PICKUP_VISIBLE = new Set(['pending', 'assigned', 'arrived']);
  const ACTIVE_RIDE = new Set(['pending', 'assigned', 'arrived', 'in_progress']);
  const LINK_ACTIVE = new Set(['assigned', 'arrived', 'in_progress']);
  // Răspunsurile șoferilor la o comandă.
  const OFFER_LABELS = { accepted: 'a acceptat', declined: 'a refuzat', expired: 'nu a răspuns', taken: 'preluată de altul', withdrawn: 'retrasă' };
  const TRAIL_LENGTH = 30;
  const NOMINATIM = 'https://nominatim.openstreetmap.org';

  let config;
  let map;
  let socket;
  let activeTab = 'cars';
  let selectedCarId = null;
  let fittedOnce = false;

  // id -> { data, marker, trail, row }
  const cars = new Map();
  // id -> cursa (vederea pentru dispecerat)
  const rides = new Map();
  // id cursă -> { pin, line } pentru clienții care așteaptă mașina
  const rideLayers = new Map();

  // Formularul de cursă nouă.
  let pickup = null;
  let draftMarker = null;
  let addressWasAutoFilled = false;
  // Locul de preluare ales de dispecer pe hartă (asistentul vocal nu îl mai mută).
  let pickupFromMap = false;

  // Asistentul vocal: câmpurile scrise de mână de dispecer nu mai sunt completate automat.
  let voice = null;
  const typedFields = new Set();
  let voiceSearchTimer = null;

  let mapVisible = false;

  init().catch((err) => {
    console.error(err);
    UI.toast('Eroare la pornire: ' + err.message, 'error');
  });

  async function init() {
    config = await UI.loadConfig();
    document.title = 'Dispecerat · ' + config.companyName;
    document.querySelectorAll('.company-name').forEach((n) => (n.textContent = config.companyName));

    document.querySelectorAll('.tab').forEach((tab) =>
      tab.addEventListener('click', () => setTab(tab.dataset.tab))
    );
    $('ride-form').addEventListener('submit', submitRide);
    $('geocode').addEventListener('click', () => searchAddress());
    setupVoice();
    $('ride-address').addEventListener('input', () => (addressWasAutoFilled = false));
    $('ride-address').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        searchAddress();
      }
    });

    // Timpii „acum X s” și starea „fără semnal” se recalculează periodic.
    setInterval(refreshTimes, 5000);
    // Secundele rămase pentru acceptarea comenzilor.
    setInterval(updateCountdowns, 1000);

    UI.requireDispatcher(start, () => {
      mapVisible = true;
      map.invalidateSize();
      if (!fittedOnce) fitToCars();
    });
  }

  async function start() {
    // Harta se creează înainte de conectare, ca primele mașini primite să aibă unde apărea.
    map = UI.createMap($('map'), config);
    map.on('click', (e) => {
      if (activeTab !== 'new') return;
      pickupFromMap = true;
      setPickup(e.latlng.lat, e.latlng.lng, true);
    });
    await connect();
  }

  // ---------- Conectare ----------

  /** Conexiunea live; sesiunea e cookie-ul pus la autentificare. Se rezolvă la prima conectare. */
  function connect() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (fn, value) => {
        if (!settled) {
          settled = true;
          fn(value);
        }
      };
      // Dacă rețeaua blochează conexiunea live, afișăm totuși pagina (indicatorul arată „Deconectat”).
      setTimeout(() => settle(resolve), 5000);

      socket = io({ auth: { role: 'dispatcher' } });
      UI.setConnection($('conn'), 'connecting');
      socket.on('connect', () => {
        UI.setConnection($('conn'), 'online');
        settle(resolve);
      });
      socket.on('disconnect', (reason) => {
        UI.setConnection($('conn'), 'offline');
        // Serverul a închis sesiunea: ieșire, cont dezactivat sau parolă schimbată.
        if (reason === 'io server disconnect') UI.sessionLost();
      });
      socket.on('connect_error', (err) => {
        if (err.message === 'unauthorized' || err.message === 'password_change_required') {
          socket.disconnect();
          if (settled) UI.sessionLost();
          else settle(reject, Object.assign(new Error('Sesiunea a expirat'), { status: 401 }));
        } else {
          UI.setConnection($('conn'), 'offline');
        }
      });

      socket.on('fleet:snapshot', onSnapshot);
      socket.on('car:update', onCarUpdate);
      socket.on('ride:update', onRideUpdate);
    });
  }

  function fitToCars() {
    const points = [...cars.values()].filter((e) => e.data.position).map((e) => [e.data.position.lat, e.data.position.lng]);
    if (!points.length) return;
    fittedOnce = true;
    if (points.length > 1) map.fitBounds(points, { padding: [60, 60], maxZoom: 15 });
    else map.setView(points[0], 15);
  }

  // ---------- Mașini ----------

  function onSnapshot({ cars: carList, rides: rideList }) {
    // La reconectare: mașinile dezactivate între timp nu mai apar în listă.
    const ids = new Set(carList.map((c) => c.id));
    for (const id of [...cars.keys()]) if (!ids.has(id)) removeCar(id);
    for (const car of carList) upsertCar(car);
    rides.clear();
    for (const ride of rideList) rides.set(ride.id, ride);
    renderCarList();
    renderRides();
    syncRideLayers();
    if (!fittedOnce && mapVisible) fitToCars();
  }

  function onCarUpdate(car) {
    if (car.active === false) {
      removeCar(car.id);
      renderCarList();
      if (activeTab === 'new') refreshTargetSelect();
      return;
    }
    const prev = upsertCar(car);
    // GPS-ul e obligatoriu: dispecerul află imediat când o mașină conectată îl pierde.
    if (prev && prev.gpsOk && !car.gpsOk && car.status !== 'offline') {
      UI.toast(
        car.plate + ' (' + car.driver + '): GPS oprit' + (car.rideId ? ' în timpul cursei #' + car.rideId : ' — nu primește comenzi'),
        'error'
      );
    }
    if (!prev || prev.status !== car.status || prev.rideId !== car.rideId || prev.gpsOk !== car.gpsOk) {
      renderCarList();
      if (activeTab === 'new') refreshTargetSelect();
    } else {
      updateCarRow(cars.get(car.id));
    }
    if (car.rideId) syncRideLayers();
  }

  /** Creează sau actualizează markerul și traseul unei mașini; întoarce datele anterioare. */
  function upsertCar(car) {
    let entry = cars.get(car.id);
    const prev = entry ? entry.data : null;
    if (!entry) {
      entry = {
        data: car,
        marker: null,
        trail: L.polyline([], { weight: 3, opacity: 0.45, interactive: false }).addTo(map),
        row: null,
      };
      cars.set(car.id, entry);
    }
    entry.data = car;

    const pos = car.position;
    if (car.trail) {
      entry.trail.setLatLngs(car.trail);
    } else if (pos && (!prev || !prev.position || prev.position.ts !== pos.ts)) {
      const points = entry.trail.getLatLngs();
      points.push(L.latLng(pos.lat, pos.lng));
      entry.trail.setLatLngs(points.slice(-TRAIL_LENGTH));
    }
    entry.trail.setStyle({ color: statusColor(car.status) });

    if (pos) {
      if (!entry.marker) {
        entry.marker = L.marker([pos.lat, pos.lng], { icon: UI.carIcon(car.plate), riseOnHover: true })
          .addTo(map)
          .bindPopup(() => carPopup(cars.get(car.id).data), { offset: [0, -12] });
        entry.marker.on('click', () => selectCar(car.id, false));
      } else if (!prev || !prev.position || prev.position.ts !== pos.ts) {
        UI.animateMarker(entry.marker, pos.lat, pos.lng);
      }
      UI.styleCarMarker(entry.marker, car.status, pos);
      entry.marker.setZIndexOffset(car.status === 'offline' ? -1000 : 0);
      if (entry.marker.isPopupOpen()) entry.marker.setPopupContent(carPopup(car));
    }
    return prev;
  }

  function removeCar(id) {
    const entry = cars.get(id);
    if (!entry) return;
    if (entry.marker) entry.marker.remove();
    entry.trail.remove();
    cars.delete(id);
    if (selectedCarId === id) selectedCarId = null;
  }

  /** Mașină conectată, dar fără poziții GPS recente: nu primește comenzi. */
  function noGps(car) {
    return car.status !== 'offline' && (!car.gpsOk || UI.isStale(car.position));
  }

  function statusColor(status) {
    return { free: '#16a34a', busy: '#ea580c' }[status] || '#9aa1ac';
  }

  function carPopup(car) {
    const pos = car.position;
    const speed = pos && typeof pos.speed === 'number' ? Math.round(pos.speed * 3.6) + ' km/h' : '—';
    return el(
      'div',
      {},
      el('strong', {}, car.plate),
      el('div', {}, car.driver + (car.model ? ' · ' + car.model : '')),
      el('div', {}, 'Status: ' + UI.CAR_STATUS_LABELS[car.status] + (car.rideId ? ' (cursa #' + car.rideId + ')' : '')),
      noGps(car) ? el('div', { class: 'error-text' }, 'GPS oprit: nu primește comenzi') : null,
      el('div', {}, 'Viteză: ' + speed),
      el('div', {}, 'Ultima poziție: ' + (pos ? UI.timeAgo(pos.ts) : 'niciodată'))
    );
  }

  function renderCarList() {
    const list = [...cars.values()].sort(
      (a, b) =>
        STATUS_ORDER[a.data.status] - STATUS_ORDER[b.data.status] ||
        a.data.plate.localeCompare(b.data.plate)
    );
    const counts = { free: 0, busy: 0, offline: 0, noGps: 0 };
    const items = list.map((entry) => {
      // „Libere” = pot primi comenzi acum; cele fără GPS se numără separat.
      if (entry.data.status === 'free' && noGps(entry.data)) counts.noGps += 1;
      else counts[entry.data.status] += 1;
      if (entry.data.status === 'busy' && noGps(entry.data)) counts.noGps += 1;
      entry.row = buildCarRow(entry);
      return entry.row.root;
    });
    $('car-list').replaceChildren(...items);
    $('sum-free').textContent = counts.free;
    $('sum-busy').textContent = counts.busy;
    $('sum-offline').textContent = counts.offline;
    $('sum-nogps').textContent = counts.noGps;
    $('sum-nogps-item').classList.toggle('warn', counts.noGps > 0);
    $('count-cars').textContent = counts.free + counts.busy;
  }

  function buildCarRow(entry) {
    const car = entry.data;
    const dot = el('span', { class: 'status-dot', dataset: { status: car.status } });
    const badge = el('span', { class: 'badge' });
    const time = el('div', { class: 'hint', style: 'text-align:right' });
    const root = el(
      'li',
      {
        class: 'card car-item' + (car.id === selectedCarId ? ' selected' : ''),
        tabindex: '0',
        onclick: () => selectCar(car.id, true),
        onkeydown: (e) => e.key === 'Enter' && selectCar(car.id, true),
      },
      dot,
      el(
        'div',
        { class: 'info' },
        el('div', { class: 'plate' }, car.plate),
        el('div', { class: 'meta' }, car.driver + (car.model ? ' · ' + car.model : ''))
      ),
      el('div', {}, badge, time)
    );
    const row = { root, badge, time };
    fillCarRow(row, car);
    return row;
  }

  function fillCarRow(row, car) {
    const stale = noGps(car);
    row.badge.dataset.status = car.status;
    row.badge.classList.toggle('stale', stale);
    row.badge.textContent = (stale ? 'Fără GPS' : UI.CAR_STATUS_LABELS[car.status]) + (car.rideId ? ' #' + car.rideId : '');
    row.time.textContent = car.position ? UI.timeAgo(car.position.ts) : 'fără poziție';
  }

  function updateCarRow(entry) {
    if (entry && entry.row) fillCarRow(entry.row, entry.data);
  }

  function refreshTimes() {
    for (const entry of cars.values()) {
      updateCarRow(entry);
      if (entry.marker) UI.styleCarMarker(entry.marker, entry.data.status, entry.data.position);
    }
  }

  function selectCar(carId, panTo) {
    selectedCarId = carId;
    for (const [id, entry] of cars) {
      if (entry.row) entry.row.root.classList.toggle('selected', id === carId);
    }
    const entry = cars.get(carId);
    if (!entry) return;
    if (entry.row) entry.row.root.scrollIntoView({ block: 'nearest' });
    if (panTo) {
      if (entry.marker) {
        map.setView(entry.marker.getLatLng(), Math.max(map.getZoom(), 15));
        entry.marker.openPopup();
      } else {
        UI.toast(entry.data.plate + ' nu a transmis încă nicio poziție.');
      }
    }
  }

  // ---------- Curse ----------

  function onRideUpdate(ride) {
    const prev = rides.get(ride.id);
    rides.set(ride.id, ride);
    if (prev) notifyChanges(prev, ride);
    renderRides();
    syncRideLayers();
  }

  /** Mesaje pentru dispecer: comandă acceptată, nimeni n-a acceptat, SMS netrimis. */
  function notifyChanges(prev, ride) {
    const name = '#' + ride.id + ' (' + ride.customerName + ')';
    if (prev.status === 'pending' && ride.status === 'assigned') {
      UI.toast('Comanda ' + name + ' a fost acceptată de ' + ride.carPlate + ' · ' + ride.driverName, 'success');
    } else if (prev.status !== ride.status) {
      UI.toast('Cursa ' + name + ': ' + UI.RIDE_STATUS_LABELS[ride.status]);
    } else if (ride.status === 'pending' && openOffers(prev).length && !openOffers(ride).length) {
      UI.toast('Comanda ' + name + ': niciun șofer nu a acceptat. Retrimiteți-o sau anulați-o.', 'error');
    }
    if (ride.sms.status === 'failed' && prev.sms.status !== 'failed') {
      UI.toast('SMS-ul către client nu a plecat (' + ride.sms.detail + '). Trimiteți linkul manual.', 'error');
    }
  }

  function openOffers(ride) {
    const now = Date.now();
    return (ride.offers || []).filter((o) => o.response === null && o.expiresAt > now);
  }

  function renderRides() {
    const all = [...rides.values()].sort((a, b) => b.createdAt - a.createdAt);
    const active = all.filter((r) => ACTIVE_RIDE.has(r.status));
    const finished = all.filter((r) => !ACTIVE_RIDE.has(r.status));
    $('count-rides').textContent = active.length;

    const content = [];
    if (!all.length) {
      content.push(el('p', { class: 'empty' }, 'Nicio cursă încă. Folosiți „+ Cursă nouă”.'));
    }
    if (active.length) {
      content.push(el('div', { class: 'section-title' }, 'Active'));
      content.push(el('ul', { class: 'list' }, active.map(rideCard)));
    }
    if (finished.length) {
      content.push(el('div', { class: 'section-title' }, 'Încheiate recent'));
      content.push(el('ul', { class: 'list' }, finished.map(rideCard)));
    }
    $('ride-list').replaceChildren(...content);
  }

  function rideCard(ride) {
    const active = ACTIVE_RIDE.has(ride.status);
    const link = location.origin + ride.trackPath;
    const actions = [];
    const button = (label, onclick, style) => el('button', { class: 'btn btn-sm' + (style ? ' ' + style : ''), type: 'button', onclick }, label);
    if (ride.status === 'pending') {
      actions.push(
        button('Retrimite la toate mașinile libere', () => resendRide(ride), 'btn-primary'),
        button('Pe hartă', () => showRide(ride)),
        button('Anulează', () => changeRideStatus(ride, 'cancelled'), 'btn-danger')
      );
    } else if (active) {
      actions.push(
        button('Copiază link client', () => copyLink(link)),
        el('a', { class: 'btn btn-sm', href: ride.trackPath, target: '_blank', rel: 'noopener' }, 'Deschide'),
        button('Pe hartă', () => showRide(ride)),
        button('Finalizează', () => changeRideStatus(ride, 'completed')),
        button('Anulează', () => changeRideStatus(ride, 'cancelled'), 'btn-danger')
      );
    }
    const finishedAt = ride.statusTimes.completed || ride.statusTimes.cancelled;
    const waiting = ride.status === 'pending' && !openOffers(ride).length;
    return el(
      'li',
      { class: 'card ride-item' + (active ? '' : ' finished') + (waiting ? ' needs-attention' : '') },
      el(
        'div',
        { class: 'head' },
        el('span', { class: 'title' }, '#' + ride.id + ' · ' + ride.customerName),
        el('span', { class: 'badge', dataset: { status: ride.status } }, UI.RIDE_STATUS_LABELS[ride.status])
      ),
      el(
        'div',
        { class: 'lines' },
        el('div', {}, 'Preluare: ' + (ride.address || coords(ride.pickup))),
        ride.phone ? el('div', {}, 'Telefon: ', el('a', { href: 'tel:' + ride.phone }, ride.phone)) : null,
        ride.carPlate ? el('div', {}, 'Mașina: ' + ride.carPlate + ' · ' + ride.driverName) : null,
        ride.notes ? el('div', {}, 'Observații: ' + ride.notes) : null,
        ride.status === 'pending' ? offersLine(ride) : null,
        LINK_ACTIVE.has(ride.status) ? smsLine(ride, link) : null,
        el(
          'div',
          {},
          'Creată la ' + UI.formatTime(ride.createdAt) +
            (ride.createdByName ? ' de ' + ride.createdByName : '') +
            (finishedAt ? ' · încheiată la ' + UI.formatTime(finishedAt) + (ride.closedByName ? ' (' + ride.closedByName + ')' : '') : '')
        )
      ),
      actions.length ? el('div', { class: 'actions' }, actions) : null
    );
  }

  /** Cui a fost trimisă comanda și ce a răspuns fiecare șofer, plus timpul rămas. */
  function offersLine(ride) {
    const open = openOffers(ride);
    if (!ride.offers.length) {
      return el('div', { class: 'offer-state warn' }, 'Nicio mașină liberă când a fost trimisă. Retrimiteți-o când se eliberează o mașină.');
    }
    // Ultima trimitere (după o retrimitere, ofertele vechi apar „retrase”).
    const lastRound = ride.offers.filter((o) => o.offeredAt === ride.offers[ride.offers.length - 1].offeredAt);
    const expiresAt = Math.max(...lastRound.map((o) => o.expiresAt));
    return el(
      'div',
      { class: 'offer-state' + (open.length ? '' : ' warn') },
      open.length
        ? el('div', {}, 'Se așteaptă acceptarea · ', el('span', { class: 'countdown', dataset: { expires: expiresAt } }, secondsLeft(expiresAt)))
        : el('div', {}, 'Niciun șofer nu a acceptat comanda.'),
      el(
        'div',
        { class: 'offer-cars' },
        lastRound.map((o) =>
          el('span', { class: 'offer-car', dataset: { response: o.response || 'open' } }, o.plate + (o.response ? ' — ' + OFFER_LABELS[o.response] : ''))
        )
      )
    );
  }

  /** Starea SMS-ului cu linkul trimis clientului, cu variantele manuale când nu a plecat. */
  function smsLine(ride, link) {
    const { status, detail, at } = ride.sms;
    const texts = {
      sending: 'SMS: se trimite…',
      sent: 'SMS trimis la ' + detail + (at ? ' · ' + UI.formatTime(at) : ''),
      simulated: 'SMS simulat (nu e configurat un furnizor de SMS)',
      failed: 'SMS netrimis: ' + detail,
      no_phone: 'Fără telefon: clientul nu a primit SMS',
      invalid_phone: 'Număr de telefon invalid: ' + detail,
    };
    const problem = status !== 'sent' && status !== 'sending';
    const smsBody = 'Taxiul ' + ride.carPlate + ' de la ' + config.companyName + ' vine spre dvs. Urmariti-l: ' + link;
    return el(
      'div',
      { class: 'sms-state' + (status === 'sent' ? ' ok' : problem ? ' warn' : '') },
      texts[status] || 'SMS: în așteptare',
      problem && ride.phone && status !== 'invalid_phone'
        ? el('span', {}, ' · ', el('button', { class: 'link-button', type: 'button', onclick: () => resendSms(ride) }, 'retrimite'))
        : null,
      problem && ride.phone
        ? el('span', {}, ' · ', el('a', { href: 'sms:' + ride.phone + '?body=' + encodeURIComponent(smsBody) }, 'SMS de pe telefonul dvs.'))
        : null
    );
  }

  function secondsLeft(expiresAt) {
    return 'expiră în ' + Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)) + ' s';
  }

  function updateCountdowns() {
    document.querySelectorAll('.countdown[data-expires]').forEach((node) => (node.textContent = secondsLeft(Number(node.dataset.expires))));
  }

  function resendRide(ride) {
    socket.emit('ride:resend', { rideId: ride.id, target: { mode: 'all' } }, (res) => {
      if (!res || !res.ok) return UI.toast((res && res.error) || 'Eroare', 'error');
      UI.toast(res.offeredTo.length ? 'Comanda a fost retrimisă la ' + res.offeredTo.length + ' mașini' : 'Nicio mașină liberă momentan', res.offeredTo.length ? 'success' : 'error');
    });
  }

  function resendSms(ride) {
    socket.emit('ride:sms', { rideId: ride.id }, (res) => {
      if (!res || !res.ok) UI.toast((res && res.error) || 'Eroare', 'error');
    });
  }

  function changeRideStatus(ride, status) {
    const what = ride.status === 'pending' ? 'comanda' : 'cursa';
    const question =
      status === 'cancelled'
        ? 'Anulați ' + what + ' #' + ride.id + ' (' + ride.customerName + ')?'
        : 'Marcați cursa #' + ride.id + ' ca finalizată?';
    if (!confirm(question)) return;
    socket.emit('ride:status', { rideId: ride.id, status }, (res) => {
      if (!res || !res.ok) UI.toast((res && res.error) || 'Eroare', 'error');
    });
  }

  function showRide(ride) {
    const entry = cars.get(ride.carId);
    const points = [[ride.pickup.lat, ride.pickup.lng]];
    if (entry && entry.marker) points.push(entry.marker.getLatLng());
    map.fitBounds(points, { padding: [80, 80], maxZoom: 16 });
  }

  /** Pin pentru fiecare client care așteaptă și o linie punctată de la mașina trimisă la el. */
  function syncRideLayers() {
    for (const [id, layers] of rideLayers) {
      const ride = rides.get(id);
      if (!ride || !PICKUP_VISIBLE.has(ride.status)) {
        layers.pin.remove();
        layers.line.remove();
        rideLayers.delete(id);
      }
    }
    for (const ride of rides.values()) {
      if (!PICKUP_VISIBLE.has(ride.status)) continue;
      let layers = rideLayers.get(ride.id);
      if (layers && layers.pending !== (ride.status === 'pending')) {
        layers.pin.setIcon(UI.pickupIcon(ride.status === 'pending' ? 'pending' : ''));
        layers.pending = ride.status === 'pending';
      }
      if (!layers) {
        layers = {
          pending: ride.status === 'pending',
          pin: L.marker([ride.pickup.lat, ride.pickup.lng], { icon: UI.pickupIcon(ride.status === 'pending' ? 'pending' : '') })
            .bindTooltip(el('span', {}, '#' + ride.id + ' ' + ride.customerName), { offset: [0, -30], direction: 'top' })
            .addTo(map),
          line: L.polyline([], { color: '#1c1f24', weight: 2, dashArray: '6 6', opacity: 0.7, interactive: false }).addTo(map),
        };
        rideLayers.set(ride.id, layers);
      }
      const car = cars.get(ride.carId);
      const pos = ride.status === 'assigned' && car && car.data.position;
      layers.line.setLatLngs(pos ? [[pos.lat, pos.lng], [ride.pickup.lat, ride.pickup.lng]] : []);
    }
  }

  async function copyLink(link) {
    UI.toast((await UI.copyText(link)) ? 'Link copiat' : 'Nu s-a putut copia linkul', 'success');
  }

  // ---------- Cursă nouă ----------

  function setTab(name) {
    activeTab = name;
    document.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === name)));
    for (const panel of ['cars', 'rides', 'new']) $('panel-' + panel).hidden = panel !== name;
    document.body.classList.toggle('map-picking', name === 'new');
    if (name === 'new') {
      refreshTargetSelect();
      if (pickup) showDraftMarker();
      if (!$('ride-result').hidden) return;
      $('ride-address').focus();
    } else if (draftMarker) {
      draftMarker.remove();
      draftMarker = null;
    }
  }

  function setPickup(lat, lng, reverseGeocode) {
    pickup = { lat, lng };
    $('ride-result').hidden = true;
    $('ride-form').hidden = false;
    showDraftMarker();
    $('pickup-status').classList.add('set');
    $('pickup-status').textContent = 'Loc de preluare ales: ' + coords(pickup) + ' (puteți trage de pin pentru ajustare)';
    refreshTargetSelect();
    if (reverseGeocode && (!$('ride-address').value.trim() || addressWasAutoFilled)) {
      reverseAddress(lat, lng);
    }
  }

  function showDraftMarker() {
    if (!draftMarker) {
      draftMarker = L.marker([pickup.lat, pickup.lng], { icon: UI.pickupIcon(), draggable: true, zIndexOffset: 1000 }).addTo(map);
      draftMarker.on('dragend', () => {
        const p = draftMarker.getLatLng();
        pickupFromMap = true;
        setPickup(p.lat, p.lng, true);
      });
    } else {
      draftMarker.setLatLng([pickup.lat, pickup.lng]);
    }
  }

  /**
   * Cui se trimite comanda: toate mașinile libere (implicit), cele mai apropiate N, sau o singură mașină.
   * Primul șofer care acceptă primește cursa.
   */
  function refreshTargetSelect() {
    const select = $('ride-target');
    const previous = select.value;
    const free = [...cars.values()]
      .map((e) => e.data)
      .filter((c) => c.status === 'free' && !noGps(c))
      .map((c) => ({ car: c, distance: pickup && c.position ? Geo.distanceMeters(c.position, pickup) : Infinity }))
      .sort((a, b) => a.distance - b.distance || a.car.plate.localeCompare(b.car.plate));

    const options = [
      el('option', { value: 'all' }, free.length ? 'Toate mașinile libere (' + free.length + ')' : 'Nicio mașină liberă cu GPS acum — comanda va aștepta'),
    ];
    for (const count of [3, 5]) {
      if (free.length > count) options.push(el('option', { value: 'nearest:' + count }, 'Cele mai apropiate ' + count + ' mașini'));
    }
    if (free.length) {
      options.push(
        el(
          'optgroup',
          { label: 'O singură mașină' },
          free.map(({ car, distance }) => {
            const where = Number.isFinite(distance) ? Geo.formatDistance(distance) + ' până la client' : car.position ? null : 'fără poziție';
            return el('option', { value: 'car:' + car.id }, car.plate + ' · ' + car.driver + (where ? ' — ' + where : ''));
          })
        )
      );
    }
    select.replaceChildren(...options);
    if ([...select.options].some((o) => o.value === previous)) select.value = previous;
  }

  function selectedTarget() {
    const [mode, value] = $('ride-target').value.split(':');
    if (mode === 'nearest') return { mode, count: Number(value) };
    if (mode === 'car') return { mode, carId: value };
    return { mode: 'all' };
  }

  function submitRide(e) {
    e.preventDefault();
    const error = $('ride-error');
    error.textContent = '';
    if (!pickup) {
      error.textContent = 'Alegeți locul de preluare pe hartă sau căutați adresa.';
      return;
    }
    const payload = {
      customerName: $('ride-name').value,
      phone: $('ride-phone').value,
      address: $('ride-address').value,
      notes: $('ride-notes').value,
      pickup,
      target: selectedTarget(),
    };
    const button = e.submitter || $('ride-form').querySelector('button[type=submit]');
    button.disabled = true;
    socket.timeout(10000).emit('ride:create', payload, (err, res) => {
      button.disabled = false;
      if (err) {
        error.textContent = 'Serverul nu a răspuns. Verificați conexiunea.';
        return;
      }
      if (!res.ok) {
        error.textContent = res.error;
        return;
      }
      rides.set(res.ride.id, res.ride);
      renderRides();
      syncRideLayers();
      showRideResult(res.ride, res.offeredTo);
      resetForm();
    });
  }

  function resetForm() {
    $('ride-form').reset();
    pickup = null;
    pickupFromMap = false;
    addressWasAutoFilled = false;
    resetVoice();
    if (draftMarker) {
      draftMarker.remove();
      draftMarker = null;
    }
    $('pickup-status').classList.remove('set');
    $('pickup-status').textContent = 'Căutați adresa sau faceți click pe hartă pentru a alege locul de preluare.';
  }

  function showRideResult(ride, offeredTo) {
    const box = $('ride-result');
    const count = offeredTo.length;
    box.replaceChildren(
      el(
        'div',
        { class: 'result-box' + (count ? '' : ' warn') },
        el('strong', {}, 'Comanda #' + ride.id + (count ? ' a fost trimisă la ' + count + (count === 1 ? ' mașină.' : ' mașini.') : ' așteaptă: nicio mașină liberă.')),
        el(
          'p',
          { class: 'hint' },
          count
            ? 'Primul șofer care acceptă primește cursa. Clientul primește apoi automat SMS cu linkul de urmărire. Starea comenzii se vede în tabul Curse.'
            : 'Comanda apare în tabul Curse; retrimiteți-o când se eliberează o mașină.'
        ),
        el(
          'div',
          { class: 'actions row', style: 'flex-wrap:wrap' },
          el('button', { class: 'btn btn-sm btn-primary', type: 'button', onclick: () => setTab('rides') }, 'Vezi în Curse'),
          el(
            'button',
            {
              class: 'btn btn-sm',
              type: 'button',
              onclick: () => {
                box.hidden = true;
                $('ride-form').hidden = false;
                $('ride-address').focus();
              },
            },
            'Comandă nouă'
          )
        )
      )
    );
    $('ride-form').hidden = true;
    box.hidden = false;
  }

  // ---------- Căutare adrese (OpenStreetMap Nominatim) ----------

  /** `quiet`: căutare pornită de asistentul vocal; dacă nu găsește, dispecerul vede doar că pinul lipsește. */
  async function searchAddress({ quiet = false } = {}) {
    const query = $('ride-address').value.trim();
    if (!query) return;
    const button = $('geocode');
    button.disabled = true;
    try {
      const b = map.getBounds();
      const params = new URLSearchParams({
        q: query,
        format: 'jsonv2',
        limit: '1',
        'accept-language': 'ro',
        viewbox: [b.getWest(), b.getNorth(), b.getEast(), b.getSouth()].join(','),
      });
      if (config.geocodeCountry) params.set('countrycodes', config.geocodeCountry);
      const res = await fetch(NOMINATIM + '/search?' + params);
      const results = res.ok ? await res.json() : [];
      if (!results.length) {
        if (!quiet) UI.toast('Adresa nu a fost găsită. Alegeți punctul direct pe hartă.', 'error');
        return;
      }
      const lat = Number(results[0].lat);
      const lng = Number(results[0].lon);
      setPickup(lat, lng, false);
      map.setView([lat, lng], 17);
    } catch {
      if (!quiet) UI.toast('Căutarea adreselor nu este disponibilă. Alegeți punctul pe hartă.', 'error');
    } finally {
      button.disabled = false;
    }
  }

  async function reverseAddress(lat, lng) {
    try {
      const params = new URLSearchParams({ lat, lon: lng, format: 'jsonv2', zoom: '18', 'accept-language': 'ro' });
      const res = await fetch(NOMINATIM + '/reverse?' + params);
      if (!res.ok) return;
      const data = await res.json();
      // Între timp dispecerul poate fi ales alt punct sau scris adresa de mână.
      if (!pickup || pickup.lat !== lat || pickup.lng !== lng) return;
      if ($('ride-address').value.trim() && !addressWasAutoFilled) return;
      const a = data.address || {};
      const street = [a.road || a.pedestrian || a.square, a.house_number].filter(Boolean).join(' ');
      const city = a.city || a.town || a.village || '';
      const text = [street, city].filter(Boolean).join(', ') || data.display_name || '';
      if (text) {
        $('ride-address').value = text;
        addressWasAutoFilled = true;
      }
    } catch {
      // Adresa e opțională; punctul de pe hartă este suficient.
    }
  }

  // ---------- Asistentul vocal (opțional, AI local pe calculatorul dispecerului) ----------

  function setupVoice() {
    if (!config.voice || !window.TaxiVoice) return;
    $('voice-box').hidden = false;
    $('voice-toggle').addEventListener('click', () => (voice && voice.active ? voice.stop() : startVoice()));
    for (const id of ['ride-address', 'ride-name', 'ride-phone', 'ride-notes']) {
      $(id).addEventListener('input', () => typedFields.add(id));
    }
  }

  async function startVoice() {
    if (voice) voice.stop({ discard: true });
    $('voice-error').textContent = '';
    voice = TaxiVoice.createVoiceAssistant(config.voice, {
      onStatus: renderVoiceStatus,
      onTranscript: renderTranscript,
      onFields: applyVoiceFields,
      onError: (message) => ($('voice-error').textContent = message),
    });
    try {
      await voice.start();
    } catch (err) {
      $('voice-error').textContent = err.message;
      voice = null;
      renderVoiceStatus({ listening: false, pending: 0, level: 0 });
    }
  }

  /** Comanda a fost trimisă: ascultarea se oprește, iar frazele încă în lucru nu mai completează formularul. */
  function resetVoice() {
    if (voice) voice.stop({ discard: true });
    voice = null;
    typedFields.clear();
    clearTimeout(voiceSearchTimer);
    $('voice-error').textContent = '';
    $('voice-transcript').replaceChildren();
    $('voice-transcript').hidden = true;
    renderVoiceStatus({ listening: false, pending: 0, level: 0 });
  }

  function renderVoiceStatus({ listening, hearing, pending, level }) {
    const toggle = $('voice-toggle');
    toggle.textContent = listening ? 'Oprește ascultarea' : 'Ascultă convorbirea';
    toggle.classList.toggle('recording', listening);
    $('voice-status').textContent = listening
      ? hearing
        ? 'Aud vorbire…'
        : pending
          ? 'Recunosc ce s-a spus…'
          : 'Ascult convorbirea'
      : pending
        ? 'Recunosc ultimele fraze…'
        : 'Completează comanda din ce se spune la telefon.';
    $('voice-level').style.width = listening ? Math.min(100, Math.round(level * 400)) + '%' : '0';
  }

  function renderTranscript(lines) {
    const box = $('voice-transcript');
    box.hidden = false;
    box.replaceChildren(...lines.map((line) => el('p', {}, line)));
    box.scrollTop = box.scrollHeight;
  }

  /** Completează câmpurile încă neatinse de dispecer; adresa nouă este căutată pe hartă. */
  function applyVoiceFields(fields) {
    fill('ride-name', fields.customerName);
    fill('ride-phone', fields.phone);
    fill('ride-notes', fields.details);
    if (fill('ride-address', fields.address)) {
      addressWasAutoFilled = false;
      if (!pickupFromMap) {
        clearTimeout(voiceSearchTimer);
        voiceSearchTimer = setTimeout(() => searchAddress({ quiet: true }), 400);
      }
    }
  }

  function fill(id, value) {
    const input = $(id);
    if (!value || typedFields.has(id) || input.value === value) return false;
    input.value = value;
    input.classList.remove('autofilled');
    void input.offsetWidth; // repornește animația
    input.classList.add('autofilled');
    return true;
  }

  // ---------- Utilitare ----------

  function coords(p) {
    return p.lat.toFixed(5) + ', ' + p.lng.toFixed(5);
  }
})();
