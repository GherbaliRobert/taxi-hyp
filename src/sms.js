// SMS-ul către client cu linkul de urmărire, trimis automat când un șofer acceptă comanda.
//
// Furnizori (SMS_PROVIDER):
//   console  — nu trimite nimic, doar afișează mesajul în jurnalul serverului (implicit, pentru teste)
//   smsgate  — un telefon Android cu cartelă SIM și aplicația SMS Gateway (https://sms-gate.app)
//   twilio   — serviciul Twilio (https://www.twilio.com)

const DIACRITICS = { ă: 'a', â: 'a', î: 'i', ș: 's', ş: 's', ț: 't', ţ: 't', Ă: 'A', Â: 'A', Î: 'I', Ș: 'S', Ş: 'S', Ț: 'T', Ţ: 'T' };
const PUNCTUATION = { '„': '"', '”': '"', '“': '"', '’': "'", '‘': "'", '–': '-', '—': '-', '…': '...', '·': '-' };
const SMS_LENGTH = 160;

/**
 * Numărul în format internațional (+40722123456). Acceptă „0722 123 456”, „+40 722…”, „0040…”.
 * Întoarce null dacă nu arată a număr de telefon.
 */
function normalizePhone(raw, countryCode = '40') {
  if (typeof raw !== 'string') return null;
  let digits = raw.trim().replace(/[\s().\-/]/g, '');
  if (digits.startsWith('+')) digits = digits.slice(1);
  else if (digits.startsWith('00')) digits = digits.slice(2);
  else if (digits.startsWith('0')) digits = countryCode + digits.slice(1);
  else if (digits.length <= 9) digits = countryCode + digits;
  return /^\d{8,15}$/.test(digits) ? '+' + digits : null;
}

/** Fără diacritice și ghilimele tipografice: un SMS cu „ș” sau „ț” încape doar în 70 de caractere, nu 160. */
function toPlainText(text) {
  return String(text)
    .replace(/[ăâîșşțţĂÂÎȘŞȚŢ]/g, (ch) => DIACRITICS[ch])
    .replace(/[„”“’‘–—…·]/g, (ch) => PUNCTUATION[ch]);
}

/** Textul SMS-ului către client; detaliile mai puțin importante se omit dacă nu încape într-un singur SMS. */
function rideSmsText({ companyName, plate, model, driverFirstName, etaMin, link }) {
  const coming = 'vine spre dvs' + (etaMin ? `., ajunge in cca ${etaMin} min` : '');
  const variants = [
    `${companyName}: Taxiul ${plate} (${model}, sofer ${driverFirstName}) ${coming}. Urmariti-l: ${link}`,
    `${companyName}: Taxiul ${plate} (sofer ${driverFirstName}) ${coming}. Urmariti-l: ${link}`,
    `${companyName}: Taxiul ${plate} ${coming}. Urmariti-l: ${link}`,
    `Taxiul ${plate} vine spre dvs: ${link}`,
  ].map((v) => toPlainText(v.replace(' (, ', ' (').replace(/\s+/g, ' ')));
  return variants.find((v) => v.length <= SMS_LENGTH) || variants[variants.length - 1];
}

async function readError(res) {
  const body = await res.text().catch(() => '');
  try {
    const data = JSON.parse(body);
    return data.message || data.error || body;
  } catch {
    return body || `HTTP ${res.status}`;
  }
}

function basicAuth(user, password) {
  return 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64');
}

/**
 * `send(to, text)` întoarce { ok, simulated?, error? }; nu aruncă excepții.
 * `fetchImpl` permite testarea fără rețea.
 */
function createSmsSender(config, { fetchImpl = fetch, log = console.log } = {}) {
  const provider = config.provider || 'console';
  const timeout = () => AbortSignal.timeout(15000);

  const providers = {
    async console(to, text) {
      log(`[sms simulat] către ${to}: ${text}`);
      return { ok: true, simulated: true };
    },

    // API-ul SMSGate: POST {url}/messages, autentificare Basic, răspuns 202.
    async smsgate(to, text) {
      const url = (config.smsgateUrl || 'https://api.sms-gate.app/3rdparty/v1').replace(/\/+$/, '');
      const res = await fetchImpl(`${url}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: basicAuth(config.smsgateUser, config.smsgatePassword) },
        body: JSON.stringify({ textMessage: { text }, phoneNumbers: [to] }),
        signal: timeout(),
      });
      return res.ok ? { ok: true } : { ok: false, error: `SMSGate: ${await readError(res)}` };
    },

    // API-ul Twilio: POST /Accounts/{SID}/Messages.json, formular URL-encoded, autentificare Basic.
    async twilio(to, text) {
      const form = new URLSearchParams({ To: to, Body: text });
      if (config.twilioMessagingServiceSid) form.set('MessagingServiceSid', config.twilioMessagingServiceSid);
      else form.set('From', config.twilioFrom);
      const res = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(config.twilioAccountSid)}/Messages.json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: basicAuth(config.twilioAccountSid, config.twilioAuthToken) },
        body: form.toString(),
        signal: timeout(),
      });
      return res.ok ? { ok: true } : { ok: false, error: `Twilio: ${await readError(res)}` };
    },
  };

  if (!providers[provider]) throw new Error(`SMS_PROVIDER necunoscut: „${provider}” (console, smsgate sau twilio)`);

  return {
    provider,
    async send(to, text) {
      try {
        return await providers[provider](to, text);
      } catch (err) {
        return { ok: false, error: err.name === 'TimeoutError' ? 'Furnizorul de SMS nu răspunde' : err.message };
      }
    },
  };
}

module.exports = { createSmsSender, normalizePhone, toPlainText, rideSmsText };
