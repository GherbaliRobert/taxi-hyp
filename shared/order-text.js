// Datele comenzii (nume, telefon, adresă, bloc/scară) găsite în textul unei convorbiri de dispecerat.
// Folosit în browser (window.OrderText), după recunoașterea vocii, și în teste (require).
// Regulile acoperă felul obișnuit în care se dă o adresă la telefon („strada Ion Creangă numărul 12,
// blocul C3, pe numele Ana Popescu”). Un model AI local, dacă e configurat, completează restul.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.OrderText = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  const STREET_TYPES = [
    [/^(?:strada|str)$/, 'Strada'],
    [/^calea$/, 'Calea'],
    [/^(?:bulevardul|bulevard|bd|b-dul|bdul)$/, 'Bulevardul'],
    [/^(?:șoseaua|soseaua|șos|sos)$/, 'Șoseaua'],
    [/^aleea$/, 'Aleea'],
    [/^(?:piața|piata)$/, 'Piața'],
    [/^splaiul$/, 'Splaiul'],
    [/^intrarea$/, 'Intrarea'],
    [/^drumul$/, 'Drumul'],
    [/^fundătura$/, 'Fundătura'],
    [/^prelungirea$/, 'Prelungirea'],
  ];
  // Abrevieri după care punctul nu înseamnă sfârșit de propoziție.
  const ABBREVIATIONS = new Set(['str', 'nr', 'bl', 'sc', 'ap', 'et', 'bd', 'b-dul', 'bdul', 'șos', 'sos']);
  const NUMBER_INTRO = new Set(['numărul', 'număr', 'numarul', 'numar', 'nr']);
  // Cuvinte care încheie numele străzii.
  const STREET_STOP = new Set([
    ...NUMBER_INTRO,
    'bloc', 'blocul', 'bl', 'scara', 'sc', 'etaj', 'etajul', 'et', 'apartament', 'apartamentul', 'ap',
    'vă', 'va', 'te', 'la', 'lângă', 'langa', 'colț', 'colt', 'din', 'pe', 'și', 'si', 'în', 'in', 'cu',
    'aproape', 'vis-a-vis', 'vizavi', 'mea', 'asta', 'aia', 'aceea', 'noastră', 'unde', 'că', 'da', 'deci',
  ]);
  const LOWERCASE_PARTICLES = new Set(['de', 'lui', 'cel', 'cea', 'din', 'la']);
  const NUMBER_WORDS = {
    unu: 1, una: 1, doi: 2, două: 2, trei: 3, patru: 4, cinci: 5, șase: 6, șapte: 7, opt: 8, nouă: 9, zece: 10,
    unsprezece: 11, doisprezece: 12, douăsprezece: 12, treisprezece: 13, paisprezece: 14, cincisprezece: 15,
    șaisprezece: 16, șaptesprezece: 17, optsprezece: 18, nouăsprezece: 19, douăzeci: 20,
  };
  const DETAILS = [
    [new Set(['bloc', 'blocul', 'bl']), 'bl.'],
    [new Set(['scara', 'sc']), 'sc.'],
    [new Set(['etaj', 'etajul', 'et']), 'et.'],
    [new Set(['apartament', 'apartamentul', 'ap']), 'ap.'],
  ];
  const EXTRAS = [
    [/bagaj/i, 'bagaje'],
    [/scaun\w* (?:de |pentru )?copi/i, 'scaun copil'],
    [/\b(?:câine|caine|pisică|pisica|animal)/i, 'animal de companie'],
    [/\bcu cardul\b|\bplată cu card/i, 'plată cu cardul'],
  ];
  const NAME_TRIGGER =
    /(?:pe numele(?: de)?|numele (?:meu |clientului |dumneavoastră |dvs\.? )?(?:este|e)|mă numesc|ma numesc|mă cheamă|ma cheama)(?:\s+(?:doamnei|domnului|doamna|domnul|dna\.?|dl\.?))?\s+/giu;
  const CAPITALIZED_WORDS = /^(\p{Lu}[\p{L}'’-]*(?:\s+\p{Lu}[\p{L}'’-]*){0,2})/u;
  // Cuvinte cu majusculă care nu fac parte din nume (ex. „pe numele Ana Popescu Vă rog”).
  const NOT_NAMES = new Set(['vă', 'va', 'mulțumesc', 'multumesc', 'da', 'și', 'si', 'bine', 'imediat', 'la', 'pe', 'un', 'o', 'telefon']);
  const NAME_QUESTION = /pe ce nume|ce nume|cum vă numiți|cum va numiti|cum vă cheamă|numele dumneavoastră|numele dvs/i;

  /** Textul recunoscut, cu ș/ț corecte (unele modele scriu ş/ţ cu sedilă). */
  function normalize(text) {
    return String(text || '')
      .replace(/ş/g, 'ș')
      .replace(/ţ/g, 'ț')
      .replace(/Ş/g, 'Ș')
      .replace(/Ţ/g, 'Ț')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** Cuvinte și semne de punctuație (care despart informațiile). */
  function tokenize(text) {
    const tokens = [];
    const re = /([\p{L}\p{N}]+(?:[-'’][\p{L}\p{N}]+)*)(\.)?|([,;:?!])/gu;
    for (const m of text.matchAll(re)) {
      if (m[3]) {
        tokens.push({ stop: true });
        continue;
      }
      const lower = m[1].toLowerCase();
      tokens.push({ word: m[1], lower });
      if (m[2] && !ABBREVIATIONS.has(lower)) tokens.push({ stop: true });
    }
    return tokens;
  }

  function numberValue(token) {
    if (!token || token.stop) return '';
    if (/^\d{1,4}[a-z]?$/i.test(token.word)) return token.word.toUpperCase();
    return NUMBER_WORDS[token.lower] ? String(NUMBER_WORDS[token.lower]) : '';
  }

  function streetType(token) {
    if (!token || token.stop) return null;
    const match = STREET_TYPES.find(([re]) => re.test(token.lower));
    return match ? match[1] : null;
  }

  function capitalize(word, index) {
    if (index > 0 && LOWERCASE_PARTICLES.has(word.toLowerCase())) return word.toLowerCase();
    return word === word.toLowerCase() ? word.charAt(0).toUpperCase() + word.slice(1) : word;
  }

  /** Ultima adresă spusă (de obicei confirmarea dispecerului): „Strada Ion Creangă 12”. */
  function findAddress(tokens) {
    let found = '';
    for (let i = 0; i < tokens.length; i++) {
      const type = streetType(tokens[i]);
      if (!type) continue;
      const name = [];
      let j = i + 1;
      while (j < tokens.length && name.length < 5) {
        const t = tokens[j];
        if (t.stop || STREET_STOP.has(t.lower)) break;
        // „1 Mai”, „13 Septembrie” încep cu un număr; după nume, un număr e numărul casei.
        if (name.length > 0 && numberValue(t) && /\d/.test(t.word)) break;
        name.push(capitalize(t.word, name.length));
        j++;
      }
      if (!name.length) continue;
      // Numărul: „12”, „nr. 12”, „numărul 12”, „, numărul 12”, „la numărul 12”.
      let k = j;
      if (tokens[k] && tokens[k].stop && tokens[k + 1] && NUMBER_INTRO.has(tokens[k + 1].lower)) k++;
      if (tokens[k] && tokens[k].lower === 'la' && tokens[k + 1] && NUMBER_INTRO.has(tokens[k + 1].lower)) k++;
      if (tokens[k] && NUMBER_INTRO.has(tokens[k].lower)) k++;
      let number = numberValue(tokens[k]);
      if (number && tokens[k + 1] && tokens[k + 1].lower === 'bis') number += ' bis';
      found = [type, ...name, number].filter(Boolean).join(' ');
    }
    return found;
  }

  /** Bloc, scară, etaj, apartament (ultima valoare spusă pentru fiecare) și alte cerințe. */
  function findDetails(tokens, text) {
    const parts = [];
    for (const [words, label] of DETAILS) {
      let value = '';
      for (let i = 0; i < tokens.length - 1; i++) {
        if (tokens[i].stop || !words.has(tokens[i].lower)) continue;
        const next = tokens[i + 1];
        if (next.stop || STREET_STOP.has(next.lower)) continue;
        const short = /^[\p{L}\p{N}]{1,4}$/u.test(next.word) ? next.word.toUpperCase() : '';
        value = numberValue(next) || short || value;
      }
      if (value) parts.push(label + ' ' + value);
    }
    for (const [re, label] of EXTRAS) if (re.test(text)) parts.push(label);
    return parts.join(', ');
  }

  /** Numele după „pe numele…”, „mă numesc…” sau răspunsul la „Pe ce nume?”. */
  function findName(segments, text) {
    let found = '';
    for (const m of text.matchAll(NAME_TRIGGER)) {
      const name = text.slice(m.index + m[0].length).match(CAPITALIZED_WORDS);
      if (!name) continue;
      const words = name[1].split(/\s+/);
      while (words.length && NOT_NAMES.has(words[words.length - 1].toLowerCase())) words.pop();
      if (words.length) found = words.join(' ');
    }
    for (let i = 0; i < segments.length - 1; i++) {
      if (!NAME_QUESTION.test(segments[i])) continue;
      const answer = segments[i + 1].replace(/^(?:da|pe|deci)[,\s]+/i, '').replace(/[.,!?]+$/, '').trim();
      if (/^\p{Lu}[\p{L}'’-]*(?:\s+\p{Lu}[\p{L}'’-]*){0,2}$/u.test(answer)) found = answer;
    }
    return found;
  }

  /** Ultimul număr de telefon românesc spus (cifrele pot fi despărțite de spații sau puncte). */
  function findPhone(text) {
    const joined = text.replace(/(\d)[\s.\-/]+(?=\d)/g, '$1');
    let found = '';
    for (const m of joined.matchAll(/(?:\+40|0040|\b40)?(0?[237]\d{8})(?!\d)/g)) {
      const digits = m[1].startsWith('0') ? m[1] : '0' + m[1];
      // București (021, 031): 021 312 4567; mobil și alte județe: 0722 123 456.
      found = /^0[23]1/.test(digits)
        ? `${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6)}`
        : `${digits.slice(0, 4)} ${digits.slice(4, 7)} ${digits.slice(7)}`;
    }
    return found;
  }

  /**
   * `transcript`: textul convorbirii, ca listă de fraze (în ordine) sau un singur șir.
   * Întoarce { customerName, phone, address, details }; câmpurile negăsite sunt goale.
   */
  function extractOrder(transcript) {
    const segments = (Array.isArray(transcript) ? transcript : [transcript]).map(normalize).filter(Boolean);
    const text = segments.join(' ');
    const tokens = tokenize(text);
    return {
      customerName: findName(segments, text),
      phone: findPhone(text),
      address: findAddress(tokens),
      details: findDetails(tokens, text),
    };
  }

  return { extractOrder, normalize };
});
