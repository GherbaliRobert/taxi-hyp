// Dispecerat: toate mașinile în timp real pe hartă, cursele active și formularul de cursă nouă.
(function () {
  const UI = window.TaxiUI;
  const { el } = UI;
  const $ = (id) => document.getElementById(id);

  const PASSWORD_KEY = 'taxi.dispatcherPassword';
  const STATUS_ORDER = { free: 0, busy: 1, offline: 2 };
  const PICKUP_VISIBLE = new Set(['assigned', 'arrived']);
  const ACTIVE_RIDE = new Set(['assigned', 'arrived', 'in_progress']);
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

  init().catch((err) => {
    console.error(err);
    UI.toast('Eroare la pornire: ' + err.message, 'error');
  });

  async function init() {
    config = await UI.loadConfig();
    document.title = 'Dispecerat · ' + config.companyName;
    document.querySelectorAll('.company-name').forEach((n) => (n.textContent = config.companyName));

    $('login-form').addEventListener('submit', (e) => {
      e.preventDefault();
      $('login-error').textContent = '';
      connect($('password').value);
    });
    $('logout').addEventListener('click', logout);
    document.querySelectorAll('.tab').forEach((tab) =>
      tab.addEventListener('click', () => setTab(tab.dataset.tab))
    );
    $('ride-form').addEventListener('submit', submitRide);
    $('geocode').addEventListener('click', searchAddress);
    $('ride-address').addEventListener('input', () => (addressWasAutoFilled = false));
    $('ride-address').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        searchAddress();
      }
    });

    // Timpii „acum X s” și starea „fără semnal” se recalculează periodic.
    setInterval(refreshTimes, 5000);

    const saved = storage('get', PASSWORD_KEY);
    if (saved) connect(saved);
    else showLogin();
  }

  // ---------- Conectare ----------

  function connect(password) {
    if (socket) socket.disconnect();
    socket = io({ auth: { role: 'dispatcher', password } });
    UI.setConnection($('conn'), 'connecting');

    socket.on('connect', () => {
      storage('set', PASSWORD_KEY, password);
      showApp();
      UI.setConnection($('conn'), 'online');
    });
    socket.on('disconnect', () => UI.setConnection($('conn'), 'offline'));
    socket.on('connect_error', (err) => {
      if (err.message === 'unauthorized' || err.message === 'too_many_attempts') {
        socket.disconnect();
        storage('remove', PASSWORD_KEY);
        showLogin(
          err.message === 'too_many_attempts'
            ? 'Prea multe încercări greșite. Reîncercați peste câteva minute.'
            : 'Parolă greșită.'
        );
      } else {
        UI.setConnection($('conn'), 'offline');
      }
    });

    socket.on('fleet:snapshot', onSnapshot);
    socket.on('car:update', onCarUpdate);
    socket.on('ride:update', onRideUpdate);
  }

  function logout() {
    storage('remove', PASSWORD_KEY);
    if (socket) socket.disconnect();
    location.reload();
  }

  function showLogin(error) {
    $('app').hidden = true;
    $('login').hidden = false;
    $('login-error').textContent = error || '';
    $('password').value = '';
    $('password').focus();
  }

  function showApp() {
    $('login').hidden = true;
    $('app').hidden = false;
    if (!map) {
      map = UI.createMap($('map'), config);
      map.on('click', (e) => {
        if (activeTab === 'new') setPickup(e.latlng.lat, e.latlng.lng, true);
      });
    }
    map.invalidateSize();
  }

  // ---------- Mașini ----------

  function onSnapshot({ cars: carList, rides: rideList }) {
    for (const car of carList) upsertCar(car);
    rides.clear();
    for (const ride of rideList) rides.set(ride.id, ride);
    renderCarList();
    renderRides();
    syncRideLayers();
    if (!fittedOnce) {
      fittedOnce = true;
      const points = carList.filter((c) => c.position).map((c) => [c.position.lat, c.position.lng]);
      if (points.length > 1) map.fitBounds(points, { padding: [60, 60], maxZoom: 15 });
      else if (points.length === 1) map.setView(points[0], 15);
    }
  }

  function onCarUpdate(car) {
    const prev = upsertCar(car);
    if (!prev || prev.status !== car.status || prev.rideId !== car.rideId) {
      renderCarList();
      if (activeTab === 'new') refreshCarSelect();
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
    const counts = { free: 0, busy: 0, offline: 0 };
    const items = list.map((entry) => {
      counts[entry.data.status] += 1;
      entry.row = buildCarRow(entry);
      return entry.row.root;
    });
    $('car-list').replaceChildren(...items);
    $('sum-free').textContent = counts.free;
    $('sum-busy').textContent = counts.busy;
    $('sum-offline').textContent = counts.offline;
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
    const stale = car.status !== 'offline' && UI.isStale(car.position);
    row.badge.dataset.status = car.status;
    row.badge.classList.toggle('stale', stale);
    row.badge.textContent = stale
      ? 'Fără semnal'
      : UI.CAR_STATUS_LABELS[car.status] + (car.rideId ? ' #' + car.rideId : '');
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
    if (prev && prev.status !== ride.status) {
      UI.toast('Cursa #' + ride.id + ' (' + ride.carPlate + '): ' + UI.RIDE_STATUS_LABELS[ride.status]);
    }
    renderRides();
    syncRideLayers();
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
    if (active) {
      actions.push(
        el('button', { class: 'btn btn-sm', type: 'button', onclick: () => copyLink(link) }, 'Copiază link client'),
        el('a', { class: 'btn btn-sm', href: ride.trackPath, target: '_blank', rel: 'noopener' }, 'Deschide'),
        el('button', { class: 'btn btn-sm', type: 'button', onclick: () => showRide(ride) }, 'Pe hartă'),
        el('button', { class: 'btn btn-sm', type: 'button', onclick: () => changeRideStatus(ride, 'completed') }, 'Finalizează'),
        el('button', { class: 'btn btn-sm btn-danger', type: 'button', onclick: () => changeRideStatus(ride, 'cancelled') }, 'Anulează')
      );
    }
    const finishedAt = ride.statusTimes.completed || ride.statusTimes.cancelled;
    return el(
      'li',
      { class: 'card ride-item' + (active ? '' : ' finished') },
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
        ride.phone && el('div', {}, 'Telefon: ', el('a', { href: 'tel:' + ride.phone }, ride.phone)),
        el('div', {}, 'Mașina: ' + ride.carPlate),
        ride.notes && el('div', {}, 'Observații: ' + ride.notes),
        el(
          'div',
          {},
          'Creată la ' + UI.formatTime(ride.createdAt) + (finishedAt ? ' · încheiată la ' + UI.formatTime(finishedAt) : '')
        )
      ),
      actions.length ? el('div', { class: 'actions' }, actions) : null
    );
  }

  function changeRideStatus(ride, status) {
    const question =
      status === 'cancelled'
        ? 'Anulați cursa #' + ride.id + ' (' + ride.customerName + ')?'
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
      if (!layers) {
        layers = {
          pin: L.marker([ride.pickup.lat, ride.pickup.lng], { icon: UI.pickupIcon() })
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
      refreshCarSelect();
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
    refreshCarSelect(true);
    if (reverseGeocode && (!$('ride-address').value.trim() || addressWasAutoFilled)) {
      reverseAddress(lat, lng);
    }
  }

  function showDraftMarker() {
    if (!draftMarker) {
      draftMarker = L.marker([pickup.lat, pickup.lng], { icon: UI.pickupIcon(), draggable: true, zIndexOffset: 1000 }).addTo(map);
      draftMarker.on('dragend', () => {
        const p = draftMarker.getLatLng();
        setPickup(p.lat, p.lng, true);
      });
    } else {
      draftMarker.setLatLng([pickup.lat, pickup.lng]);
    }
  }

  /** Lista mașinilor libere, cea mai apropiată de client prima (și preselectată). */
  function refreshCarSelect(selectNearest) {
    const select = $('ride-car');
    const previous = select.value;
    const free = [...cars.values()]
      .map((e) => e.data)
      .filter((c) => c.status === 'free')
      .map((c) => ({
        car: c,
        distance: pickup && c.position ? Geo.distanceMeters(c.position, pickup) : Infinity,
      }))
      .sort((a, b) => a.distance - b.distance || a.car.plate.localeCompare(b.car.plate));

    if (!free.length) {
      select.replaceChildren(el('option', { value: '' }, 'Nicio mașină liberă momentan'));
      return;
    }
    select.replaceChildren(
      ...free.map(({ car, distance }) => {
        const where = Number.isFinite(distance)
          ? Geo.formatDistance(distance) + ' până la client'
          : car.position
            ? null
            : 'fără poziție';
        return el('option', { value: car.id }, car.plate + ' · ' + car.driver + (where ? ' — ' + where : ''));
      })
    );
    if (!selectNearest && free.some((f) => f.car.id === previous)) select.value = previous;
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
      carId: $('ride-car').value,
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
      showRideResult(res.ride);
      resetForm();
    });
  }

  function resetForm() {
    $('ride-form').reset();
    pickup = null;
    addressWasAutoFilled = false;
    if (draftMarker) {
      draftMarker.remove();
      draftMarker = null;
    }
    $('pickup-status').classList.remove('set');
    $('pickup-status').textContent = 'Căutați adresa sau faceți click pe hartă pentru a alege locul de preluare.';
  }

  function showRideResult(ride) {
    const link = location.origin + ride.trackPath;
    const sms =
      'Taxiul ' + ride.carPlate + ' de la ' + config.companyName + ' este pe drum. Urmăriți-l aici: ' + link;
    const box = $('ride-result');
    box.replaceChildren(
      el(
        'div',
        { class: 'result-box' },
        el('strong', {}, 'Cursa #' + ride.id + ' a fost trimisă către ' + ride.carPlate + '.'),
        el('div', { class: 'hint' }, 'Trimiteți clientului linkul de mai jos ca să vadă mașina venind spre el:'),
        el('div', { class: 'link' }, link),
        el(
          'div',
          { class: 'actions row', style: 'flex-wrap:wrap' },
          el('button', { class: 'btn btn-sm btn-primary', type: 'button', onclick: () => copyLink(link) }, 'Copiază link'),
          ride.phone &&
            el('a', { class: 'btn btn-sm', href: 'sms:' + ride.phone + '?body=' + encodeURIComponent(sms) }, 'Trimite SMS'),
          el('a', { class: 'btn btn-sm', href: ride.trackPath, target: '_blank', rel: 'noopener' }, 'Deschide'),
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
            'Altă cursă'
          )
        )
      )
    );
    $('ride-form').hidden = true;
    box.hidden = false;
  }

  // ---------- Căutare adrese (OpenStreetMap Nominatim) ----------

  async function searchAddress() {
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
        UI.toast('Adresa nu a fost găsită. Alegeți punctul direct pe hartă.', 'error');
        return;
      }
      const lat = Number(results[0].lat);
      const lng = Number(results[0].lon);
      setPickup(lat, lng, false);
      map.setView([lat, lng], 17);
    } catch {
      UI.toast('Căutarea adreselor nu este disponibilă. Alegeți punctul pe hartă.', 'error');
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

  // ---------- Utilitare ----------

  function coords(p) {
    return p.lat.toFixed(5) + ', ' + p.lng.toFixed(5);
  }

  function storage(action, key, value) {
    try {
      if (action === 'get') return sessionStorage.getItem(key);
      if (action === 'set') sessionStorage.setItem(key, value);
      if (action === 'remove') sessionStorage.removeItem(key);
    } catch {
      return null;
    }
    return null;
  }
})();
