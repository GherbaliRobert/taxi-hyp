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

  // ---------- Paginile dispeceratului: parola se ține doar pe durata sesiunii (tab-ului) ----------

  const PASSWORD_KEY = 'taxi.dispatcherPassword';
  const session = {
    get() {
      try {
        return sessionStorage.getItem(PASSWORD_KEY);
      } catch {
        return null;
      }
    },
    set(value) {
      try {
        sessionStorage.setItem(PASSWORD_KEY, value);
      } catch {
        // Fără sessionStorage parola se cere la fiecare pagină.
      }
    },
    clear() {
      try {
        sessionStorage.removeItem(PASSWORD_KEY);
      } catch {
        // ignorat
      }
    },
  };

  /** Apel către API-ul dispeceratului; aruncă o eroare cu `status` la răspunsuri negative. */
  async function api(path, options) {
    const { method = 'GET', body } = options || {};
    const headers = { Authorization: 'Bearer ' + (session.get() || '') };
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
      throw error;
    }
    return data;
  }

  /**
   * Autentificarea pentru paginile care folosesc API-ul (istoric, flotă).
   * `start` încarcă datele paginii; dacă parola lipsește sau e greșită, se afișează formularul.
   * `onShown` rulează după ce pagina devine vizibilă (ex. pentru a redimensiona harta).
   */
  function requireDispatcher(start, onShown) {
    const $ = (id) => document.getElementById(id);
    const showLogin = (message) => {
      $('app').hidden = true;
      $('login').hidden = false;
      $('login-error').textContent = message || '';
      $('password').value = '';
      $('password').focus();
    };
    async function attempt(fromForm) {
      try {
        await start();
        $('login').hidden = true;
        $('app').hidden = false;
        if (onShown) onShown();
      } catch (err) {
        if (err.status === 401 || err.status === 429) {
          session.clear();
          showLogin(err.status === 429 ? err.message : fromForm ? 'Parolă greșită.' : '');
        } else {
          $('login').hidden = true;
          $('app').hidden = false;
          if (onShown) onShown();
          toast(err.message, 'error');
        }
      }
    }
    $('login-form').addEventListener('submit', (e) => {
      e.preventDefault();
      session.set($('password').value);
      attempt(true);
    });
    $('logout').addEventListener('click', () => {
      session.clear();
      location.reload();
    });
    if (session.get()) attempt(false);
    else showLogin();
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
    formatKm,
    setConnection,
    copyText,
    toast,
    session,
    api,
    requireDispatcher,
  };
})();
