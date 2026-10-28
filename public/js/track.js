// Pagina clientului: urmărește în timp real taxiul trimis la el (link unic per cursă).
(function () {
  const UI = window.TaxiUI;
  const $ = (id) => document.getElementById(id);

  const token = decodeURIComponent(location.pathname.split('/').filter(Boolean).pop() || '');

  let map;
  let socket;
  let carMarker = null;
  let pickupMarker = null;
  let userMovedMap = false;
  let fittedOnce = false;
  let lastView = null;

  init().catch((err) => {
    console.error(err);
    showMessage('Pagina nu s-a putut încărca', 'Verificați conexiunea la internet și reîncărcați pagina.');
  });

  async function init() {
    const config = await UI.loadConfig();
    document.title = 'Taxiul dvs. · ' + config.companyName;
    document.querySelectorAll('.company-name').forEach((n) => (n.textContent = config.companyName));

    map = UI.createMap($('map'), config);
    map.on('dragstart', () => {
      userMovedMap = true;
      $('recenter').hidden = false;
    });
    $('recenter').addEventListener('click', () => {
      userMovedMap = false;
      $('recenter').hidden = true;
      if (lastView) fitMap(lastView, true);
    });

    socket = io({ auth: { role: 'track', token } });
    UI.setConnection($('conn'), 'connecting');
    socket.on('connect', () => UI.setConnection($('conn'), 'online'));
    socket.on('disconnect', () => UI.setConnection($('conn'), 'offline'));
    socket.on('connect_error', (err) => {
      if (err.message === 'not_found') {
        socket.disconnect();
        showMessage(
          'Link invalid sau expirat',
          'Cursa nu a fost găsită. Dacă ați comandat un taxi, sunați la dispecerat pentru detalii.'
        );
      } else {
        UI.setConnection($('conn'), 'offline');
      }
    });
    socket.on('track:update', render);
  }

  function render(view) {
    lastView = view;
    const { ride, car } = view;

    $('car').hidden = false;
    $('plate').textContent = car.plate;
    $('model').textContent = car.model;
    $('driver').textContent = 'Șofer: ' + car.driverFirstName;

    const { title, detail } = describe(view);
    $('status').textContent = title;
    $('eta').textContent = detail;

    const showPickup = ride.status === 'assigned' || ride.status === 'arrived';
    if (showPickup && !pickupMarker) {
      pickupMarker = L.marker([ride.pickup.lat, ride.pickup.lng], { icon: UI.pickupIcon() })
        .bindTooltip('Punctul de preluare', { direction: 'top', offset: [0, -32] })
        .addTo(map);
    } else if (!showPickup && pickupMarker) {
      pickupMarker.remove();
      pickupMarker = null;
    }

    const pos = car.position;
    if (pos) {
      if (!carMarker) {
        carMarker = L.marker([pos.lat, pos.lng], { icon: UI.carIcon(car.plate), zIndexOffset: 1000 }).addTo(map);
      } else {
        UI.animateMarker(carMarker, pos.lat, pos.lng);
      }
      UI.styleCarMarker(carMarker, 'tracked', pos);
    } else if (carMarker) {
      carMarker.remove();
      carMarker = null;
    }

    fitMap(view, !fittedOnce);

    if (ride.status === 'completed' || ride.status === 'cancelled') {
      // Cursa s-a încheiat: nu mai urmărim mașina.
      socket.disconnect();
      $('conn').hidden = true;
    }
  }

  function describe({ ride, car, distanceM, etaMin }) {
    switch (ride.status) {
      case 'assigned':
        if (!car.position) return { title: 'Taxiul este pe drum', detail: 'Așteptăm poziția mașinii…' };
        if (!car.online || UI.isStale(car.position)) {
          return { title: 'Taxiul este pe drum', detail: 'Semnalul mașinii este momentan slab; poziția se va actualiza automat.' };
        }
        return {
          title: etaMin <= 1 ? 'Taxiul ajunge acum' : 'Taxiul ajunge în aprox. ' + etaMin + ' min',
          detail: 'La ' + Geo.formatDistance(distanceM) + ' de dvs.' + (ride.address ? ' · ' + ride.address : ''),
        };
      case 'arrived':
        return { title: 'Taxiul a sosit!', detail: 'Vă așteaptă la punctul de preluare.' };
      case 'in_progress':
        return { title: 'Călătorie plăcută!', detail: 'Sunteți în cursă.' };
      case 'completed':
        return { title: 'Cursa s-a încheiat', detail: 'Vă mulțumim că ați ales serviciile noastre!' };
      case 'cancelled':
        return { title: 'Cursa a fost anulată', detail: 'Pentru detalii, sunați la dispecerat.' };
      default:
        return { title: '', detail: '' };
    }
  }

  function fitMap(view, force) {
    if (userMovedMap && !force) return;
    const points = [];
    if (carMarker) points.push(carMarker.getLatLng());
    if (pickupMarker) points.push(pickupMarker.getLatLng());
    if (!points.length) return;
    fittedOnce = true;
    if (points.length === 1) {
      if (force || !map.getBounds().pad(-0.2).contains(points[0])) map.setView(points[0], 16);
      return;
    }
    const bounds = L.latLngBounds(points);
    // Reîncadrăm doar când ceva iese din zona vizibilă, ca harta să nu „tremure” la fiecare actualizare.
    if (force || !map.getBounds().pad(-0.1).contains(bounds)) {
      map.fitBounds(bounds, { padding: [50, 50], maxZoom: 17 });
    }
  }

  function showMessage(title, text) {
    $('track').hidden = true;
    $('message').hidden = false;
    $('message-title').textContent = title;
    $('message-text').textContent = text;
  }
})();
