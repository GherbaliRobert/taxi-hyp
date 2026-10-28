// Jurnalul de acțiuni: cine ce a făcut și când.
(function () {
  const UI = window.TaxiUI;
  const { el } = UI;
  const $ = (id) => document.getElementById(id);

  const PAGE_SIZE = 100;
  const ACTION_LABELS = {
    auth_login: 'Autentificare',
    auth_login_failed: 'Autentificare eșuată',
    auth_logout: 'Ieșire',
    auth_password_change: 'Și-a schimbat parola',
    ride_create: 'Cursă creată',
    ride_cancel: 'Cursă anulată',
    ride_complete: 'Cursă finalizată',
    ride_status: 'Status cursă schimbat',
    ride_resend: 'Comandă retrimisă',
    ride_sms: 'SMS retrimis clientului',
    car_create: 'Mașină adăugată',
    car_update: 'Mașină modificată',
    car_deactivate: 'Mașină dezactivată',
    car_activate: 'Mașină reactivată',
    user_create: 'Utilizator creat',
    user_update: 'Utilizator modificat',
    user_password_reset: 'Parolă resetată',
    user_deactivate: 'Utilizator dezactivat',
    user_activate: 'Utilizator reactivat',
    history_export: 'Export istoric',
  };

  let offset = 0;
  let total = 0;

  init().catch((err) => UI.toast('Eroare la pornire: ' + err.message, 'error'));

  async function init() {
    const config = await UI.setCompanyName();
    document.title = 'Jurnal · ' + config.companyName;
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
    setRange('7');
    UI.requireDispatcher(start, null, { adminOnly: true, title: 'Jurnal' });
  }

  async function start() {
    const users = await UI.api('/api/users');
    const select = $('user');
    const current = select.value;
    select.replaceChildren(
      el('option', { value: '' }, 'Toți'),
      ...users.map((u) => el('option', { value: u.id }, u.name + ' (' + u.username + ')' + (u.active ? '' : ' — dezactivat')))
    );
    select.value = current;
    await load();
  }

  function setRange(kind) {
    const range = UI.quickRange(kind);
    $('from').value = range.from;
    $('to').value = range.to;
  }

  function reload() {
    offset = 0;
    load().catch((err) => (err.status === 401 ? UI.sessionLost() : UI.toast(err.message, 'error')));
  }

  async function load() {
    const { from, to } = UI.dateInputsRange($('from').value, $('to').value);
    const params = new URLSearchParams({ from, to, limit: PAGE_SIZE, offset });
    if ($('user').value) params.set('userId', $('user').value);
    if ($('category').value) params.set('category', $('category').value);
    const data = await UI.api('/api/audit?' + params);
    total = data.total;
    render(data.entries);
    renderPager();
  }

  function render(entries) {
    const body = $('audit-body');
    if (!entries.length) {
      body.replaceChildren(el('tr', {}, el('td', { colspan: '5', class: 'empty' }, 'Nicio acțiune pentru filtrele alese.')));
      return;
    }
    body.replaceChildren(
      ...entries.map((entry) => {
        const category = entry.action.split('_')[0];
        return el(
          'tr',
          { class: entry.action === 'auth_login_failed' ? 'warning' : '' },
          el('td', { class: 'nowrap c-date' }, UI.formatDateTime(entry.ts)),
          el('td', { class: 'nowrap c-user' }, entry.userName || el('span', { class: 'hint' }, '—')),
          el('td', { class: 'nowrap c-action' }, el('span', { class: 'badge', dataset: { category } }, ACTION_LABELS[entry.action] || entry.action)),
          el('td', { class: 'c-summary' }, entry.summary),
          el('td', { class: 'nowrap hint c-ip' }, entry.ip)
        );
      })
    );
  }

  function renderPager() {
    const pager = $('pager');
    if (total <= PAGE_SIZE) {
      pager.replaceChildren(el('span', { class: 'hint' }, total ? total + (total === 1 ? ' acțiune' : ' acțiuni') : ''));
      return;
    }
    const go = (newOffset) => {
      offset = newOffset;
      load().catch((err) => UI.toast(err.message, 'error'));
    };
    pager.replaceChildren(
      el('button', { class: 'btn btn-sm', type: 'button', disabled: offset === 0, onclick: () => go(Math.max(0, offset - PAGE_SIZE)) }, '‹ Mai noi'),
      el('span', { class: 'hint' }, offset + 1 + '–' + Math.min(offset + PAGE_SIZE, total) + ' din ' + total),
      el('button', { class: 'btn btn-sm', type: 'button', disabled: offset + PAGE_SIZE >= total, onclick: () => go(offset + PAGE_SIZE) }, 'Mai vechi ›')
    );
  }
})();
