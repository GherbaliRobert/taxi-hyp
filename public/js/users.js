// Administrarea conturilor: dispeceri și administratori.
(function () {
  const UI = window.TaxiUI;
  const { el } = UI;
  const $ = (id) => document.getElementById(id);

  let users = [];
  let me = null;
  let editingId = null;

  init().catch((err) => UI.toast('Eroare la pornire: ' + err.message, 'error'));

  async function init() {
    const config = await UI.setCompanyName();
    document.title = 'Utilizatori · ' + config.companyName;
    $('add').addEventListener('click', () => openEditor(null));
    $('cancel').addEventListener('click', closeEditor);
    $('editor').addEventListener('submit', save);
    UI.requireDispatcher(
      async (user) => {
        me = user;
        await load();
      },
      null,
      { adminOnly: true, title: 'Utilizatori' }
    );
  }

  async function load() {
    users = await UI.api('/api/users');
    render();
  }

  function render() {
    $('users-body').replaceChildren(
      ...users.map((user) => {
        const self = user.id === me.id;
        return el(
          'tr',
          { class: user.active ? '' : 'inactive' },
          el('td', {}, el('strong', {}, user.name), self ? el('span', { class: 'hint' }, ' (dvs.)') : null),
          el('td', { class: 'mono-cell' }, user.username),
          el('td', {}, el('span', { class: 'badge', dataset: { role: user.role } }, UI.ROLE_LABELS[user.role])),
          el('td', {}, stateBadge(user)),
          el('td', { class: 'nowrap hint' }, user.lastLoginAt ? UI.timeAgo(user.lastLoginAt) : 'niciodată'),
          el(
            'td',
            {},
            el(
              'div',
              { class: 'row-actions' },
              el('button', { class: 'btn btn-sm', type: 'button', onclick: () => openEditor(user) }, 'Modifică'),
              self ? null : el('button', { class: 'btn btn-sm', type: 'button', onclick: () => resetPassword(user) }, 'Resetează parola'),
              self
                ? null
                : el(
                    'button',
                    { class: 'btn btn-sm' + (user.active ? ' btn-danger' : ''), type: 'button', onclick: () => toggleActive(user) },
                    user.active ? 'Dezactivează' : 'Reactivează'
                  )
            )
          )
        );
      })
    );
  }

  function stateBadge(user) {
    if (!user.active) return el('span', { class: 'badge' }, 'Dezactivat');
    if (user.mustChangePassword) return el('span', { class: 'badge', dataset: { status: 'assigned' } }, 'Parolă temporară');
    const sessions = user.activeSessions;
    return el(
      'span',
      { class: 'badge', dataset: { status: 'free' } },
      'Activ' + (sessions ? ' · ' + sessions + (sessions === 1 ? ' sesiune deschisă' : ' sesiuni deschise') : '')
    );
  }

  // ---------- Formular ----------

  function openEditor(user) {
    editingId = user ? user.id : null;
    $('editor-title').textContent = user ? 'Modifică ' + user.name : 'Utilizator nou';
    $('name').value = user ? user.name : '';
    $('username').value = user ? user.username : '';
    $('role').value = user ? user.role : 'dispatcher';
    // Propriul rol nu se poate schimba (ar putea lăsa firma fără administrator).
    $('role').disabled = Boolean(user && user.id === me.id);
    $('editor-hint').textContent = user
      ? ''
      : 'Se generează o parolă temporară, pe care persoana o schimbă la prima autentificare.';
    $('editor-error').textContent = '';
    $('saved').hidden = true;
    $('editor').hidden = false;
    $('name').focus();
  }

  function closeEditor() {
    $('editor').hidden = true;
    editingId = null;
  }

  async function save(e) {
    e.preventDefault();
    const body = { name: $('name').value, username: $('username').value, role: $('role').value };
    const button = e.submitter || $('editor').querySelector('button[type=submit]');
    button.disabled = true;
    try {
      if (editingId) {
        await UI.api('/api/users/' + editingId, { method: 'PUT', body });
        UI.toast('Modificările au fost salvate', 'success');
      } else {
        const result = await UI.api('/api/users', { method: 'POST', body });
        showCredentials(result.user, result.temporaryPassword, 'Cont creat');
      }
      closeEditor();
      await load();
    } catch (err) {
      if (err.status === 401) return UI.sessionLost();
      $('editor-error').textContent = err.message;
    } finally {
      button.disabled = false;
    }
  }

  async function resetPassword(user) {
    if (!confirm('Resetați parola pentru ' + user.name + '?\n\nPersoana este deconectată imediat și primește o parolă temporară.')) return;
    try {
      const result = await UI.api('/api/users/' + user.id + '/reset-password', { method: 'POST' });
      showCredentials(result.user, result.temporaryPassword, 'Parolă resetată');
      await load();
    } catch (err) {
      UI.toast(err.message, 'error');
    }
  }

  async function toggleActive(user) {
    if (user.active && !confirm('Dezactivați contul lui ' + user.name + '?\n\nPersoana este deconectată imediat și nu se mai poate autentifica. Istoricul acțiunilor rămâne în jurnal.')) {
      return;
    }
    try {
      await UI.api('/api/users/' + user.id, { method: 'PUT', body: { active: !user.active } });
      UI.toast(user.name + (user.active ? ' a fost dezactivat' : ' a fost reactivat'), 'success');
      await load();
    } catch (err) {
      UI.toast(err.message, 'error');
    }
  }

  /** Parola temporară se arată o singură dată: în baza de date se păstrează doar hash-ul ei. */
  function showCredentials(user, password, title) {
    const text = 'Utilizator: ' + user.username + '\nParolă temporară: ' + password;
    $('saved').replaceChildren(
      el('strong', {}, title + ': ' + user.name),
      el(
        'div',
        { class: 'credentials' },
        'Utilizator ',
        el('strong', { class: 'mono' }, user.username),
        ' · Parolă temporară ',
        el('strong', { class: 'mono' }, password)
      ),
      el(
        'p',
        { class: 'hint' },
        'Comunicați aceste date persoanei (verbal sau pe un canal sigur). La prima autentificare își va alege propria parolă. Parola temporară nu mai poate fi afișată ulterior.'
      ),
      el(
        'div',
        { class: 'row' },
        el('button', { class: 'btn btn-sm', type: 'button', onclick: async () => UI.toast((await UI.copyText(text)) ? 'Copiat' : 'Nu s-a putut copia') }, 'Copiază'),
        el('button', { class: 'btn btn-sm', type: 'button', onclick: () => ($('saved').hidden = true) }, 'Am notat')
      )
    );
    $('saved').hidden = false;
  }
})();
