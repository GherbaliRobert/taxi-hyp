const test = require('node:test');
const assert = require('node:assert/strict');
const { createSmsSender, normalizePhone, toPlainText, rideSmsText } = require('../src/sms');
const { loadSmsConfig } = require('../src/config');

test('numerele de telefon devin format internațional', () => {
  assert.equal(normalizePhone('0722 123 456'), '+40722123456');
  assert.equal(normalizePhone('0722-123-456'), '+40722123456');
  assert.equal(normalizePhone('(0722) 123.456'), '+40722123456');
  assert.equal(normalizePhone('+40 722 123 456'), '+40722123456');
  assert.equal(normalizePhone('0040722123456'), '+40722123456');
  assert.equal(normalizePhone('722123456'), '+40722123456');
  assert.equal(normalizePhone('+44 7700 900123'), '+447700900123');
  assert.equal(normalizePhone('0612345678', '33'), '+33612345678');
  assert.equal(normalizePhone('0722'), null);
  assert.equal(normalizePhone('fără telefon'), null);
  assert.equal(normalizePhone(''), null);
  assert.equal(normalizePhone(undefined), null);
});

test('SMS-ul se scrie fără diacritice și încape într-un singur mesaj', () => {
  assert.equal(toPlainText('Șofer: Ștefan Țăranu, „Bună” – în mașină'), 'Sofer: Stefan Taranu, "Buna" - in masina');
  const link = 'https://taxi.firma-mea.ro/track/AbCdEfGhIjKlMnOpQrStUv';
  const text = rideSmsText({ companyName: 'Taxi Hyp', plate: 'B 101 TXI', model: 'Dacia Logan', driverFirstName: 'Ion', etaMin: 4, link });
  assert.equal(text, `Taxi Hyp: Taxiul B 101 TXI (Dacia Logan, sofer Ion) vine spre dvs., ajunge in cca 4 min. Urmariti-l: ${link}`);
  assert.ok(text.length <= 160);
  assert.ok(!/[ăâîșțĂÂÎȘȚ]/.test(text));

  // Fără model sau timp estimat, ori cu nume lungi: se renunță la detalii, linkul rămâne.
  assert.equal(
    rideSmsText({ companyName: 'Taxi', plate: 'B 1 X', model: '', driverFirstName: 'Ana', etaMin: null, link: 'https://t.ro/x' }),
    'Taxi: Taxiul B 1 X (sofer Ana) vine spre dvs. Urmariti-l: https://t.ro/x'
  );
  const long = rideSmsText({ companyName: 'Compania de Taxi Foarte Lungă din București', plate: 'B 101 TXI', model: 'Mercedes-Benz E-Class', driverFirstName: 'Constantin', etaMin: 12, link });
  assert.ok(long.length <= 160, long);
  assert.ok(long.endsWith(link));
});

function fakeFetch(status, body) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, ...options, headers: options.headers });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  return { impl, calls };
}

test('SMSGate (telefon Android): cererea are formatul din documentația API', async () => {
  const { impl, calls } = fakeFetch(202, { id: 'abc', state: 'Pending' });
  const sender = createSmsSender({ provider: 'smsgate', smsgateUser: 'user', smsgatePassword: 'parola' }, { fetchImpl: impl });
  assert.deepEqual(await sender.send('+40722123456', 'Salut'), { ok: true });
  assert.equal(calls[0].url, 'https://api.sms-gate.app/3rdparty/v1/messages');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].headers.Authorization, 'Basic ' + Buffer.from('user:parola').toString('base64'));
  assert.deepEqual(JSON.parse(calls[0].body), { textMessage: { text: 'Salut' }, phoneNumbers: ['+40722123456'] });

  // Server propriu SMSGate (adresa din SMSGATE_URL).
  const own = fakeFetch(202, {});
  await createSmsSender({ provider: 'smsgate', smsgateUrl: 'https://sms.firma.ro/api/', smsgateUser: 'u', smsgatePassword: 'p' }, { fetchImpl: own.impl }).send('+40700000000', 'x');
  assert.equal(own.calls[0].url, 'https://sms.firma.ro/api/messages');

  const failing = fakeFetch(401, { message: 'Unauthorized' });
  const result = await createSmsSender({ provider: 'smsgate', smsgateUser: 'u', smsgatePassword: 'gresit' }, { fetchImpl: failing.impl }).send('+40722123456', 'x');
  assert.deepEqual(result, { ok: false, error: 'SMSGate: Unauthorized' });
});

test('Twilio: cererea are formatul din documentația API', async () => {
  const { impl, calls } = fakeFetch(201, { sid: 'SM123' });
  const sender = createSmsSender({ provider: 'twilio', twilioAccountSid: 'AC123', twilioAuthToken: 'secret', twilioFrom: '+15005550006' }, { fetchImpl: impl });
  assert.deepEqual(await sender.send('+40722123456', 'Salut'), { ok: true });
  assert.equal(calls[0].url, 'https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json');
  assert.equal(calls[0].headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.equal(calls[0].headers.Authorization, 'Basic ' + Buffer.from('AC123:secret').toString('base64'));
  assert.deepEqual(Object.fromEntries(new URLSearchParams(calls[0].body)), { To: '+40722123456', Body: 'Salut', From: '+15005550006' });

  const viaService = fakeFetch(201, {});
  await createSmsSender({ provider: 'twilio', twilioAccountSid: 'AC1', twilioAuthToken: 't', twilioMessagingServiceSid: 'MG1' }, { fetchImpl: viaService.impl }).send('+40722123456', 'x');
  assert.equal(new URLSearchParams(viaService.calls[0].body).get('MessagingServiceSid'), 'MG1');
  assert.equal(new URLSearchParams(viaService.calls[0].body).get('From'), null);

  const failing = fakeFetch(400, { code: 21211, message: "The 'To' number is not a valid phone number." });
  const result = await createSmsSender({ provider: 'twilio', twilioAccountSid: 'AC1', twilioAuthToken: 't', twilioFrom: '+1' }, { fetchImpl: failing.impl }).send('+4', 'x');
  assert.equal(result.error, "Twilio: The 'To' number is not a valid phone number.");
});

test('o eroare de rețea nu oprește serverul, doar marchează SMS-ul ca netrimis', async () => {
  const sender = createSmsSender({ provider: 'smsgate', smsgateUser: 'u', smsgatePassword: 'p' }, {
    fetchImpl: async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    },
  });
  assert.deepEqual(await sender.send('+40722123456', 'x'), { ok: false, error: 'getaddrinfo ENOTFOUND' });
});

test('modul de test doar afișează SMS-ul', async () => {
  const lines = [];
  const sender = createSmsSender({ provider: 'console' }, { log: (line) => lines.push(line) });
  assert.deepEqual(await sender.send('+40722123456', 'Salut'), { ok: true, simulated: true });
  assert.deepEqual(lines, ['[sms simulat] către +40722123456: Salut']);
});

test('configurarea furnizorului de SMS este verificată la pornire', () => {
  assert.equal(loadSmsConfig({}).provider, 'console');
  assert.throws(() => loadSmsConfig({ SMS_PROVIDER: 'smsgate' }), /SMSGATE_USER, SMSGATE_PASSWORD/);
  assert.throws(() => loadSmsConfig({ SMS_PROVIDER: 'twilio', TWILIO_ACCOUNT_SID: 'AC', TWILIO_AUTH_TOKEN: 't' }), /TWILIO_FROM/);
  assert.equal(loadSmsConfig({ SMS_PROVIDER: 'twilio', TWILIO_ACCOUNT_SID: 'AC', TWILIO_AUTH_TOKEN: 't', TWILIO_MESSAGING_SERVICE_SID: 'MG' }).provider, 'twilio');
  assert.throws(() => loadSmsConfig({ SMS_PROVIDER: 'altul' }), /necunoscut/);
  assert.throws(() => createSmsSender({ provider: 'altul' }), /necunoscut/);
});
