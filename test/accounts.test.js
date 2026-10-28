const test = require('node:test');
const assert = require('node:assert/strict');
const { Accounts } = require('../src/accounts');
const { openDatabase, createRepository } = require('../src/db');

const HOUR = 60 * 60 * 1000;

function setup() {
  let t = 1_700_000_000_000;
  const clock = { now: () => t, advance: (ms) => (t += ms) };
  const repo = createRepository(openDatabase(':memory:'));
  const accounts = new Accounts({ repo, now: clock.now, sessionIdleMs: 12 * HOUR });
  const admin = accounts.ensureAdmin('parola-admin');
  const revoked = [];
  accounts.on('sessions:revoked', (e) => revoked.push(e));
  return { accounts, clock, repo, admin, revoked };
}

function addDispatcher(accounts, overrides) {
  return accounts.createUser({ name: 'Maria Ionescu', username: 'maria', role: 'dispatcher', ...overrides });
}

test('prima pornire creează contul admin o singură dată', () => {
  const { accounts, admin } = setup();
  assert.equal(admin.username, 'admin');
  assert.equal(admin.role, 'admin');
  assert.equal(admin.mustChangePassword, false);
  assert.equal(accounts.ensureAdmin('alta'), null);
  assert.equal(accounts.listUsers().length, 1);

  const repo = createRepository(openDatabase(':memory:'));
  assert.throws(() => new Accounts({ repo }).ensureAdmin(''), /ADMIN_PASSWORD/);
  assert.equal(new Accounts({ repo }).ensureAdmin('admin', { mustChangePassword: true }).mustChangePassword, true);
});

test('autentificare: parolă greșită, utilizator inexistent, majuscule', () => {
  const { accounts } = setup();
  assert.equal(accounts.login('admin', 'gresit').ok, false);
  assert.equal(accounts.login('nimeni', 'parola-admin').ok, false);
  assert.equal(accounts.login('admin', undefined).ok, false);
  assert.equal(accounts.login(null, 'x').ok, false);
  // Mesajul nu dezvăluie dacă utilizatorul există.
  assert.equal(accounts.login('nimeni', 'x').error, accounts.login('admin', 'x').error);

  const result = accounts.login(' ADMIN ', 'parola-admin', { ip: '1.2.3.4' });
  assert.equal(result.ok, true);
  assert.ok(result.token.length >= 40);
  assert.equal(accounts.authenticate(result.token).username, 'admin');
  assert.ok(accounts.getUser(result.user.id).lastLoginAt > 0);
});

test('tokenul de sesiune nu se păstrează în clar', () => {
  const { accounts, repo } = setup();
  const { token } = accounts.login('admin', 'parola-admin');
  assert.equal(repo.session(token), null);
  assert.equal(accounts.authenticate(token + 'x'), null);
  assert.equal(accounts.authenticate(''), null);
  assert.equal(accounts.authenticate(undefined), null);
});

test('sesiunea expiră după inactivitate și oricum după 7 zile', () => {
  const { accounts, clock } = setup();
  const idle = accounts.login('admin', 'parola-admin').token;
  clock.advance(11 * HOUR);
  assert.ok(accounts.authenticate(idle)); // activitatea prelungește sesiunea
  clock.advance(11 * HOUR);
  assert.ok(accounts.authenticate(idle));
  clock.advance(13 * HOUR);
  assert.equal(accounts.authenticate(idle), null);

  const active = accounts.login('admin', 'parola-admin').token;
  // Activă la fiecare 6 ore, dar peste 7 zile de la autentificare.
  for (let i = 0; i < 7 * 4 + 1; i++) {
    clock.advance(6 * HOUR);
    accounts.authenticate(active);
  }
  assert.equal(accounts.authenticate(active), null);
});

test('ieșirea închide doar sesiunea curentă', () => {
  const { accounts } = setup();
  const a = accounts.login('admin', 'parola-admin').token;
  const b = accounts.login('admin', 'parola-admin').token;
  accounts.logout(a);
  assert.equal(accounts.authenticate(a), null);
  assert.ok(accounts.authenticate(b));
});

test('utilizator nou: validare și parolă temporară obligatoriu de schimbat', () => {
  const { accounts } = setup();
  assert.match(addDispatcher(accounts, { name: '' }).error, /numele/);
  assert.match(addDispatcher(accounts, { username: 'ab' }).error, /3–32/);
  assert.match(addDispatcher(accounts, { username: 'maria ionescu' }).error, /3–32/);
  assert.match(addDispatcher(accounts, { username: 'mărioara' }).error, /fără diacritice/);
  assert.match(addDispatcher(accounts, { role: 'sef' }).error, /rolul/);
  assert.match(addDispatcher(accounts, { username: 'ADMIN' }).error, /există deja/);

  const created = addDispatcher(accounts, { username: 'Maria.I' });
  assert.equal(created.ok, true, created.error);
  assert.equal(created.user.username, 'maria.i');
  assert.equal(created.user.mustChangePassword, true);
  assert.match(created.temporaryPassword, /^[a-zA-Z2-9]{12}$/);
  assert.ok(!('passwordHash' in created.user));

  const login = accounts.login('maria.i', created.temporaryPassword);
  assert.equal(login.user.mustChangePassword, true);
  assert.equal(accounts.changePassword(login.user.id, 'gresit', 'parola-noua-1').ok, false);
  assert.match(accounts.changePassword(login.user.id, created.temporaryPassword, 'scurta').error, /8 caractere/);
  assert.match(accounts.changePassword(login.user.id, created.temporaryPassword, created.temporaryPassword).error, /diferită/);
  const changed = accounts.changePassword(login.user.id, created.temporaryPassword, 'parola-noua-1', accounts.authenticate(login.token).sessionId);
  assert.equal(changed.ok, true);
  assert.equal(changed.user.mustChangePassword, false);
  assert.ok(accounts.authenticate(login.token)); // sesiunea curentă rămâne
  assert.equal(accounts.login('maria.i', created.temporaryPassword).ok, false);
  assert.equal(accounts.login('maria.i', 'parola-noua-1').ok, true);
});

test('schimbarea parolei închide celelalte sesiuni ale utilizatorului', () => {
  const { accounts, revoked } = setup();
  const here = accounts.login('admin', 'parola-admin').token;
  const elsewhere = accounts.login('admin', 'parola-admin').token;
  const user = accounts.authenticate(here);
  accounts.changePassword(user.id, 'parola-admin', 'parola-admin-2', user.sessionId);
  assert.ok(accounts.authenticate(here));
  assert.equal(accounts.authenticate(elsewhere), null);
  assert.deepEqual(revoked, [{ userId: user.id, exceptSessionId: user.sessionId }]);
});

test('resetarea parolei: parolă temporară nouă și deconectare', () => {
  const { accounts, admin, revoked } = setup();
  const { user, temporaryPassword } = addDispatcher(accounts);
  accounts.changePassword(user.id, temporaryPassword, 'parola-maria', '');
  const token = accounts.login('maria', 'parola-maria').token;
  assert.ok(accounts.authenticate(token));

  assert.match(accounts.resetPassword(admin.id, admin.id).error, /Schimbă parola/);
  const reset = accounts.resetPassword(user.id, admin.id);
  assert.equal(reset.ok, true);
  assert.equal(reset.user.mustChangePassword, true);
  assert.equal(accounts.authenticate(token), null);
  assert.equal(accounts.login('maria', 'parola-maria').ok, false);
  assert.equal(accounts.login('maria', reset.temporaryPassword).ok, true);
  assert.deepEqual(revoked.at(-1), { userId: user.id, exceptSessionId: '' });
});

test('dezactivarea închide sesiunile și blochează autentificarea', () => {
  const { accounts, admin } = setup();
  const { user, temporaryPassword } = addDispatcher(accounts);
  const token = accounts.login('maria', temporaryPassword).token;
  assert.equal(accounts.setActive(user.id, false, admin.id).changed, true);
  assert.equal(accounts.authenticate(token), null);
  assert.equal(accounts.login('maria', temporaryPassword).ok, false);
  assert.equal(accounts.setActive(user.id, false, admin.id).changed, false);
  assert.equal(accounts.setActive(user.id, true, admin.id).ok, true);
  assert.equal(accounts.login('maria', temporaryPassword).ok, true);
});

test('rămâne mereu cel puțin un administrator activ', () => {
  const { accounts, admin } = setup();
  assert.match(accounts.setActive(admin.id, false, admin.id).error, /propriul cont/);
  assert.match(accounts.updateUser(admin.id, { ...admin, role: 'dispatcher' }, admin.id).error, /propriul rol/);

  const second = accounts.createUser({ name: 'Șef tură', username: 'sef', role: 'admin' }).user;
  // Al doilea administrator îl poate retrograda pe primul…
  assert.equal(accounts.updateUser(admin.id, { ...admin, role: 'dispatcher' }, second.id).ok, true);
  // …dar nu și pe sine, iar ultimul administrator nu poate fi dezactivat sau retrogradat de nimeni.
  assert.match(accounts.setActive(second.id, false, admin.id).error, /cel puțin un administrator/);
  assert.match(accounts.updateUser(second.id, { ...second, role: 'dispatcher' }, admin.id).error, /cel puțin un administrator/);
});

test('modificarea utilizatorului raportează ce s-a schimbat', () => {
  const { accounts, admin } = setup();
  const { user } = addDispatcher(accounts);
  const result = accounts.updateUser(user.id, { name: 'Maria Pop', username: 'maria', role: 'admin' }, admin.id);
  assert.deepEqual(result.changes, { name: ['Maria Ionescu', 'Maria Pop'], role: ['dispatcher', 'admin'] });
  assert.match(accounts.updateUser(user.id, { name: 'X', username: 'admin', role: 'admin' }, admin.id).error, /există deja/);
});

test('lista utilizatorilor arată sesiunile active, fără hash-uri de parolă', () => {
  const { accounts, clock } = setup();
  accounts.login('admin', 'parola-admin');
  accounts.login('admin', 'parola-admin');
  const [admin] = accounts.listUsers();
  assert.equal(admin.activeSessions, 2);
  assert.ok(!JSON.stringify(accounts.listUsers()).includes('scrypt'));

  clock.advance(13 * HOUR);
  assert.equal(accounts.listUsers()[0].activeSessions, 0);
  assert.equal(accounts.pruneSessions(), 2);
});
