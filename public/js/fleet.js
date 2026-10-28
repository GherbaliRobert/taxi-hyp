// Administrarea flotei: mașini, șoferi, PIN-uri, activare / dezactivare.
(function () {
  const UI = window.TaxiUI;
  const { el } = UI;
  const $ = (id) => document.getElementById(id);

  let cars = [];
  let editingId = null;

  init().catch((err) => UI.toast('Eroare la pornire: ' + err.message, 'error'));

  async function init() {
    const config = await UI.setCompanyName();
    document.title = 'Flotă · ' + config.companyName;
    $('driver-url').replaceChildren(
      'Șoferii intră în aplicație la ',
      el('a', { href: '/driver', target: '_blank', rel: 'noopener' }, location.origin + '/driver'),
      ', alegând mașina și introducând PIN-ul.'
    );

    $('add').addEventListener('click', () => openEditor(null));
    $('cancel').addEventListener('click', closeEditor);
    $('generate-pin').addEventListener('click', () => ($('pin').value = randomPin()));
    $('editor').addEventListener('submit', save);

    UI.requireDispatcher(load);
    // Starea mașinilor (liberă / ocupată / deconectată) se reîmprospătează periodic.
    setInterval(() => !$('app').hidden && load().catch(() => {}), 30000);
  }

  async function load() {
    cars = await UI.api('/api/fleet');
    render();
  }

  function render() {
    if (!cars.length) {
      $('cars-body').replaceChildren(
        el('tr', {}, el('td', { colspan: '5', class: 'empty' }, 'Nicio mașină. Adăugați prima mașină a flotei.'))
      );
      return;
    }
    $('cars-body').replaceChildren(
      ...cars.map((car) =>
        el(
          'tr',
          { class: car.active ? '' : 'inactive' },
          el('td', { class: 'nowrap' }, el('strong', {}, car.plate), car.model ? el('div', { class: 'hint' }, car.model) : null),
          el('td', {}, car.driver),
          el('td', {}, stateBadge(car)),
          el('td', { class: 'nowrap hint' }, car.lastSeen ? UI.timeAgo(car.lastSeen) : 'niciodată'),
          el(
            'td',
            { class: 'num nowrap' },
            el('button', { class: 'btn btn-sm', type: 'button', onclick: () => openEditor(car) }, 'Modifică'),
            ' ',
            el(
              'button',
              { class: 'btn btn-sm' + (car.active ? ' btn-danger' : ''), type: 'button', onclick: () => toggleActive(car) },
              car.active ? 'Dezactivează' : 'Reactivează'
            )
          )
        )
      )
    );
  }

  function stateBadge(car) {
    if (!car.active) return el('span', { class: 'badge' }, 'Dezactivată');
    const label = UI.CAR_STATUS_LABELS[car.status] + (car.rideId ? ' · cursa #' + car.rideId : '');
    return el('span', { class: 'badge', dataset: { status: car.status } }, label);
  }

  // ---------- Formular ----------

  function openEditor(car) {
    editingId = car ? car.id : null;
    $('editor-title').textContent = car ? 'Modifică ' + car.plate : 'Mașină nouă';
    $('plate').value = car ? car.plate : '';
    $('model').value = car ? car.model : '';
    $('driver').value = car ? car.driver : '';
    $('pin').value = car ? '' : randomPin();
    $('pin').placeholder = car ? 'lăsați gol pentru a păstra PIN-ul' : '';
    $('pin-hint').textContent = car
      ? 'Completați doar pentru a schimba PIN-ul. Șoferul va fi deconectat și va intra cu PIN-ul nou.'
      : 'Între 4 și 12 cifre. Îl veți comunica șoferului.';
    $('editor-error').textContent = '';
    $('saved').hidden = true;
    $('editor').hidden = false;
    $('plate').focus();
  }

  function closeEditor() {
    $('editor').hidden = true;
    editingId = null;
  }

  async function save(e) {
    e.preventDefault();
    const body = {
      plate: $('plate').value,
      model: $('model').value,
      driver: $('driver').value,
      pin: $('pin').value.trim(),
    };
    if (editingId && !body.pin) delete body.pin;
    const button = e.submitter || $('editor').querySelector('button[type=submit]');
    button.disabled = true;
    try {
      const result = editingId
        ? await UI.api('/api/fleet/' + encodeURIComponent(editingId), { method: 'PUT', body })
        : await UI.api('/api/fleet', { method: 'POST', body });
      closeEditor();
      showSaved(result.car, body.pin);
      await load();
    } catch (err) {
      if (err.status === 401) {
        UI.session.clear();
        location.reload();
        return;
      }
      $('editor-error').textContent = err.message;
    } finally {
      button.disabled = false;
    }
  }

  /** Un PIN nou se afișează o singură dată: în baza de date se păstrează doar hash-ul lui. */
  function showSaved(car, pin) {
    if (!pin) {
      UI.toast('Modificările au fost salvate', 'success');
      return;
    }
    $('saved').replaceChildren(
      el('strong', {}, 'Date de acces pentru șofer'),
      el('div', { class: 'credentials' }, 'Mașina ', el('strong', {}, car.plate), ' · PIN ', el('strong', { class: 'mono' }, pin)),
      el('p', { class: 'hint' }, 'Comunicați acum PIN-ul șoferului. Din motive de securitate nu mai poate fi afișat ulterior (se poate doar schimba).'),
      el('button', { class: 'btn btn-sm', type: 'button', onclick: () => ($('saved').hidden = true) }, 'Am notat')
    );
    $('saved').hidden = false;
  }

  async function toggleActive(car) {
    if (
      car.active &&
      !confirm('Dezactivați ' + car.plate + '?\n\nMașina dispare de pe hartă, iar șoferul este deconectat. Istoricul curselor rămâne.')
    ) {
      return;
    }
    try {
      await UI.api('/api/fleet/' + encodeURIComponent(car.id), { method: 'PUT', body: { active: !car.active } });
      UI.toast(car.plate + (car.active ? ' a fost dezactivată' : ' a fost reactivată'), 'success');
      await load();
    } catch (err) {
      UI.toast(err.message, 'error');
    }
  }

  function randomPin() {
    const value = new Uint32Array(1);
    crypto.getRandomValues(value);
    return String(value[0] % 1000000).padStart(6, '0');
  }
})();
