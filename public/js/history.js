// Istoricul curselor: filtre, statistici, traseul parcurs pe hartă și export pentru Excel.
(function () {
  const UI = window.TaxiUI;
  const { el } = UI;
  const $ = (id) => document.getElementById(id);

  const PAGE_SIZE = 50;
  const EXPORT_LIMIT = 10000;
  const OFFER_LABELS = { accepted: 'a acceptat', declined: 'a refuzat', expired: 'nu a răspuns', taken: 'preluată de altul', withdrawn: 'retrasă' };
  const SMS_LABELS = { sent: 'trimis', simulated: 'simulat (fără furnizor de SMS)', failed: 'netrimis', no_phone: 'fără telefon', invalid_phone: 'număr invalid', sending: 'în curs' };

  let config;
  let map;
  let routeLayer = null;
  let offset = 0;
  let total = 0;
  let selectedId = null;
  let rides = [];

  init().catch((err) => UI.toast('Eroare la pornire: ' + err.message, 'error'));

  async function init() {
    config = await UI.setCompanyName();
    document.title = 'Istoric curse · ' + config.companyName;

    $('filters').addEventListener('submit', (e) => {
      e.preventDefault();
      reload();
    });
    document.querySelectorAll('[data-range]').forEach((btn) =>
      btn.addEventListener('click', () => {
        setRange(btn.dataset.range);
        reload();
      })
    );
    $('export').addEventListener('click', () => run(exportCsv()));
    setRange('7');

    UI.requireDispatcher(
      start,
      () => {
        if (!map) map = UI.createMap($('map'), config);
        map.invalidateSize();
      },
      { title: 'Istoric curse' }
    );
  }

  async function start() {
    // Primul apel verifică și parola.
    const cars = await UI.api('/api/fleet');
    const select = $('car');
    const current = select.value;
    select.replaceChildren(
      el('option', { value: '' }, 'Toate'),
      ...cars.map((c) => el('option', { value: c.id }, c.plate + ' · ' + c.driver + (c.active ? '' : ' (dezactivată)')))
    );
    select.value = current;
    await load();
  }

  function reload() {
    offset = 0;
    run(load());
  }

  /** Erorile din acțiunile utilizatorului: la parolă invalidă se reîncarcă pagina de autentificare. */
  function run(promise) {
    promise.catch((err) => {
      if (err.status === 401) {
        UI.sessionLost();
      } else {
        UI.toast(err.message, 'error');
      }
    });
  }

  // ---------- Perioada ----------

  function setRange(kind) {
    const range = UI.quickRange(kind);
    $('from').value = range.from;
    $('to').value = range.to;
  }

  function query(extra) {
    const { from, to } = UI.dateInputsRange($('from').value, $('to').value);
    const params = new URLSearchParams({ from, to, ...extra });
    if ($('car').value) params.set('carId', $('car').value);
    if ($('status').value) params.set('status', $('status').value);
    if ($('q').value.trim()) params.set('q', $('q').value.trim());
    return params;
  }

  // ---------- Date ----------

  async function load() {
    const data = await UI.api('/api/rides?' + query({ limit: PAGE_SIZE, offset }));
    rides = data.rides;
    total = data.total;
    renderStats(data.stats);
    renderTable();
    renderPager();
    renderDrivers(data.stats.byDriver);
    renderDispatchers(data.stats.byDispatcher);
  }

  function renderDispatchers(rows) {
    const body = $('dispatchers-body');
    if (!rows.length) {
      body.replaceChildren(el('tr', {}, el('td', { colspan: '4', class: 'empty' }, '—')));
      return;
    }
    body.replaceChildren(
      ...rows.map((r) =>
        el(
          'tr',
          {},
          el('td', {}, r.name || el('span', { class: 'hint' }, 'nespecificat (înainte de conturi)')),
          el('td', { class: 'num' }, r.total),
          el('td', { class: 'num' }, r.completed),
          el('td', { class: 'num' }, r.cancelled)
        )
      )
    );
  }

  function waitMs(ride) {
    return ride.statusTimes.arrived ? ride.statusTimes.arrived - ride.createdAt : null;
  }

  function durationMs(ride) {
    const t = ride.statusTimes;
    return t.completed && t.in_progress ? t.completed - t.in_progress : null;
  }

  function renderStats(stats) {
    const cancelledPct = stats.total ? Math.round((stats.cancelled / stats.total) * 100) + '%' : '';
    const items = [
      ['Curse', stats.total, ''],
      ['Finalizate', stats.completed, ''],
      ['Anulate', stats.cancelled, cancelledPct],
      ['Fără șofer', stats.unassigned, 'anulate înainte să le accepte cineva'],
      ['Până la acceptare', UI.formatMinutes(stats.avgAcceptMs), 'timp mediu de la comandă'],
      ['Km cu clienți', UI.formatKm(stats.distanceM), ''],
      ['Așteptare medie', UI.formatMinutes(stats.avgPickupMs), 'de la comandă la sosire'],
      ['Durată medie', UI.formatMinutes(stats.avgRideMs), 'cu clientul în mașină'],
    ];
    $('stats').replaceChildren(
      ...items.map(([label, value, note]) =>
        el('div', { class: 'stat' }, el('span', {}, label), el('strong', {}, value), note ? el('small', {}, note) : null)
      )
    );
  }

  function renderTable() {
    const body = $('rides-body');
    if (!rides.length) {
      body.replaceChildren(el('tr', {}, el('td', { colspan: '9', class: 'empty' }, 'Nicio cursă pentru filtrele alese.')));
      return;
    }
    body.replaceChildren(
      ...rides.map((ride) =>
        el(
          'tr',
          {
            class: 'clickable' + (ride.id === selectedId ? ' selected' : ''),
            tabindex: '0',
            onclick: () => run(selectRide(ride.id)),
            onkeydown: (e) => e.key === 'Enter' && run(selectRide(ride.id)),
          },
          el('td', {}, '#' + ride.id),
          el(
            'td',
            { class: 'nowrap' },
            el('div', {}, new Date(ride.createdAt).toLocaleDateString('ro-RO')),
            el('div', { class: 'hint' }, UI.formatTime(ride.createdAt))
          ),
          el('td', {}, el('div', {}, ride.customerName), ride.phone ? el('div', { class: 'hint' }, ride.phone) : null),
          el('td', { class: 'ellipsis', title: ride.address }, ride.address || coords(ride.pickup)),
          el('td', { class: 'nowrap' }, el('div', {}, ride.carPlate || '—'), el('div', { class: 'hint' }, ride.driverName)),
          el('td', {}, el('span', { class: 'badge', dataset: { status: ride.status } }, UI.RIDE_STATUS_LABELS[ride.status])),
          el('td', { class: 'num' }, UI.formatMinutes(waitMs(ride))),
          el('td', { class: 'num' }, UI.formatMinutes(durationMs(ride))),
          el('td', { class: 'num' }, ride.status === 'completed' ? UI.formatKm(ride.distanceM) : '—')
        )
      )
    );
  }

  function renderPager() {
    const pager = $('pager');
    if (total <= PAGE_SIZE) {
      pager.replaceChildren(el('span', { class: 'hint' }, total ? total + (total === 1 ? ' cursă' : ' curse') : ''));
      return;
    }
    const go = (newOffset) => {
      offset = newOffset;
      run(load());
    };
    pager.replaceChildren(
      el('button', { class: 'btn btn-sm', type: 'button', disabled: offset === 0, onclick: () => go(Math.max(0, offset - PAGE_SIZE)) }, '‹ Anterioare'),
      el('span', { class: 'hint' }, offset + 1 + '–' + Math.min(offset + PAGE_SIZE, total) + ' din ' + total),
      el('button', { class: 'btn btn-sm', type: 'button', disabled: offset + PAGE_SIZE >= total, onclick: () => go(offset + PAGE_SIZE) }, 'Următoarele ›')
    );
  }

  function renderDrivers(rows) {
    const body = $('drivers-body');
    if (!rows.length) {
      body.replaceChildren(el('tr', {}, el('td', { colspan: '6', class: 'empty' }, '—')));
      return;
    }
    body.replaceChildren(
      ...rows.map((r) =>
        el(
          'tr',
          {},
          el('td', { class: 'nowrap' }, r.carPlate),
          el('td', {}, r.driverName),
          el('td', { class: 'num' }, r.total),
          el('td', { class: 'num' }, r.completed),
          el('td', { class: 'num' }, r.cancelled),
          el('td', { class: 'num' }, UI.formatKm(r.distanceM))
        )
      )
    );
  }

  // ---------- Traseul unei curse ----------

  async function selectRide(id) {
    selectedId = id;
    $('history-layout').classList.add('has-selection');
    renderTable();
    const { ride, points } = await UI.api('/api/rides/' + encodeURIComponent(id) + '/route');
    if (selectedId !== id) return;
    // Pe telefon harta era ascunsă până acum; Leaflet trebuie să-și recalculeze dimensiunea.
    map.invalidateSize();
    drawRoute(ride, points);
    renderDetail(ride, points);
    if (window.innerWidth < 900) $('map').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function drawRoute(ride, points) {
    if (routeLayer) routeLayer.remove();
    routeLayer = L.featureGroup().addTo(map);
    const latlngs = (list) => list.map((p) => [p.lat, p.lng]);
    // Până la preluare: linie punctată; cu clientul în mașină: linie plină.
    const split = points.findIndex((p) => p.status === 'in_progress');
    const toPickup = split === -1 ? points : points.slice(0, split + 1);
    const withClient = split === -1 ? [] : points.slice(split);

    if (toPickup.length > 1) {
      L.polyline(latlngs(toPickup), { color: '#69707d', weight: 4, dashArray: '6 8' }).addTo(routeLayer);
    }
    if (withClient.length > 1) {
      L.polyline(latlngs(withClient), { color: '#ea580c', weight: 5, opacity: 0.9 }).addTo(routeLayer);
    }
    L.marker([ride.pickup.lat, ride.pickup.lng], { icon: UI.pickupIcon() })
      .bindTooltip('Preluare', { direction: 'top', offset: [0, -32] })
      .addTo(routeLayer);
    if (points.length) {
      const first = points[0];
      L.circleMarker([first.lat, first.lng], { radius: 6, color: '#fff', weight: 2, fillColor: '#69707d', fillOpacity: 1 })
        .bindTooltip('Mașina la primirea comenzii')
        .addTo(routeLayer);
    }
    if (ride.status === 'completed' && withClient.length) {
      const last = points[points.length - 1];
      L.circleMarker([last.lat, last.lng], { radius: 7, color: '#fff', weight: 2, fillColor: '#16a34a', fillOpacity: 1 })
        .bindTooltip('Destinație')
        .addTo(routeLayer);
    }
    map.fitBounds(routeLayer.getBounds(), { padding: [30, 30], maxZoom: 16 });
  }

  function renderDetail(ride, points) {
    const t = ride.statusTimes;
    const step = (label, ts, since) =>
      ts ? el('li', {}, el('strong', {}, UI.formatTime(ts)), ' ' + label + (since ? ' (' + UI.formatMinutes(ts - since) + ')' : '')) : null;
    const finishedAt = t.completed || t.cancelled;
    $('detail').replaceChildren(
      el(
        'div',
        { class: 'gps-line' },
        el('strong', {}, '#' + ride.id + ' · ' + ride.customerName),
        el('span', { class: 'badge', dataset: { status: ride.status } }, UI.RIDE_STATUS_LABELS[ride.status])
      ),
      el(
        'div',
        { class: 'lines' },
        ride.phone ? el('div', {}, 'Telefon: ', el('a', { href: 'tel:' + ride.phone }, ride.phone)) : null,
        el('div', {}, 'Preluare: ' + (ride.address || coords(ride.pickup))),
        el('div', {}, 'Mașina: ' + (ride.carPlate ? ride.carPlate + ' · ' + ride.driverName : 'niciun șofer nu a acceptat')),
        ride.createdByName ? el('div', {}, 'Dispecer: ' + ride.createdByName) : null,
        ride.closedByName ? el('div', {}, (ride.status === 'cancelled' ? 'Anulată de: ' : 'Încheiată de: ') + ride.closedByName) : null,
        ride.notes ? el('div', {}, 'Observații: ' + ride.notes) : null,
        ride.status === 'completed' ? el('div', {}, 'Distanță cu clientul: ' + UI.formatKm(ride.distanceM)) : null,
        ride.offers.length
          ? el('div', {}, 'Trimisă la: ' + ride.offers.map((o) => o.plate + ' (' + (OFFER_LABELS[o.response] || 'fără răspuns') + ')').join(', '))
          : null,
        ride.sms && ride.sms.status ? el('div', {}, 'SMS către client: ' + (SMS_LABELS[ride.sms.status] || ride.sms.status) + (ride.sms.detail ? ' · ' + ride.sms.detail : '')) : null
      ),
      el(
        'ol',
        { class: 'timeline' },
        step('comandă primită', t.pending),
        step('acceptată de șofer', t.assigned, t.pending),
        step('mașina a ajuns', t.arrived, t.pending),
        step('client preluat', t.in_progress),
        step(ride.status === 'cancelled' ? 'anulată' : 'cursă finalizată', finishedAt, ride.status === 'completed' ? t.in_progress : null)
      ),
      points.length
        ? el(
            'div',
            { class: 'legend' },
            el('span', { class: 'legend-dash' }, 'drum spre client'),
            el('span', { class: 'legend-solid' }, 'cu clientul')
          )
        : el('p', { class: 'hint' }, 'Traseul GPS nu este disponibil pentru această cursă.')
    );
  }

  // ---------- Export ----------

  async function exportCsv() {
    // `export=1` înregistrează exportul în jurnal (fișierul conține date personale ale clienților).
    const params = query({ limit: EXPORT_LIMIT, offset: 0, export: '1' });
    const button = $('export');
    button.disabled = true;
    try {
      const data = await UI.api('/api/rides?' + params);
      const header = ['Nr', 'Data', 'Ora', 'Client', 'Telefon', 'Adresă preluare', 'Observații', 'Mașina', 'Șofer', 'Status', 'Așteptare (min)', 'Durată (min)', 'Km cu clientul', 'Dispecer', 'Închisă de'];
      const minutes = (ms) => (ms === null ? '' : Math.round(ms / 60000));
      const rows = data.rides
        .slice()
        .reverse() // cronologic în fișier
        .map((r) => {
          const d = new Date(r.createdAt);
          return [
            r.id,
            d.toLocaleDateString('ro-RO'),
            d.toLocaleTimeString('ro-RO', { hour: '2-digit', minute: '2-digit' }),
            r.customerName,
            r.phone,
            r.address,
            r.notes,
            r.carPlate,
            r.driverName,
            UI.RIDE_STATUS_LABELS[r.status],
            minutes(waitMs(r)),
            minutes(durationMs(r)),
            r.status === 'completed' ? (r.distanceM / 1000).toFixed(1).replace('.', ',') : '',
            r.createdByName,
            r.closedByName,
          ];
        });
      // BOM + „;” ca separator: Excel în limba română deschide corect diacriticele și coloanele.
      const csv = '﻿' + [header, ...rows].map((row) => row.map(csvCell).join(';')).join('\r\n');
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      const link = el('a', { href: url, download: 'curse_' + $('from').value + '_' + $('to').value + '.csv' });
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      if (data.total > data.rides.length) {
        UI.toast('Au fost exportate cele mai noi ' + data.rides.length + ' din ' + data.total + ' curse. Alegeți o perioadă mai scurtă.');
      }
    } finally {
      button.disabled = false;
    }
  }

  function csvCell(value) {
    let text = value === null || value === undefined ? '' : String(value);
    // Un text care începe cu = + - @ ar fi interpretat de Excel ca formulă.
    if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
    return /[";\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
  }

  function coords(p) {
    return p.lat.toFixed(5) + ', ' + p.lng.toFixed(5);
  }
})();
