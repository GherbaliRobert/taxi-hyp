// Asistentul vocal al dispecerului: ascultă convorbirea prin microfonul calculatorului și completează comanda.
// Totul rulează pe calculatorul dispecerului: recunoașterea vocii (Whisper, ex. whisper.cpp) și, opțional,
// un model AI local (Ollama). Sunetul nu pleacă spre serverul firmei și nu se păstrează nicăieri.
(function () {
  const SAMPLE_RATE = 16000;
  // Împărțirea în fraze: vorbire = volum peste zgomotul de fond; fraza se încheie după o pauză.
  const MIN_SPEECH_RMS = 0.01;
  const NOISE_FACTOR = 2.5;
  const PRE_ROLL_MS = 300;
  const PAUSE_MS = 700;
  const MIN_SPEECH_MS = 250;
  const MAX_PHRASE_MS = 15000;
  // Cuvintele pe care le așteptăm ajută recunoașterea (fără valori concrete, pe care modelul le-ar putea repeta).
  const STT_PROMPT =
    'Dispecerat taxi. Clientul spune adresa: strada, calea, bulevardul, șoseaua, aleea, numărul, blocul, scara, etajul, apartamentul, pe numele, numărul de telefon.';
  // Fraze pe care Whisper le „aude” uneori în zgomot sau liniște.
  const HALLUCINATIONS = /pentru vizionare|abonați-vă|abonează-te|subtitr|traducerea|www\.|\.com\b/i;
  const LLM_SCHEMA = {
    type: 'object',
    properties: {
      customerName: { type: 'string' },
      phone: { type: 'string' },
      address: { type: 'string' },
      details: { type: 'string' },
    },
    required: ['customerName', 'phone', 'address', 'details'],
  };
  const LLM_INSTRUCTIONS = [
    'Primești transcrierea automată (cu posibile greșeli) a unei convorbiri telefonice în limba română între dispeceratul unei firme de taxi și un client.',
    'Extrage datele comenzii și răspunde doar cu JSON, cu câmpurile:',
    '- customerName: numele clientului, cum l-a spus;',
    '- phone: numărul de telefon al clientului;',
    '- address: locul de preluare, ca stradă și număr (ex. „Strada Ion Creangă 12”) sau un loc cunoscut (ex. „Gara de Nord”), fără bloc și scară; dacă s-a corectat, ultima variantă;',
    '- details: pe scurt, bloc, scară, etaj, apartament, reper, bagaje sau alte cerințe pentru șofer.',
    'Nu inventa nimic: un câmp care nu apare în convorbire rămâne gol.',
  ].join('\n');

  function downsample(samples, fromRate, toRate) {
    if (fromRate === toRate) return samples;
    const ratio = fromRate / toRate;
    const out = new Float32Array(Math.floor(samples.length / ratio));
    for (let i = 0; i < out.length; i++) {
      // Media eșantioanelor din fereastră: filtrează și frecvențele care nu mai încap.
      const start = Math.floor(i * ratio);
      const end = Math.min(samples.length, Math.floor((i + 1) * ratio));
      let sum = 0;
      for (let j = start; j < end; j++) sum += samples[j];
      out[i] = sum / Math.max(1, end - start);
    }
    return out;
  }

  /** WAV mono, 16 biți: formatul citit de orice server Whisper. */
  function encodeWav(samples, sampleRate) {
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);
    const text = (offset, s) => [...s].forEach((ch, i) => view.setUint8(offset + i, ch.charCodeAt(0)));
    text(0, 'RIFF');
    view.setUint32(4, 36 + samples.length * 2, true);
    text(8, 'WAVE');
    text(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 1, true); // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    text(36, 'data');
    view.setUint32(40, samples.length * 2, true);
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return buffer;
  }

  function cleanText(text) {
    const clean = String(text || '')
      .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ') // [muzică], (râsete)
      .replace(/\s+/g, ' ')
      .trim();
    return /[\p{L}\p{N}]/u.test(clean) && !HALLUCINATIONS.test(clean) ? clean : '';
  }

  function concat(chunks) {
    const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }

  /**
   * `options`: { sttUrl, sttModel, language, llmUrl, llmModel } (din configurarea serverului).
   * `handlers`: onStatus({ listening, hearing, pending, level }), onTranscript(fraze),
   * onFields({ customerName, phone, address, details }), onError(mesaj).
   */
  function createVoiceAssistant(options, handlers) {
    const transcript = [];
    let stream = null;
    let context = null;
    let listening = false;
    let discarded = false;
    let queue = Promise.resolve();
    let pending = 0;
    let level = 0;
    let lastError = '';
    // Fraza în curs.
    let noise = null;
    let preRoll = [];
    let phrase = null; // { chunks, speechMs, silenceMs, totalMs }
    let chunkMs = 0;
    let rate = 0;
    // Modelul AI local: rulează pe rând, mereu cu transcrierea cea mai nouă.
    let llmFields = null;
    let llmBusy = false;
    let llmAgain = false;

    const status = () => handlers.onStatus({ listening, hearing: Boolean(phrase), pending, level });
    const error = (message) => {
      if (message === lastError) return;
      lastError = message;
      handlers.onError(message);
    };

    async function start() {
      if (!navigator.mediaDevices || !window.AudioWorkletNode) throw new Error('Browserul nu permite folosirea microfonului.');
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
      } catch {
        throw new Error('Permiteți accesul la microfon pentru această pagină.');
      }
      context = new AudioContext();
      rate = context.sampleRate;
      chunkMs = (2048 / rate) * 1000;
      await context.audioWorklet.addModule('/js/voice-worklet.js');
      const source = context.createMediaStreamSource(stream);
      const capture = new AudioWorkletNode(context, 'voice-capture');
      const mute = context.createGain();
      mute.gain.value = 0;
      capture.port.onmessage = (e) => onChunk(e.data);
      source.connect(capture).connect(mute).connect(context.destination);
      listening = true;
      status();
    }

    /** `discard`: comanda a fost trimisă; rezultatele întârziate nu mai completează formularul. */
    function stop({ discard = false } = {}) {
      if (discard) discarded = true;
      if (phrase && !discard) endPhrase();
      phrase = null;
      listening = false;
      level = 0;
      if (stream) stream.getTracks().forEach((t) => t.stop());
      if (context) context.close().catch(() => {});
      stream = null;
      context = null;
      status();
    }

    function onChunk(chunk) {
      if (!listening) return;
      let sum = 0;
      for (let i = 0; i < chunk.length; i++) sum += chunk[i] * chunk[i];
      const rms = Math.sqrt(sum / chunk.length);
      level = rms;
      if (noise === null) noise = Math.min(rms, MIN_SPEECH_RMS);
      const speaking = rms > Math.max(MIN_SPEECH_RMS, noise * NOISE_FACTOR);
      if (!speaking && !phrase) noise = noise * 0.95 + rms * 0.05;

      if (!phrase) {
        preRoll.push(chunk);
        if (preRoll.length * chunkMs > PRE_ROLL_MS) preRoll.shift();
        if (speaking) {
          phrase = { chunks: preRoll, speechMs: 0, silenceMs: 0, totalMs: preRoll.length * chunkMs };
          preRoll = [];
        }
      } else {
        phrase.chunks.push(chunk);
        phrase.totalMs += chunkMs;
      }
      if (phrase) {
        if (speaking) {
          phrase.speechMs += chunkMs;
          phrase.silenceMs = 0;
        } else {
          phrase.silenceMs += chunkMs;
        }
        if (phrase.silenceMs >= PAUSE_MS || phrase.totalMs >= MAX_PHRASE_MS) endPhrase();
      }
      status();
    }

    function endPhrase() {
      const done = phrase;
      phrase = null;
      if (!done || done.speechMs < MIN_SPEECH_MS) return;
      const samples = downsample(concat(done.chunks), rate, SAMPLE_RATE);
      pending += 1;
      status();
      // Frazele se recunosc pe rând, în ordinea în care au fost spuse.
      queue = queue.then(() => recognize(samples)).finally(() => {
        pending -= 1;
        status();
      });
    }

    async function recognize(samples) {
      let text;
      try {
        const form = new FormData();
        form.append('file', new Blob([encodeWav(samples, SAMPLE_RATE)], { type: 'audio/wav' }), 'apel.wav');
        form.append('language', options.language || 'ro');
        form.append('response_format', 'json');
        form.append('temperature', '0');
        form.append('prompt', STT_PROMPT);
        if (options.sttModel) form.append('model', options.sttModel);
        const res = await fetch(options.sttUrl, { method: 'POST', body: form, signal: AbortSignal.timeout(60000) });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        text = cleanText((await res.json()).text);
        lastError = '';
      } catch (err) {
        error(
          'Recunoașterea vocii nu răspunde (' + options.sttUrl + '): ' + (err.name === 'TimeoutError' ? 'prea lent' : err.message) +
            '. Verificați că serverul Whisper rulează pe acest calculator.'
        );
        return;
      }
      if (!text || discarded) return;
      transcript.push(text);
      handlers.onTranscript(transcript.slice());
      update();
      if (options.llmUrl) askLlm();
    }

    /** Regulile (instant) plus, unde a găsit ceva, modelul AI local. */
    function update() {
      if (discarded) return;
      const fields = window.OrderText.extractOrder(transcript);
      if (llmFields) {
        for (const key of Object.keys(fields)) if (llmFields[key]) fields[key] = llmFields[key];
      }
      handlers.onFields(fields);
    }

    async function askLlm() {
      if (llmBusy) {
        llmAgain = true;
        return;
      }
      llmBusy = true;
      try {
        const res = await fetch(options.llmUrl + '/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: options.llmModel,
            stream: false,
            format: LLM_SCHEMA,
            options: { temperature: 0 },
            messages: [
              { role: 'system', content: LLM_INSTRUCTIONS },
              { role: 'user', content: transcript.join('\n') },
            ],
          }),
          signal: AbortSignal.timeout(120000),
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const answer = JSON.parse((await res.json()).message.content);
        const text = (key) => (typeof answer[key] === 'string' ? answer[key].trim().slice(0, 200) : '');
        llmFields = {
          customerName: text('customerName'),
          // Doar un număr de telefon valid, scris la fel ca restul.
          phone: window.OrderText.extractOrder(text('phone')).phone,
          address: text('address'),
          details: text('details'),
        };
        update();
      } catch (err) {
        error('Modelul AI local nu răspunde (' + options.llmUrl + '): ' + err.message + '. Se folosesc doar regulile.');
      } finally {
        llmBusy = false;
        if (llmAgain && !discarded) {
          llmAgain = false;
          askLlm();
        }
      }
    }

    return {
      start,
      stop,
      get active() {
        return listening;
      },
    };
  }

  window.TaxiVoice = { createVoiceAssistant, encodeWav, downsample };
})();
