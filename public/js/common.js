// Funcții comune pentru paginile aplicației (dispecerat, șofer, urmărire client).
(function () {
  const CAR_STATUS_LABELS = { free: 'Liber', busy: 'Ocupat', offline: 'Deconectat' };
  const RIDE_STATUS_LABELS = {
    assigned: 'Mașină în drum',
    arrived: 'Mașina a sosit',
    in_progress: 'În cursă',
    completed: 'Finalizată',
    cancelled: 'Anulată',
  };
  // După cât timp fără poziție nouă considerăm semnalul GPS pierdut.
  const STALE_AFTER_MS = 60 * 1000;

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    })[ch]);
  }

  /** Construiește un element DOM: el('div', { class: 'x', onclick: fn }, 'text', copil). */
  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === undefined || value === null || value === false) continue;
      if (key.startsWith('on') && typeof value === 'function') {
        node.addEventListener(key.slice(2), value);
      } else if (key === 'class') {
        node.className = value;
      } else if (key === 'dataset') {
        Object.assign(node.dataset, value);
      } else {
        node.setAttribute(key, value === true ? '' : value);
      }
    }
    for (const child of children.flat()) {
      if (child === undefined || child === null || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  async function loadConfig() {
    const res = await fetch('/api/config');
    if (!res.ok) throw new Error('Nu s-a putut încărca configurația');
    return res.json();
  }

  function createMap(element, config, options) {
    const map = L.map(element, options).setView(config.mapCenter, config.mapZoom);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);
    return map;
  }

  function carIcon(label) {
    return L.divIcon({
      className: 'car-icon',
      html:
        '<div class="car-marker">' +
        '<div class="car-heading"></div>' +
        '<div class="car-body"><svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M5 11l1.5-4.5A2 2 0 0 1 8.4 5h7.2a2 2 0 0 1 1.9 1.5L19 11v6a1 1 0 0 1-1 1h-1a1 1 0 0 1-1-1v-1H8v1a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-6zm2.2 0h9.6l-1-3.2a.5.5 0 0 0-.5-.3H8.7a.5.5 0 0 0-.5.3L7.2 11zM7.5 14.5a1.2 1.2 0 1 0 0-2.4 1.2 1.2 0 0 0 0 2.4zm9 0a1.2 1.2 0 1 0 0-2.4 1.2 1.2 0 0 0 0 2.4z"/></svg></div>' +
        (label ? '<div class="car-label">' + escapeHtml(label) + '</div>' : '') +
        '</div>',
      iconSize: [36, 36],
      iconAnchor: [18, 18],
    });
  }

  function pickupIcon() {
    return L.divIcon({
      className: 'pickup-icon',
      html: '<div class="pickup-pin"><span></span></div>',
      iconSize: [30, 40],
      iconAnchor: [15, 38],
    });
  }

  /** Actualizează culoarea (după status) și săgeata de direcție a unui marker de mașină. */
  function styleCarMarker(marker, status, position) {
    const root = marker.getElement() && marker.getElement().querySelector('.car-marker');
    if (!root) return;
    root.dataset.status = status;
    root.classList.toggle('stale', isStale(position));
    const arrow = root.querySelector('.car-heading');
    const heading = position && position.heading;
    if (typeof heading === 'number') {
      arrow.style.display = '';
      arrow.style.transform = 'rotate(' + heading + 'deg)';
    } else {
      arrow.style.display = 'none';
    }
  }

  /** Mută markerul lin până la noua poziție, ca mașina să nu „sară” pe hartă. */
  function animateMarker(marker, lat, lng, duration) {
    const to = L.latLng(lat, lng);
    const from = marker.getLatLng();
    if (marker._taxiAnim) cancelAnimationFrame(marker._taxiAnim);
    if (document.hidden || from.distanceTo(to) > 3000) {
      marker.setLatLng(to);
      return;
    }
    const total = duration || 900;
    const start = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - start) / total);
      marker.setLatLng([from.lat + (to.lat - from.lat) * t, from.lng + (to.lng - from.lng) * t]);
      marker._taxiAnim = t < 1 ? requestAnimationFrame(step) : null;
    };
    marker._taxiAnim = requestAnimationFrame(step);
  }

  function isStale(position) {
    return Boolean(position && Date.now() - position.ts > STALE_AFTER_MS);
  }

  function timeAgo(ts) {
    if (!ts) return 'niciodată';
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return 'acum ' + s + ' s';
    const m = Math.round(s / 60);
    if (m < 60) return 'acum ' + m + ' min';
    return 'acum ' + Math.round(m / 60) + ' h';
  }

  function formatTime(ts) {
    return new Date(ts).toLocaleTimeString('ro-RO', { hour: '2-digit', minute: '2-digit' });
  }

  /** Indicatorul de conexiune din antet: 'online' | 'offline' | 'connecting'. */
  function setConnection(node, state) {
    const labels = { online: 'Conectat', offline: 'Deconectat', connecting: 'Se conectează…' };
    node.dataset.state = state;
    node.textContent = labels[state];
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Clipboard API cere HTTPS; varianta veche funcționează și pe HTTP.
      const area = el('textarea', { style: 'position:fixed;opacity:0' }, text);
      document.body.append(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      return ok;
    }
  }

  function toast(message, kind) {
    let box = document.querySelector('.toasts');
    if (!box) {
      box = el('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
      document.body.append(box);
    }
    const item = el('div', { class: 'toast ' + (kind || '') }, message);
    box.append(item);
    setTimeout(() => item.remove(), 4000);
  }

  // ---------- Paginile dispeceratului: conturi și sesiuni ----------
  //
  // Sesiunea este un cookie HttpOnly pus de server la autentificare: JavaScript-ul paginii nu vede
  // nici parola, nici tokenul. Aici doar întrebăm serverul cine este utilizatorul curent.

  const ROLE_LABELS = { admin: 'Administrator', dispatcher: 'Dispecer' };
  let currentUser = null;

  /** Apel către API-ul dispeceratului; aruncă o eroare cu `status` (și `code`) la răspunsuri negative. */
  async function api(path, options) {
    const { method = 'GET', body } = options || {};
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (!res.ok) {
      const error = new Error((data && data.error) || 'Eroare ' + res.status);
      error.status = res.status;
      error.code = data && data.code;
      throw error;
    }
    return data;
  }

  /** Sesiunea a expirat sau a fost închisă (ex. cont dezactivat): reîncărcăm pagina de autentificare. */
  function sessionLost() {
    location.reload();
  }

  async function logout() {
    try {
      await api('/api/logout', { method: 'POST' });
    } finally {
      location.reload();
    }
  }

  function passwordFields(prefix, withCurrent) {
    const field = (id, label, autocomplete) =>
      el(
        'div',
        { class: 'field' },
        el('label', { for: prefix + id }, label),
        el('input', { class: 'input', id: prefix + id, type: 'password', autocomplete, required: true })
      );
    return [
      withCurrent ? field('current', 'Parola actuală', 'current-password') : null,
      field('new', 'Parola nouă (cel puțin 8 caractere)', 'new-password'),
      field('confirm', 'Repetați parola nouă', 'new-password'),
    ];
  }

  /** Trimite formularul de schimbare a parolei; întoarce utilizatorul actualizat sau aruncă eroarea. */
  async function submitPasswordChange(prefix) {
    const value = (id) => document.getElementById(prefix + id).value;
    if (value('new') !== value('confirm')) throw new Error('Parolele noi nu coincid');
    const { user } = await api('/api/me/password', {
      method: 'POST',
      body: { currentPassword: value('current'), newPassword: value('new') },
    });
    return user;
  }

  /** Ecranul de autentificare, comun tuturor paginilor dispeceratului (creat la nevoie). */
  function authScreen() {
    let screen = document.getElementById('auth');
    if (screen) return screen;
    screen = el('div', { id: 'auth', class: 'login', hidden: true }, el('div', { class: 'login-card', id: 'auth-card' }));
    document.body.prepend(screen);
    return screen;
  }

  function showAuthCard(...children) {
    const app = document.getElementById('app');
    if (app) app.hidden = true;
    authScreen().hidden = false;
    document
      .getElementById('auth-card')
      .replaceChildren(el('div', { class: 'brand' }, el('div', { class: 'brand-logo' }, 'TX'), el('span', { class: 'company-name' }, companyName)), ...children);
  }

  let companyName = 'Taxi';

  /**
   * Pornește o pagină a dispeceratului după autentificare.
   * `start(user)` încarcă datele paginii; `onShown` rulează după ce pagina devine vizibilă
   * (ex. pentru a redimensiona harta). Cu `adminOnly`, dispecerii văd un mesaj în loc de pagină.
   */
  function requireDispatcher(start, onShown, options) {
    const { adminOnly = false, title = 'Dispecerat' } = options || {};

    function showLogin(message) {
      showAuthCard(
        el('h1', {}, title),
        el('p', { class: 'hint' }, 'Autentificați-vă cu contul primit de la administrator.'),
        el(
          'form',
          { id: 'login-form', onsubmit: onLogin },
          el('div', { class: 'field' }, el('label', { for: 'login-username' }, 'Utilizator'),
            el('input', { class: 'input', id: 'login-username', autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false', required: true })),
          el('div', { class: 'field' }, el('label', { for: 'login-password' }, 'Parolă'),
            el('input', { class: 'input', id: 'login-password', type: 'password', autocomplete: 'current-password', required: true })),
          el('p', { class: 'error-text', id: 'login-error' }, message || ''),
          el('button', { class: 'btn btn-primary btn-block', type: 'submit' }, 'Intră')
        )
      );
      document.getElementById('login-username').focus();
    }

    async function onLogin(e) {
      e.preventDefault();
      const button = e.submitter;
      if (button) button.disabled = true;
      try {
        const { user } = await api('/api/login', {
          method: 'POST',
          body: { username: document.getElementById('login-username').value, password: document.getElementById('login-password').value },
        });
        await proceed(user);
      } catch (err) {
        document.getElementById('login-error').textContent = err.message;
        document.getElementById('login-password').value = '';
        document.getElementById('login-password').focus();
      } finally {
        if (button) button.disabled = false;
      }
    }

    function showForcedPasswordChange(user) {
      showAuthCard(
        el('h1', {}, 'Bun venit, ' + user.name.split(/\s+/)[0] + '!'),
        el('p', { class: 'hint' }, 'Contul are o parolă temporară. Alegeți-vă acum parola personală; doar dvs. o veți cunoaște.'),
        el(
          'form',
          {
            onsubmit: async (e) => {
              e.preventDefault();
              try {
                await proceed(await submitPasswordChange('first-'));
                toast('Parola a fost schimbată', 'success');
              } catch (err) {
                if (err.status === 401) return sessionLost();
                document.getElementById('first-error').textContent = err.message;
              }
            },
          },
          passwordFields('first-', true),
          el('p', { class: 'error-text', id: 'first-error' }),
          el('button', { class: 'btn btn-primary btn-block', type: 'submit' }, 'Salvează parola'),
          el('button', { class: 'btn btn-block', type: 'button', style: 'margin-top:8px', onclick: logout }, 'Ieșire')
        )
      );
      document.getElementById('first-current').focus();
    }

    function showForbidden(user) {
      showAuthCard(
        el('h1', {}, 'Acces restricționat'),
        el('p', {}, 'Această pagină este disponibilă doar administratorilor. Sunteți autentificat ca ', el('strong', {}, user.name), ' (dispecer).'),
        el('a', { class: 'btn btn-primary btn-block', href: '/' }, 'Mergi la hartă')
      );
    }

    async function proceed(user) {
      currentUser = user;
      if (user.mustChangePassword) return showForcedPasswordChange(user);
      if (adminOnly && user.role !== 'admin') return showForbidden(user);
      setupHeader(user);
      try {
        await start(user);
      } catch (err) {
        if (err.status === 401) return sessionLost();
        toast(err.message, 'error');
      }
      authScreen().hidden = true;
      document.getElementById('app').hidden = false;
      if (onShown) onShown();
    }

    loadConfig()
      .then((config) => (companyName = config.companyName))
      .catch(() => {})
      .then(() => api('/api/me'))
      .then(({ user }) => proceed(user))
      .catch((err) => {
        if (err.status === 401) showLogin();
        else showLogin('Serverul nu răspunde. Reîncercați.');
      });
  }

  /** Meniul utilizatorului din antet și ascunderea paginilor rezervate administratorilor. */
  function setupHeader(user) {
    document.querySelectorAll('[data-admin]').forEach((node) => (node.hidden = user.role !== 'admin'));
    // Pe telefon meniul se derulează orizontal: aducem pagina curentă în vizor.
    const current = document.querySelector('.nav a[aria-current="page"]');
    if (current) requestAnimationFrame(() => current.scrollIntoView({ inline: 'nearest', block: 'nearest' }));
    const container = document.getElementById('user-menu');
    if (!container) return;
    const menu = el(
      'div',
      { class: 'menu-panel', hidden: true },
      el('div', { class: 'menu-head' }, el('strong', {}, user.name), el('span', { class: 'hint' }, user.username + ' · ' + ROLE_LABELS[user.role])),
      el('button', { type: 'button', onclick: () => { menu.hidden = true; openPasswordDialog(); } }, 'Schimbă parola'),
      el('button', { type: 'button', onclick: logout }, 'Ieșire')
    );
    const initials = user.name.split(/\s+/).map((part) => part[0]).slice(0, 2).join('').toUpperCase();
    const toggle = el(
      'button',
      { class: 'user-button', type: 'button', 'aria-haspopup': 'true', title: user.name, onclick: (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; } },
      el('span', { class: 'avatar' }, initials),
      el('span', { class: 'user-name' }, user.name.split(/\s+/)[0])
    );
    document.addEventListener('click', (e) => {
      if (!container.contains(e.target)) menu.hidden = true;
    });
    container.replaceChildren(toggle, menu);
  }

  function openPasswordDialog() {
    const dialog = el(
      'dialog',
      { class: 'dialog' },
      el(
        'form',
        {
          method: 'dialog',
          onsubmit: async (e) => {
            e.preventDefault();
            try {
              await submitPasswordChange('dlg-');
              dialog.close();
              toast('Parola a fost schimbată. Celelalte sesiuni ale dvs. au fost închise.', 'success');
            } catch (err) {
              if (err.status === 401) return sessionLost();
              document.getElementById('dlg-error').textContent = err.message;
            }
          },
        },
        el('h2', { class: 'card-title' }, 'Schimbă parola'),
        passwordFields('dlg-', true),
        el('p', { class: 'error-text', id: 'dlg-error' }),
        el(
          'div',
          { class: 'row' },
          el('button', { class: 'btn btn-primary', type: 'submit' }, 'Salvează'),
          el('button', { class: 'btn', type: 'button', onclick: () => dialog.close() }, 'Renunță')
        )
      )
    );
    dialog.addEventListener('close', () => dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
  }

  // ---------- Perioade pentru filtre (istoric, jurnal) ----------

  function toDateInput(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function fromDateInput(value) {
    const [y, m, d] = value.split('-').map(Number);
    return new Date(y, m - 1, d);
  }

  /** Perioadele rapide: 'today', 'yesterday', '7' (ultimele 7 zile), 'month', 'prev-month'. */
  function quickRange(kind) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    let from = new Date(today);
    let to = new Date(today);
    if (kind === 'yesterday') {
      from.setDate(from.getDate() - 1);
      to = new Date(from);
    } else if (kind === '7') {
      from.setDate(from.getDate() - 6);
    } else if (kind === 'month') {
      from.setDate(1);
    } else if (kind === 'prev-month') {
      from = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      to = new Date(today.getFullYear(), today.getMonth(), 0);
    }
    return { from: toDateInput(from), to: toDateInput(to) };
  }

  /** Intervalul [from, to) în ms din două câmpuri de tip dată; ziua de sfârșit este inclusă. */
  function dateInputsRange(fromValue, toValue) {
    if (!fromValue || !toValue) throw new Error('Alegeți perioada');
    const from = fromDateInput(fromValue);
    const to = fromDateInput(toValue);
    if (from > to) throw new Error('Data de început este după data de sfârșit');
    to.setDate(to.getDate() + 1);
    return { from: from.getTime(), to: to.getTime() };
  }

  function formatDateTime(ts) {
    return new Date(ts).toLocaleString('ro-RO', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function formatMinutes(ms) {
    if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
    if (ms < 60000) return '< 1 min';
    const minutes = Math.round(ms / 60000);
    if (minutes < 60) return minutes + ' min';
    return Math.floor(minutes / 60) + ' h ' + (minutes % 60) + ' min';
  }

  function formatKm(meters) {
    return (meters / 1000).toLocaleString('ro-RO', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + ' km';
  }

  async function setCompanyName() {
    const config = await loadConfig();
    document.querySelectorAll('.company-name').forEach((n) => (n.textContent = config.companyName));
    return config;
  }

  window.TaxiUI = {
    CAR_STATUS_LABELS,
    RIDE_STATUS_LABELS,
    escapeHtml,
    el,
    loadConfig,
    setCompanyName,
    createMap,
    carIcon,
    pickupIcon,
    styleCarMarker,
    animateMarker,
    isStale,
    timeAgo,
    formatTime,
    formatDateTime,
    formatMinutes,
    quickRange,
    dateInputsRange,
    formatKm,
    setConnection,
    copyText,
    toast,
    ROLE_LABELS,
    api,
    requireDispatcher,
    sessionLost,
    logout,
    get currentUser() {
      return currentUser;
    },
  };
})();
