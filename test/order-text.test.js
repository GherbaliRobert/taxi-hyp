// Datele comenzii găsite în textul convorbirii (după recunoașterea vocii).
const test = require('node:test');
const assert = require('node:assert/strict');
const { extractOrder } = require('../shared/order-text');

test('o convorbire obișnuită: adresă, bloc, nume și telefon', () => {
  const call = [
    'Taxi Hyp, bună ziua.',
    'Bună ziua, aș dori o mașină pe strada Ion Creangă numărul 12, blocul C3, scara B.',
    'Strada Ion Creangă 12, bloc C3, scara B. Pe ce nume?',
    'Popescu Ana.',
    'Un număr de telefon, vă rog?',
    '0722 123 456.',
    'Mulțumesc, mașina vine imediat.',
  ];
  assert.deepEqual(extractOrder(call), {
    customerName: 'Popescu Ana',
    phone: '0722 123 456',
    address: 'Strada Ion Creangă 12',
    details: 'bl. C3, sc. B',
  });
});

test('adresa: forme diferite de a spune strada și numărul', () => {
  const address = (text) => extractOrder(text).address;
  assert.equal(address('Vin pe Calea Victoriei nr. 155.'), 'Calea Victoriei 155');
  assert.equal(address('Sunt pe bulevardul Unirii, numărul 7.'), 'Bulevardul Unirii 7');
  assert.equal(address('bd. Magheru 2'), 'Bulevardul Magheru 2');
  assert.equal(address('Pe șoseaua Kiseleff la numărul 32.'), 'Șoseaua Kiseleff 32');
  assert.equal(address('pe strada 13 Septembrie numărul 90'), 'Strada 13 Septembrie 90');
  assert.equal(address('strada mihai eminescu numărul doisprezece'), 'Strada Mihai Eminescu 12');
  assert.equal(address('Aleea Callatis 4 bis, vă rog.'), 'Aleea Callatis 4 bis');
  assert.equal(address('La Piața Romană, lângă metrou.'), 'Piața Romană');
  assert.equal(address('Strada Doamnei 12A'), 'Strada Doamnei 12A');
  assert.equal(address('strada Popa Nan colț cu Mihai Bravu'), 'Strada Popa Nan');
  // Se ia ultima adresă spusă (corectura sau confirmarea dispecerului).
  assert.equal(address('Strada Lizeanu 3. A, nu, Calea Moșilor 3.'), 'Calea Moșilor 3');
  assert.equal(address('Bună ziua, vreau un taxi.'), '');
  assert.equal(address('Vin de pe strada mea.'), '');
});

test('numele: „pe numele…”, „mă numesc…” sau răspunsul la „Pe ce nume?”', () => {
  const name = (text) => extractOrder(text).customerName;
  assert.equal(name('Pe numele Ana Popescu.'), 'Ana Popescu');
  assert.equal(name('pe numele de Ionescu'), 'Ionescu');
  assert.equal(name('Mă numesc Ștefan Țăranu și sunt la gară.'), 'Ștefan Țăranu');
  assert.equal(name('Pe numele doamnei Georgescu, vă rog.'), 'Georgescu');
  assert.equal(name('Pe numele Ana Popescu Vă rog repede'), 'Ana Popescu');
  assert.equal(name(['Pe ce nume?', 'Da, Marin Dan.']), 'Marin Dan');
  assert.equal(name(['Pe ce nume?', 'Stați puțin că nu știu exact.']), '');
  assert.equal(name('Bună ziua, vreau un taxi.'), '');
});

test('telefonul: cifre despărțite oricum, cu sau fără prefixul țării', () => {
  const phone = (text) => extractOrder(text).phone;
  assert.equal(phone('Telefonul meu e 0722 123 456.'), '0722 123 456');
  assert.equal(phone('0722-123-456'), '0722 123 456');
  assert.equal(phone('07 22 12 34 56'), '0722 123 456');
  assert.equal(phone('+40 744 555 666'), '0744 555 666');
  assert.equal(phone('Fix: 021 312 4567'), '021 312 4567');
  assert.equal(phone('0264 123 456'), '0264 123 456');
  assert.equal(phone('Strada Ion Creangă 12, blocul 3.'), '');
});

test('observații: bloc, scară, etaj, apartament și cerințe speciale', () => {
  const details = (text) => extractOrder(text).details;
  assert.equal(details('Blocul 5, scara 2, etajul patru, apartamentul 18.'), 'bl. 5, sc. 2, et. 4, ap. 18');
  assert.equal(details('bl. A2 sc. 1'), 'bl. A2, sc. 1');
  assert.equal(details('Am două bagaje mari și un câine mic.'), 'bagaje, animal de companie');
  assert.equal(details('Aveți scaun pentru copil? Plătesc cu cardul.'), 'scaun copil, plată cu cardul');
  assert.equal(details('Bună ziua.'), '');
});

test('diacriticele cu sedilă (ş, ţ) sunt corectate', () => {
  assert.equal(extractOrder('Pe şoseaua Ştefan cel Mare numărul 3').address, 'Șoseaua Ștefan cel Mare 3');
});

test('asistentul vocal e oprit implicit; adresele AI-ului local sunt verificate', () => {
  const { loadVoiceConfig } = require('../src/config');
  assert.equal(loadVoiceConfig({}), null);
  assert.deepEqual(loadVoiceConfig({ VOICE_STT_URL: 'http://127.0.0.1:8080/inference/' }), {
    sttUrl: 'http://127.0.0.1:8080/inference',
    sttModel: '',
    language: 'ro',
    llmUrl: '',
    llmModel: '',
  });
  const withLlm = loadVoiceConfig({ VOICE_STT_URL: 'http://127.0.0.1:8080/inference', VOICE_LLM_URL: 'http://127.0.0.1:11434' });
  assert.equal(withLlm.llmModel, 'qwen2.5:7b');
  assert.throws(() => loadVoiceConfig({ VOICE_STT_URL: '127.0.0.1:8080' }), /VOICE_STT_URL/);
  assert.throws(() => loadVoiceConfig({ VOICE_STT_URL: 'http://a/x', VOICE_LLM_URL: 'ftp://x' }), /VOICE_LLM_URL/);
});
