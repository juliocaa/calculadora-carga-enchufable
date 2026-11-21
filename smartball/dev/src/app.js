/* app.js — interfaz, Bluetooth y cámara de la app Smart Ball (Chrome + Web Bluetooth). */
(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const U = SB.UUID16, es = SBScene.es;
  const VERSION = '3.0';
  const ANALYSIS = 2;   // sube cuando cambia el análisis: los chutes guardados se recalculan
  const STORE_KEY = 'smartball.v1.kicks';
  const SETTINGS_KEY = 'smartball.v1.settings';
  const WALL_X = 9.15, BAR_H = 2.44, POST_Y = 3.66;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const hex = (b) => SB.toHex(b);

  // ------------------------------------------------------------ registro
  const logLines = [];
  function log(msg) {
    const t = new Date();
    const ts = t.toTimeString().slice(0, 8) + '.' + String(t.getMilliseconds()).padStart(3, '0');
    logLines.push(ts + '  ' + msg);
    if (logLines.length > 1500) logLines.shift();
    const el = $('#log'), d = $('#diag');
    if (el && d && d.open) el.textContent = logLines.slice(-400).join('\n');
  }
  window.addEventListener('error', (e) => log('ERROR JS: ' + e.message));
  window.addEventListener('unhandledrejection', (e) => log('ERROR promesa: ' + ((e.reason && e.reason.message) || e.reason)));

  // ------------------------------------------------------------ ajustes y almacenamiento
  const settings = {
    sound: true, speak: true, vibrate: true, cam: false, cam60: false, camAudio: true, openField: false, goalDist: 20, wall: true, view: 'behind',
    foot: null, rtab: 'vuelo', evoMetric: 'speed', evoFoot: 'all',
    rt: { type: 'range', min: 60, max: 70, players: 1, n: 5, names: ['', ''] },
  };
  try { Object.assign(settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')); } catch (e) { /* sin almacenamiento */ }
  const saveSettings = () => { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) { /* nada */ } };
  function loadKicks() { try { return JSON.parse(localStorage.getItem(STORE_KEY) || '[]'); } catch (e) { return []; } }
  function storeKicks(list) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(list)); return true; } catch (e) {
      toast('No queda sitio para guardar más chutes. Exporta los datos y borra los antiguos.');
      return false;
    }
  }
  let kicks = loadKicks();

  // ------------------------------------------------------------ sonido, voz y vibración
  let actx = null;
  function audio() {
    if (!actx) { try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { actx = null; } }
    if (actx && actx.state === 'suspended') actx.resume().catch(() => {});
    return actx;
  }
  function tone(freq, start, dur, gain, type) {
    const a = audio(); if (!a) return null;
    const o = a.createOscillator(), g = a.createGain();
    o.type = type || 'sine'; o.frequency.value = freq;
    const t0 = a.currentTime + start;
    g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(gain || 0.25, t0 + 0.015);
    g.gain.setValueAtTime(gain || 0.25, t0 + dur - 0.03); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(a.destination); o.start(t0); o.stop(t0 + dur + 0.02);
    return o;
  }
  function whistle() {
    if (!settings.sound) return;
    const a = audio(); if (!a) return;
    [0, 0.32].forEach((st, i) => {
      const o = tone(2900, st, i ? 0.55 : 0.22, 0.22, 'triangle');
      if (o) { const l = a.createOscillator(), lg = a.createGain(); l.frequency.value = 28; lg.gain.value = 90; l.connect(lg).connect(o.frequency); l.start(a.currentTime + st); l.stop(a.currentTime + st + 0.6); }
    });
  }
  const beep = (f, d) => { if (settings.sound) tone(f || 880, 0, d || 0.12, 0.2, 'sine'); };
  function say(text) {
    if (!settings.speak || !('speechSynthesis' in window)) return;
    try { speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(text); u.lang = 'es-ES'; u.rate = 1.05; speechSynthesis.speak(u); } catch (e) { /* nada */ }
  }
  const buzz = (p) => { if (settings.vibrate && navigator.vibrate) { try { navigator.vibrate(p); } catch (e) { /* nada */ } } };

  let wakeLock = null;
  async function keepAwake() {
    try { if ('wakeLock' in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } } catch (e) { /* no disponible */ }
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.t && S.t.connected) keepAwake(); });

  function withTimeout(p, ms, label) {
    let t;
    return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error('Tiempo agotado: ' + label)), ms); })]).finally(() => clearTimeout(t));
  }
  const copyBytes = (dv) => new Uint8Array(dv.buffer.slice(dv.byteOffset, dv.byteOffset + dv.byteLength));

  // ------------------------------------------------------------ transporte: Bluetooth real
  class BleTransport {
    constructor() { this.device = null; this.ch = {}; this.queue = Promise.resolve(); this.onDisconnect = null; this.isDemo = false; }
    get name() { return this.device ? (this.device.name || 'balón') : ''; }
    get connected() { return !!(this.device && this.device.gatt && this.device.gatt.connected); }
    async request(acceptAll) {
      if (!navigator.bluetooth) throw new Error('Este navegador no tiene Bluetooth web. En Android usa Google Chrome (no Samsung Internet).');
      const optionalServices = [U.SERVICE, U.BATTERY_SERVICE, U.DEVICE_INFO];
      const opts = acceptAll
        ? { acceptAllDevices: true, optionalServices }
        : { filters: [{ services: [U.SERVICE] }, { namePrefix: 'DB' }], optionalServices };
      this.device = await navigator.bluetooth.requestDevice(opts);
      log('Elegido: ' + (this.device.name || '(sin nombre)') + ' id=' + this.device.id);
      this.device.addEventListener('gattserverdisconnected', () => { log('BLE: desconectado'); this.ch = {}; if (this.onDisconnect) this.onDisconnect(); });
    }
    async connect() {
      const server = await withTimeout(this.device.gatt.connect(), 20000, 'conectar');
      log('GATT conectado');
      const svc = await withTimeout(server.getPrimaryService(U.SERVICE), 10000, 'servicio AD04');
      const map = { LOG: U.LOGGING, CMD: U.COMMAND, RESP: U.RESPONSE, STATUS: U.STATUS, RATE: U.SAMPLE_PERIOD, PROG: U.PROGRESS, ERR: U.ERROR, KICK: U.KICK_EVENT };
      this.ch = {};
      for (const [k, u] of Object.entries(map)) {
        try {
          const c = await withTimeout(svc.getCharacteristic(u), 6000, k);
          this.ch[k] = c;
          const p = c.properties, f = ['read', 'write', 'writeWithoutResponse', 'notify', 'indicate'].filter((x) => p[x]);
          log(`${k} 0x${u.toString(16)}: ${f.join(',')}`);
        } catch (e) { log(`Falta ${k} 0x${u.toString(16)} (${e.message})`); }
      }
      try { const bs = await server.getPrimaryService(U.BATTERY_SERVICE); this.ch.BATT = await bs.getCharacteristic(U.BATTERY_LEVEL); } catch (e) { log('Sin servicio de batería'); }
      try {
        const ds = await server.getPrimaryService(U.DEVICE_INFO);
        for (const [k, u] of [['FW', U.FIRMWARE], ['MFR', U.MANUFACTURER], ['MODEL', U.MODEL], ['SW', U.SOFTWARE]]) { try { this.ch[k] = await ds.getCharacteristic(u); } catch (e) { /* opcional */ } }
      } catch (e) { log('Sin información del dispositivo'); }
      if (!this.ch.CMD || !this.ch.LOG || !this.ch.RESP) throw new Error('Este dispositivo no es un Smart Ball (no tiene AD14/AD15/AD17).');
    }
    op(fn, label) { const p = this.queue.then(() => withTimeout(fn(), 8000, label)); this.queue = p.catch(() => {}); return p; }
    async read(k) {
      const c = this.ch[k]; if (!c) throw new Error('Sin característica ' + k);
      return copyBytes(await this.op(() => c.readValue(), 'leer ' + k));
    }
    async write(k, bytes) {
      const c = this.ch[k]; if (!c) throw new Error('Sin característica ' + k);
      const data = Uint8Array.from(bytes);
      log(`→ ${k}: ${hex(data)}`);
      const p = c.properties;
      return this.op(() => {
        if (p.write || !p.writeWithoutResponse) return c.writeValueWithResponse ? c.writeValueWithResponse(data) : c.writeValue(data);
        return c.writeValueWithoutResponse(data);
      }, 'escribir ' + k);
    }
    async notify(k, cb) {
      const c = this.ch[k]; if (!c) return false;
      if (!(c.properties.notify || c.properties.indicate)) { log(k + ' no admite notificaciones'); return false; }
      c.addEventListener('characteristicvaluechanged', (ev) => cb(copyBytes(ev.target.value)));
      await this.op(() => c.startNotifications(), 'notificaciones ' + k);
      return true;
    }
    disconnect() { try { if (this.connected) this.device.gatt.disconnect(); } catch (e) { /* nada */ } }
  }

  // ------------------------------------------------------------ transporte: balón simulado (modo demostración)
  const PRESETS = [
    { label: 'liftado', o: { top: 1, side: 0.1, rifle: 0 }, rpm: [420, 720], v: [22, 29], e: [12, 20] },
    { label: 'cortado', o: { top: -1, side: 0.15, rifle: 0 }, rpm: [300, 520], v: [18, 25], e: [16, 26] },
    { label: 'rosca con el interior (diestro)', o: { top: -0.35, side: 0.9, rifle: 0.15 }, rpm: [450, 650], v: [21, 27], e: [14, 22] },
    { label: 'rosca con el exterior (diestro)', o: { top: 0.2, side: -0.9, rifle: 0.1 }, rpm: [350, 550], v: [22, 28], e: [12, 20] },
    { label: 'liftado con rosca', o: { top: 0.75, side: 0.6, rifle: 0 }, rpm: [450, 700], v: [22, 28], e: [14, 22] },
    { label: 'sin giro', o: { top: 0.3, side: 0.2, rifle: 1 }, rpm: [15, 45], v: [28, 33], e: [8, 14] },
  ];
  class MockTransport {
    constructor() { this.cb = {}; this.state = 'idle'; this.pct = 0; this.on = false; this.timers = []; this.kickData = null; this.lastTruth = null; this.onDisconnect = null; this.isDemo = true; this.count = 0; }
    get name() { return 'Balón simulado'; }
    get connected() { return this.on; }
    async request() { /* nada que elegir */ }
    async connect() { await sleep(500); this.on = true; log('Demo: conectado al balón simulado'); }
    async read(k) {
      await sleep(15 + Math.random() * 20);
      if (!this.on) throw new Error('desconectado');
      switch (k) {
        case 'STATUS': return Uint8Array.from([0, 0]);
        case 'RATE': return Uint8Array.from([1, 0]);
        case 'PROG': return Uint8Array.from([Math.min(100, Math.round(this.pct))]);
        case 'BATT': return Uint8Array.from([86]);
        case 'FW': return new TextEncoder().encode('3.5 (simulado)');
        case 'MFR': return new TextEncoder().encode('Adidas AIT (simulado)');
        default: return Uint8Array.from([0]);
      }
    }
    async write(k, bytes) {
      await sleep(20);
      if (!this.on) throw new Error('desconectado');
      log(`→ ${k}: ${hex(bytes)} (demo)`);
      if (k !== 'CMD') return;
      const c = bytes[0];
      if (c === 6) { this.clear(); this.state = 'idle'; this.pct = 0; this.later(40, () => this.emit('ERR', [250])); }
      else if (c === 3) {
        this.clear(); this.state = 'logging'; this.pct = 0;
        this.later(40, () => this.emit('ERR', [250]));
        this.later(1400, () => { this.state = 'ready'; this.emit('LOG', [1]); this.later(2200 + Math.random() * 1800, () => this.kick()); });
      } else if (c === 4) { this.state = 'stopped'; this.later(40, () => this.emit('ERR', [250])); }
      else if (c === 10) { this.download(); }
      else if (c === 11) { this.later(40, () => this.emit('RATE', [bytes[1], bytes[2]])); }
    }
    kick() {
      if (this.state !== 'ready') return;
      this.state = 'recording';
      const p = PRESETS[this.count++ % PRESETS.length];
      const rnd = (r) => r[0] + Math.random() * (r[1] - r[0]);
      const sim = SB.simulateKick({ seed: Math.floor(Math.random() * 1e9), speed: rnd(p.v), rpm: rnd(p.rpm), elevDeg: rnd(p.e), ...p.o });
      this.kickData = sim.samples;
      this.lastTruth = { ...sim.truth, preset: p.label };
      const t0 = Date.now();
      const step = () => { this.pct = Math.min(100, (Date.now() - t0) / 11); if (this.pct < 100) this.later(20, step); };
      step();
    }
    download() {
      if (!this.kickData) { this.later(50, () => this.emit('RESP', [0x9A, 0xC2, 0, 0, 0, 74, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])); return; }
      const pk = SB.encodeType2(this.kickData);
      let i = 0;
      const send = () => { for (let j = 0; j < 6 && i < pk.length; j++, i++) this.emit('RESP', pk[i]); if (i < pk.length) this.later(12, send); };
      this.later(60, send);
    }
    async notify(k, cb) { this.cb[k] = cb; return true; }
    emit(k, arr) { const cb = this.cb[k]; if (cb && this.on) cb(Uint8Array.from(arr)); }
    later(ms, fn) { this.timers.push(setTimeout(fn, ms)); }
    clear() { this.timers.forEach(clearTimeout); this.timers = []; }
    disconnect() { this.clear(); if (this.on) { this.on = false; if (this.onDisconnect) this.onDisconnect(); } }
  }

  // ------------------------------------------------------------ sesión
  const S = {
    t: null, state: 'disconnected', info: {}, decoder: new SB.Decoder(), samplePeriodMs: 1,
    pollGen: 0, lastPct: 0, lastPollOk: 0, hasProgress: true, checkingZero: false, autoRetried: false,
    pendingDownload: false, maybeKick: false, reconnecting: false, dlWatch: null, finishTimer: null, stallTimer: null, manualDisconnect: false,
    cam: new SBVideo.KickCam(log), clipPromise: null, kickWall: 0, provisional: false, framing: false,
    current: null, currentRes: null, fl: null,
  };
  const scene = new SBScene.PitchScene($('#scene'));
  const spinBall = new SBScene.SpinBall($('#spinCanvas'));
  scene.goalDist = settings.goalDist; scene.showWall = settings.wall; scene.view = settings.view;

  async function connect(acceptAll, demo) {
    audio();
    if (S.t) { S.manualDisconnect = true; S.t.disconnect(); }
    S.manualDisconnect = false; S.pendingDownload = false; S.maybeKick = false;
    S.t = demo ? new MockTransport() : new BleTransport();
    S.t.onDisconnect = onDisconnect;
    setState('connecting');
    try { await S.t.request(acceptAll); }
    catch (e) {
      setState('disconnected');
      if (e && e.name === 'NotFoundError') toast('No se eligió ningún balón. Si no aparece en la lista, acércalo, prueba a moverlo o a ponerlo un momento en la base y vuelve a buscar.');
      else showError(e);
      return;
    }
    await openSession();
  }

  async function openSession(quiet) {
    try {
      if (!quiet) setState('connecting');
      await S.t.connect();
      await S.t.notify('ERR', (b) => log('ADFE ← ' + hex(b)));
      await S.t.notify('LOG', onLogging);
      await S.t.notify('RESP', onResponse);
      try { await S.t.notify('KICK', (b) => log('AD12 ← ' + hex(b))); } catch (e) { log('AD12: ' + e.message); }
      try { await S.t.notify('RATE', (b) => log('AD20 ← ' + hex(b))); } catch (e) { /* opcional */ }
      await readInfo();
      keepAwake();
      if (S.maybeKick) {       // se perdió la conexión con el balón armado: ¿llegó a grabar un chute?
        S.maybeKick = false;
        let pct = S.hasProgress ? 0 : 100;
        if (S.hasProgress) {   // la grabación dura 1,1 s: si el corte fue justo al golpear, el % aún puede ir bajo
          const t0 = Date.now();
          for (;;) {
            try { pct = (await S.t.read('PROG'))[0]; } catch (e) { pct = 0; break; }
            if (pct >= SB.KICK_PROGRESS_THRESHOLD || Date.now() - t0 > (pct > 0 ? 1500 : 450)) break;
            await sleep(60);
          }
        }
        log('Tras reconectar, AD33 = ' + pct + ' %');
        if (pct >= SB.KICK_PROGRESS_THRESHOLD) {
          S.pendingDownload = true;
          const t0 = Date.now();                 // por si la grabación (1,1 s) aún no ha terminado
          while (S.hasProgress && pct < 100 && Date.now() - t0 < 1800) { await sleep(120); try { pct = (await S.t.read('PROG'))[0]; } catch (e) { break; } }
        } else { dropClip(); setState('idle'); toast('El balón no llegó a registrar ningún chute. Prepáralo otra vez.'); return; }
      }
      if (S.pendingDownload) { setState('idle'); S.autoRetried = false; await downloadNow(true); }
      else setState('idle');
    } catch (e) {
      if (quiet) log('Reconexión: ' + ((e && e.message) || e)); else showError(e);
      setState(S.pendingDownload || S.maybeKick ? 'needReconnect' : 'disconnected');
    }
  }

  async function readInfo() {
    const info = { name: S.t.name };
    const tryRead = async (k) => { try { return await S.t.read(k); } catch (e) { log('No pude leer ' + k + ': ' + e.message); return null; } };
    const dec = new TextDecoder();
    let b = await tryRead('BATT'); if (b) info.battery = b[0];
    b = await tryRead('STATUS'); if (b) { const v = b[0] | ((b[1] || 0) << 8); info.status = SB.describeStatus(v); log('Estado AD1F = 0x' + v.toString(16)); }
    b = await tryRead('RATE'); if (b) { const p = b[0] | ((b[1] || 0) << 8); info.samplePeriodMs = p; S.samplePeriodMs = p >= 1 && p <= 20 ? p : 1; log('Periodo de muestreo AD20 = ' + p + ' ms'); }
    b = await tryRead('PROG'); S.hasProgress = !!b; if (b) log('Progreso AD33 = ' + b[0] + ' %'); else log('AD33 no disponible: el chute se detectará con AD14');
    b = await tryRead('FW'); if (b) info.firmware = dec.decode(b).replace(/\0/g, '');
    b = await tryRead('MFR'); if (b) info.manufacturer = dec.decode(b).replace(/\0/g, '');
    S.info = info;
    renderConn();
  }

  // ------------------------------------------------------------ cámara
  function camError(e) {
    const n = e && e.name;
    if (n === 'NotAllowedError' || n === 'SecurityError') return 'Chrome no tiene permiso para usar la cámara. Toca el candado de la barra de direcciones y permite «Cámara».';
    if (n === 'NotFoundError' || n === 'OverconstrainedError') return 'No encuentro ninguna cámara en este dispositivo.';
    if (n === 'NotReadableError') return 'Otra aplicación está usando la cámara.';
    return 'No he podido abrir la cámara (' + ((e && e.message) || n) + ').';
  }
  async function ensureCam() {
    if (!S.cam.open) await S.cam.start({ fps60: settings.cam60, audio: settings.camAudio });
    S.cam.attach($('#preview'));
  }
  async function toggleCam() {
    audio();
    if (!settings.cam) {
      try { await ensureCam(); } catch (e) { toast(camError(e)); return; }
      settings.cam = true; saveSettings(); S.framing = true;
      if (['waitingReady', 'ready'].includes(S.state)) S.cam.startRolling();
      toast('Vídeo activado. Encuadra el chute: grabaré solo unos segundos antes y después de cada uno.');
    } else {
      settings.cam = false; saveSettings(); S.framing = false; S.cam.close();
    }
    renderDock(); refreshStage();
  }
  S.cam.onLost = () => { S.framing = false; refreshStage(); };
  function dropClip() { const p = S.clipPromise; S.clipPromise = null; S.provisional = false; if (p) p.catch(() => {}); S.cam.stopRolling(); }

  // ------------------------------------------------------------ flujo del chute
  async function arm() {
    if (!S.t || !S.t.connected) return;
    if (screen !== 'kick') showScreen('kick');
    audio();
    clearDownloadTimers();
    S.pendingDownload = false; S.maybeKick = false;
    S.decoder.reset();
    S.pollGen++; S.lastPct = 0; S.checkingZero = false;
    dropClip();
    setState('arming');
    if (settings.cam) {
      try { await ensureCam(); S.cam.startRolling(); }
      catch (e) { toast('Este chute irá sin vídeo. ' + camError(e)); }
      refreshStage();
    }
    try {
      await S.t.write('CMD', SB.CMD.RESET);
      await sleep(250);
      await S.t.write('CMD', SB.CMD.START_LOGGING);
      setState('waitingReady');
    } catch (e) { showError(e); dropClip(); setState(S.t.connected ? 'idle' : 'disconnected'); }
  }

  async function cancelArm() {
    S.pollGen++;
    dropClip();
    try { await S.t.write('CMD', SB.CMD.RESET); } catch (e) { log('Reset al cancelar: ' + e.message); }
    setState('idle');
  }

  function onLogging(b) {
    log('AD14 ← ' + hex(b));
    const v = b[0];
    if (v === 1 && S.state === 'waitingReady') {
      setState('ready');
      whistle(); buzz([180, 90, 180]); setTimeout(() => say('Listo'), 900);
      startStallWatch();
      pollProgress();
    } else if (v === 0 && S.state === 'ready') {
      // Un 0 con el balón armado puede ser «chute» (así lo interpreta la app de la USC) o que el balón
      // se ha movido sin golpeo (el SDK oficial vuelve a armar). Se decide mirando si está grabando.
      // Antes del «listo» los 0 se ignoran, como hace el SDK oficial.
      onNotReadyWhileArmed();
    }
  }

  async function onNotReadyWhileArmed() {
    if (S.checkingZero) return;
    S.checkingZero = true;
    try {
      if (!S.hasProgress) { onKick(); return; }           // sin AD33, el 0 es la única señal de chute
      const t0 = Date.now();
      while (Date.now() - t0 < 900 && S.state === 'ready') await sleep(60);
      if (S.state !== 'ready' || !S.t || !S.t.connected) return; // el sondeo ya detectó el chute
      if (S.lastPct > 0) return;                           // está grabando: el sondeo lo recogerá
      log('AD14=0 sin grabación: se rearma');
      setState('waitingReady', 'Se ha movido. Déjalo quieto otra vez.');
      await S.t.write('CMD', SB.CMD.START_LOGGING);
    } catch (e) { showError(e); } finally { S.checkingZero = false; }
  }

  async function pollProgress() {
    if (!S.hasProgress) return;
    const gen = ++S.pollGen;             // cancela cualquier sondeo anterior
    S.lastPct = 0;
    let errors = 0;
    while (gen === S.pollGen && (S.state === 'ready' || S.state === 'waitingReady') && S.t && S.t.connected) {
      if (S.state !== 'ready') { await sleep(100); continue; }
      let pct = 0;
      try { pct = (await S.t.read('PROG'))[0]; errors = 0; } catch (e) {
        if (++errors === 1 || errors % 20 === 0) log('AD33: ' + e.message);
        await sleep(200); continue;
      }
      if (gen !== S.pollGen) return;
      S.lastPollOk = Date.now();
      if (pct !== S.lastPct) log('AD33 = ' + pct + ' %');
      S.lastPct = pct;
      if (pct >= SB.KICK_PROGRESS_THRESHOLD && S.state === 'ready') { S.pollGen++; onKick(); return; }
      if (S.provisional && pct === 0) {   // falsa alarma: el balón sigue ahí y no ha grabado nada
        log('El balón responde y no hay chute: sigo grabando vídeo');
        const p = S.clipPromise; S.clipPromise = null; S.provisional = false;
        if (p) p.then(() => { if (settings.cam && ['ready', 'waitingReady'].includes(S.state)) S.cam.startRolling(); });
      }
      await sleep(30);
    }
  }
  // Si el balón deja de responder con el chute armado, lo más probable es que haya salido volando fuera de
  // alcance: se cierra el vídeo en torno a ese instante sin esperar a que el móvil dé la conexión por perdida.
  function startStallWatch() {
    stopStallWatch(); S.lastPollOk = Date.now();
    S.stallTimer = setInterval(() => {
      if (S.state !== 'ready') { stopStallWatch(); return; }
      if (!S.clipPromise && S.cam.rolling && Date.now() - S.lastPollOk > 1500) {
        log('El balón no responde desde hace 1,5 s: posible chute, cierro el vídeo');
        S.kickWall = S.lastPollOk + 150; S.provisional = true;
        S.clipPromise = S.cam.markKick(S.kickWall);
      }
    }, 300);
  }
  function stopStallWatch() { if (S.stallTimer) clearInterval(S.stallTimer); S.stallTimer = null; }

  async function onKick() {
    if (!S.clipPromise) { S.kickWall = Date.now(); S.clipPromise = S.cam.rolling ? S.cam.markKick(S.kickWall) : null; }
    S.provisional = false;
    setState('kicked');
    beep(1300, 0.09); buzz(90);
    S.pendingDownload = true;
    try { await S.t.write('CMD', SB.CMD.STOP_LOGGING); } catch (e) { log('STOP: ' + e.message); }
    const t0 = Date.now();
    while (Date.now() - t0 < 1600 && S.t.connected) { // dejar que termine de grabar (~1,1 s)
      if (S.hasProgress) { try { const p = (await S.t.read('PROG'))[0]; if (p >= 100) break; } catch (e) { break; } }
      await sleep(80);
    }
    S.autoRetried = false;
    await downloadNow(false);
  }

  function clearDownloadTimers() {
    if (S.dlWatch) clearInterval(S.dlWatch); S.dlWatch = null;
    if (S.finishTimer) clearTimeout(S.finishTimer); S.finishTimer = null;
  }

  async function downloadNow(afterReconnect) {
    if (!S.t || !S.t.connected) { setState('needReconnect'); return; }
    clearDownloadTimers();
    S.decoder.reset();
    setState('downloading');
    S.dlStart = Date.now(); S.lastPacket = 0;
    try {
      if (afterReconnect) {
        try { await S.t.write('CMD', SB.CMD.STOP_LOGGING); } catch (e) { log('STOP: ' + e.message); }
        await sleep(150);
        await S.t.write('CMD', SB.CMD.RESET); await sleep(250);
      }
      try { const r = await S.t.read('RATE'); const p = r[0] | ((r[1] || 0) << 8); S.samplePeriodMs = p >= 1 && p <= 20 ? p : 1; } catch (e) { log('AD20: ' + e.message); }
      await S.t.write('CMD', SB.CMD.DOWNLOAD);
    } catch (e) { showError(e); setState(S.t.connected ? 'needRetry' : 'needReconnect'); return; }
    S.dlWatch = setInterval(() => {
      const idle = Date.now() - (S.lastPacket || S.dlStart);
      if (S.state !== 'downloading') { clearDownloadTimers(); return; }
      if (S.lastPacket ? idle > 2500 : idle > 6000) { log('Descarga: sin datos durante ' + idle + ' ms'); finishDownload(true); }
    }, 250);
  }

  function onResponse(b) {
    if (S.state !== 'downloading') { log('AD17 fuera de descarga ← ' + hex(b)); return; }
    S.lastPacket = Date.now();
    const kind = S.decoder.push(b);
    if (kind === 'header' || kind === 'end' || S.decoder.packets < 3) log('AD17 ' + kind + ' ← ' + hex(b));
    setProgress(S.decoder.samples.length / 1097);
    if (kind === 'end') finishDownload(false);
    else if (S.decoder.samples.length >= 1097 && !S.finishTimer) S.finishTimer = setTimeout(() => finishDownload(false), 500);
  }

  function finishDownload(timedOut) {
    if (S.state !== 'downloading') return;
    clearDownloadTimers();
    const samples = S.decoder.result();
    log(`Descarga: ${samples.length} muestras, ${S.decoder.packets} paquetes, ${S.decoder.gaps} saltos de secuencia${timedOut ? ' (por tiempo)' : ''}, ${Date.now() - S.dlStart} ms`);
    if (samples.length < 200) {
      if (S.t.connected && !S.autoRetried) { S.autoRetried = true; log('Descarga vacía: reintento automático'); downloadNow(true); return; }
      setState(S.t.connected ? 'needRetry' : 'needReconnect');
      toast('No llegaron datos suficientes (' + samples.length + ' muestras). Acerca el balón y pulsa «Descargar otra vez».');
      return;
    }
    S.pendingDownload = false;
    const kick = {
      id: Date.now(), at: new Date().toISOString(), dtMs: S.samplePeriodMs, n: samples.length,
      gaps: S.decoder.gaps, partial: !!timedOut && samples.length < 1000, tag: '', demo: !!S.t.isDemo,
      truth: S.t.isDemo ? S.t.lastTruth : undefined, openField: !!settings.openField, foot: settings.foot || null, raw: SB.samplesToB64(samples),
    };
    const res = analyzeKick(kick);
    kick.res = slim(res);
    kicks.unshift(kick);
    if (kicks.length > 150) kicks.length = 150;
    const said = chAssign(kick, res);
    storeKicks(kicks);
    const clip = S.clipPromise; S.clipPromise = null;
    S.framing = false;
    if (screen !== 'kick') showScreen('kick');
    setState('idle');
    renderResult(kick, res, true);
    renderHistory();
    if (screen === 'hist') renderEvo();
    announce(res, said);
    if (clip) attachClip(kick, clip);
  }

  async function attachClip(kick, promise) {
    let clip = null;
    try { clip = await promise; } catch (e) { clip = null; }
    if (!clip) { log('Vídeo: no se obtuvo ningún clip'); return; }
    let off = clip.kickOffsetMs - 200, synced = false;      // el aviso del balón llega ~0,2 s después del golpeo
    if (clip.hasAudio) {
      const hit = await SBVideo.findImpactSound(clip.blob, clip.kickOffsetMs);
      if (hit) { off = hit.ms; synced = true; log(`Vídeo: golpeo localizado por el sonido en ${Math.round(hit.ms)} ms (aviso en ${Math.round(clip.kickOffsetMs)} ms)`); }
      else log('Vídeo: no se distingue el sonido del golpeo; uso el aviso del balón');
    }
    const ok = await SBVideo.ClipStore.put(kick.id, clip);
    if (!ok) { toast('No he podido guardar el vídeo en el móvil.'); return; }
    kick.video = { mime: clip.mime, kickMs: Math.max(0, Math.round(off)), durMs: Math.round(clip.durationMs), fps: clip.fps || 30, synced, kb: Math.round(clip.blob.size / 1024) };
    log(`Vídeo guardado: ${kick.video.kb} kB, ${es(clip.durationMs / 1000)} s`);
    storeKicks(kicks); renderHistory(); pruneClips();
    if (S.current === kick.id) loadClip(kick);
  }
  async function pruneClips() {
    const withVideo = kicks.filter((k) => k.video);
    for (const k of withVideo.slice(40)) { if (k.fav) continue; await SBVideo.ClipStore.del(k.id); delete k.video; }
    storeKicks(kicks); renderUsage();
  }

  function analyzeKick(k) {
    const res = SB.analyze(SB.b64ToSamples(k.raw), (k.dtMs || 1) / 1000, { openField: !!k.openField });
    if (res.ok && res.launch && k.elevVideo != null) SB.setElevation(res, k.elevVideo, 'vídeo');
    return res;
  }
  function slim(r) {
    const keep = ['ok', 'reason', 'warnings', 'rpm', 'rps', 'speedKmh', 'axisAboveHorizontalDeg', 'sideRpm', 'horizRpm', 'topRpm', 'rifleRpm', 'elevDeg', 'elevSource', 'type', 'spinConfidence', 'topConfidence', 'elevConfidence', 'contactMs', 'flightMs', 'secondImpactMs', 'lowSpin'];
    const o = { av: ANALYSIS }; keep.forEach((k) => { if (r[k] !== undefined) o[k] = r[k]; });
    if (r.ok && r.launch) { const tr = SB.flight(r.launch); o.reachM = tr.land ? tr.land.x : null; o.apexM = tr.apex.z; }
    return o;
  }
  // Los chutes guardados con un análisis anterior se recalculan con el actual (los datos en bruto se conservan).
  function refreshOldResults() {
    let n = 0;
    for (const k of kicks) {
      if (!k.raw || (k.res && k.res.av === ANALYSIS)) continue;
      try { k.res = slim(analyzeKick(k)); n++; } catch (e) { log('No pude recalcular el chute ' + k.id + ': ' + e.message); }
    }
    if (n) { storeKicks(kicks); log('Chutes recalculados con el análisis actual: ' + n); renderHistory(); }
  }

  function announce(r, extra) {
    if (!r.ok) { beep(300, 0.3); say('No he podido analizar el chute' + (extra ? '. ' + extra : '')); return; }
    beep(1568, 0.1); setTimeout(() => beep(2093, 0.14), 120);
    const parts = [Math.round(r.speedKmh) + ' kilómetros por hora', Math.round(r.rpm) + ' revoluciones'];
    if (r.type) parts.push(r.type.toLowerCase());
    if (extra) parts.push(extra);
    say(parts.join('. '));
  }

  function onDisconnect() {
    stopStallWatch();
    if (S.manualDisconnect) { dropClip(); setState('disconnected'); return; }
    clearDownloadTimers();
    const was = S.state;
    S.pollGen++;
    if (['kicked', 'downloading', 'needRetry'].includes(was)) S.pendingDownload = true;
    if (was === 'ready') {   // con el balón armado, perder la conexión suele significar que ha salido volando
      S.maybeKick = true;
      if (!S.clipPromise && S.cam.rolling) { S.kickWall = (S.lastPollOk || Date.now()) + 150; S.clipPromise = S.cam.markKick(S.kickWall); }
      S.provisional = false;
    } else if (!S.pendingDownload) dropClip();
    if (S.pendingDownload || S.maybeKick) { setState('needReconnect'); autoReconnect(); }
    else setState('disconnected');
  }

  async function autoReconnect() {
    if (S.reconnecting || !S.t || S.t.isDemo) return;
    S.reconnecting = true;
    const t0 = Date.now();
    while (S.state === 'needReconnect' && Date.now() - t0 < 20 * 60000 && !S.manualDisconnect) {
      try { await openSession(true); if (S.t.connected) break; } catch (e) { /* reintento */ }
      await sleep(3000);
    }
    S.reconnecting = false;
  }

  async function manualReconnect() {
    if (!S.t) return connect(false, false);
    if (S.t.isDemo) { const keep = S.pendingDownload; await connect(false, true); S.pendingDownload = keep; return; }
    await openSession();
  }

  function disconnect() {
    S.manualDisconnect = true;
    clearDownloadTimers(); stopStallWatch();
    S.pollGen++; S.pendingDownload = false; S.maybeKick = false;
    dropClip();
    if (S.t && S.t.connected) S.t.write('CMD', SB.CMD.RESET).catch(() => {}).finally(() => S.t.disconnect());
    else setState('disconnected');
  }
  function discard() {
    S.pendingDownload = false; S.maybeKick = false; clearDownloadTimers(); dropClip();
    setState(S.t && S.t.connected ? 'idle' : 'disconnected');
  }

  // ------------------------------------------------------------ estado, barra de acción y escena
  const STATES = {
    disconnected: { text: 'Conecta el balón', sub: 'Con Bluetooth y Ubicación activados, en Google Chrome.', cls: '' },
    connecting: { text: 'Conectando…', sub: 'Si el balón no sale en la lista, acércalo y muévelo un poco.', cls: 'wait' },
    idle: { text: 'Coloca el balón', sub: 'Logo hacia arriba y flechas apuntando al objetivo.', cls: '' },
    arming: { text: 'Preparando…', sub: '', cls: 'wait' },
    waitingReady: { text: 'Quieto…', sub: 'No toques el balón hasta oír el silbato.', cls: 'wait' },
    ready: { text: '¡Chuta!', sub: 'Tiene que subir 1 m y recorrer 10 m sin botar.', cls: 'go' },
    kicked: { text: 'Chute grabado', sub: 'Leyendo el balón…', cls: 'wait' },
    downloading: { text: 'Descargando…', sub: '', cls: '' },
    needReconnect: { text: 'Trae el balón', sub: 'El chute está guardado dentro. Acércalo al móvil y se descarga solo.', cls: '' },
    needRetry: { text: 'Descarga incompleta', sub: 'Acerca el balón y pulsa «Descargar otra vez».', cls: 'bad' },
  };
  const DOCK = {
    disconnected: ['Conectar balón', 'connect', 'Probar sin balón', 'demo'],
    connecting: ['Conectando…', null, null, null],
    idle: [() => (kicks.length ? 'Preparar siguiente chute' : 'Preparar chute'), 'arm', null, null],
    arming: ['Cancelar', 'cancel', null, null],
    waitingReady: ['Cancelar', 'cancel', null, null],
    ready: ['Cancelar', 'cancel', null, null],
    kicked: ['Leyendo el balón…', null, null, null],
    downloading: ['Descargando…', null, null, null],
    needReconnect: ['Reconectar ahora', 'reconnect', 'Descartar este chute', 'discard'],
    needRetry: ['Descargar otra vez', 'retry', 'Descartar este chute', 'discard'],
  };
  const ACTIONS = {
    connect: () => connect(false, false), demo: () => connect(false, true), arm, cancel: cancelArm,
    reconnect: manualReconnect, retry: () => { S.autoRetried = true; return downloadNow(true); }, disconnect, discard,
  };
  function act(name) { const fn = ACTIONS[name]; if (fn) return fn(); return null; }

  function setState(st, sub) {
    S.state = st;
    if (st !== 'ready') stopStallWatch();
    const d = STATES[st] || STATES.idle;
    $('#statusText').textContent = d.text;
    $('#statusSub').textContent = sub || d.sub;
    $('#banner').className = 'banner' + (d.cls ? ' ' + d.cls : '');
    $('#progress').hidden = st !== 'downloading';
    if (st === 'downloading') setProgress(0);
    renderDock(); renderConn(); refreshStage(); renderFootSel();
  }
  function setProgress(f) {
    const p = Math.round(Math.max(0, Math.min(1, f)) * 100);
    $('#progressBar').style.width = p + '%';
    $('#statusText').textContent = 'Descargando ' + p + ' %';
    $('#statusSub').textContent = 'Mantén el balón cerca del móvil.';
  }
  function renderDock() {
    const d = DOCK[S.state] || DOCK.idle, main = $('#btnMain'), alt = $('#btnAlt'), cam = $('#btnCam');
    main.textContent = typeof d[0] === 'function' ? d[0]() : d[0];
    main.dataset.act = d[1] || ''; main.disabled = !d[1];
    main.className = 'main' + (d[1] === 'cancel' ? ' stop' : '');
    alt.hidden = !d[2]; alt.textContent = d[2] || ''; alt.dataset.act = d[3] || '';
    cam.hidden = !SBVideo.supported();
    cam.setAttribute('aria-pressed', String(!!settings.cam));
    $('#dock').hidden = screen !== 'kick';
  }
  function renderConn() {
    const el = $('#conn'), on = !!(S.t && S.t.connected), i = S.info || {};
    $('#btnDisc').hidden = !(on && S.state === 'idle');
    $('#pill').className = 'pill' + (on ? ' on' : S.state === 'needReconnect' ? ' lost' : '');
    const batt = on && i.battery != null;
    $('#batt').hidden = !batt;
    if (batt) { $('#battPct').textContent = i.battery + ' %'; $('#battLvl').setAttribute('width', String(Math.max(1, 12.9 * Math.min(100, i.battery) / 100))); }
    if (!on) {
      el.textContent = S.state === 'needReconnect' ? 'Fuera de alcance' : 'Sin balón';
      $('#ballInfo').textContent = S.state === 'needReconnect' ? 'Fuera de alcance: acércalo al móvil.' : 'Sin conectar.';
      return;
    }
    el.textContent = i.status && i.status.onCharger ? (i.status.charging ? 'Cargando' : 'En la base') : (S.t.isDemo ? 'Demostración' : 'Conectado');
    const parts = [S.t.isDemo ? 'Balón simulado' : (i.name || 'Smart Ball')];
    if (i.battery != null) parts.push('batería ' + i.battery + ' %');
    if (i.firmware) parts.push('firmware ' + i.firmware);
    if (i.status && i.status.onCharger) parts.push(i.status.charging ? 'cargando' : 'en la base');
    $('#ballInfo').textContent = parts.join(', ') + '.';
  }
  function stageMode() {
    const live = ['arming', 'waitingReady', 'ready', 'kicked'].includes(S.state) || (S.framing && ['idle', 'disconnected', 'connecting'].includes(S.state));
    return settings.cam && S.cam.open && live ? 'camera' : 'scene';
  }
  // Mientras se prepara y se descarga el chute, la escena ocupa toda la pantalla; después, el resultado.
  const CYCLE = ['arming', 'waitingReady', 'ready', 'kicked', 'downloading', 'needReconnect', 'needRetry'];
  function heroMode() { return !(S.current != null && S.currentRes && !CYCLE.includes(S.state)); }
  function refreshStage() {
    const mode = stageMode(), hero = heroMode();
    $('#scr-kick').classList.toggle('hero', hero);
    $('#preview').hidden = mode !== 'camera';
    $('#result').hidden = hero;
    $('#banner').hidden = !hero;
    $('#views').hidden = hero || !S.fl;
    if (hero) $('#minibar').classList.remove('on');
    $('#footSel').hidden = !(hero && S.t && S.t.connected && ['idle', 'arming', 'waitingReady', 'ready'].includes(S.state));
    document.querySelectorAll('#views [data-view]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === scene.view)));
    if (hero && screen === 'kick') { const bh = $('#banner').offsetHeight; if (bh) S.bannerMax = Math.max(S.bannerMax || 0, bh); scene.heroBottom = S.bannerMax || 0; }
    scene.setHero(hero);
    if (mode === 'scene' && screen === 'kick') scene.draw();
    renderChalStrip();
  }
  function renderFootSel() {
    document.querySelectorAll('#footSel [data-foot]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.foot === settings.foot)));
  }

  // ------------------------------------------------------------ pantallas
  let screen = 'kick';
  function showScreen(name) {
    if (!document.querySelector(`.screen[data-scr="${name}"]`)) name = 'kick';
    const changed = screen !== name;
    screen = name;
    document.querySelectorAll('.screen').forEach((s) => { s.hidden = s.dataset.scr !== name; });
    document.querySelectorAll('#tabs [data-scr]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.scr === name)));
    const sc = $('#screens'); if (changed && sc) sc.scrollTop = 0;
    renderDock(); placeToast();
    if (name === 'kick') { refreshStage(); redrawPanels(); }
    else if (name === 'hist') { renderHistory(); renderEvo(); }
    else if (name === 'retos') renderChallenge();
    else if (name === 'more') renderUsage();
  }

  let toastTimer = null;
  function toast(msg) {
    const el = $('#toast'); el.textContent = msg; el.hidden = false;
    placeToast();
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, 7000);
    log('Aviso: ' + msg);
  }
  function placeToast() {
    const el = $('#toast'); if (!el || el.hidden) return;
    const anchor = [$('#dock'), $('#tabs')].find((x) => x && !x.hidden && x.offsetHeight);
    if (anchor && anchor.getBoundingClientRect) { const top = anchor.getBoundingClientRect().top; if (top > 0) el.style.bottom = Math.max(8, window.innerHeight - top + 8) + 'px'; }
  }
  function showError(e) {
    const m = (e && e.message) || String(e);
    log('ERROR: ' + m);
    if (/User cancelled|chooser/i.test(m)) return;
    toast(m + (/GATT|Tiempo agotado|disconnected|desconectado/i.test(m) ? ' Acerca el balón y vuelve a intentarlo.' : ''));
  }

  // ------------------------------------------------------------ resultado
  const signed = (x) => (x == null || !isFinite(x) ? '—' : (x > 0 ? '+' : x < 0 ? '−' : '') + Math.round(Math.abs(x)));
  const confTag = (c) => (c ? `<span class="tagc ${c}">fiabilidad ${c}</span>` : '');
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function reading(res, fl) {
    if (res.lowSpin) return res.speedKmh >= 90 ? 'Casi sin giro y fuerte: el balón flota y se puede mover de forma imprevisible.' : 'Casi sin giro: vuela recto, sin efecto que lo desvíe.';
    if (!fl) return '';
    const eff = SB.spinEffect(fl, settings.goalDist);
    const parts = [];
    if (eff) {
      if (Math.abs(eff.dz) >= 0.15) parts.push((eff.dz < 0 ? 'lo baja ' : 'lo sube ') + es(Math.abs(eff.dz)) + ' m');
      if (Math.abs(eff.dy) >= 0.15) parts.push('lo desvía ' + es(Math.abs(eff.dy)) + ' m a la ' + (eff.dy > 0 ? 'izquierda' : 'derecha'));
    }
    if (!parts.length) return 'El giro apenas cambia la trayectoria.';
    return `En ${es(eff.x, 0)} m, el efecto ${parts.join(' y ')} respecto al mismo chute sin giro.`;
  }

  function spinAxis(res) {
    if (res.lowSpin || !(res.rpm > 0) || res.sideRpm == null) return null;
    let top = res.topRpm, rifle = res.rifleRpm;
    if (top == null || res.topConfidence === 'baja') { top = res.horizRpm || 0; rifle = 0; }   // solo se conoce la inclinación
    const v = [rifle || 0, top, res.sideRpm], n = Math.hypot(v[0], v[1], v[2]);
    return n ? v.map((x) => x / n) : null;
  }
  function strikeOf(res) {
    if (!res.launch || res.lowSpin) return null;
    const L = res.topConfidence === 'baja' ? { ...res.launch, top: 0, rifle: 0 } : res.launch;
    return SB.strikePoint(L);
  }
  function strikeText(res, sp) {
    if (!sp) return 'Con tan poco giro no se puede situar el golpeo.';
    const cm = (x) => es(Math.abs(x) * 100, 1) + ' cm';
    const parts = [];
    if (Math.abs(sp.up) >= 0.003) parts.push(cm(sp.up) + (sp.up > 0 ? ' por encima' : ' por debajo'));
    if (Math.abs(sp.right) >= 0.003) parts.push(cm(sp.right) + (sp.right > 0 ? ' a la derecha' : ' a la izquierda'));
    let s = parts.length ? 'El empuje pasó ' + parts.join(' y ') + ' del centro.' : 'El empuje pasó por el centro.';
    if (res.topConfidence === 'baja') s += ' No se distingue si fue por arriba o por abajo.';
    return s;
  }

  function fkFacts(res, fl) {
    const D = settings.goalDist, m = fl.main, out = [];
    const sure = (lo, hi) => hi - lo < 0.9;   // con la banda ancha no se da veredicto
    const range = (lo, hi) => (hi - lo < 0.25 ? '' : `Entre ${es(Math.max(0, lo))} y ${es(hi)} m según el ángulo de salida.`);
    // El dibujo sigue la estimación central; el texto dice lo mismo y, si el margen es ancho, lo dice en condicional.
    let wallHit = false;
    if (settings.wall && D >= WALL_X + 2) {
      const q = SB.flightAtX(m, WALL_X);
      if (!q) out.push(['Barrera: el balón bota antes de llegar.', '']);
      else if (Math.abs(q.y) >= 1.2) out.push([`Barrera: pasa por un lado, a ${es(Math.abs(q.y))} m de su centro.`, '']);
      else {
        const [lo, hi] = SB.bandAtX(fl, WALL_X);
        wallHit = q.z < 1.72;
        const s = wallHit ? (hi < 1.7 ? `llega a ${es(q.z)} m de altura y da en ella.` : `llega a ${es(q.z)} m de altura, así que daría en ella.`)
          : lo > 2.0 ? `la supera, pasa a ${es(q.z)} m de altura.` : sure(lo, hi) ? `pasa justo, a ${es(q.z)} m de altura.` : `pasa a ${es(q.z)} m de altura, así que la superaría.`;
        out.push(['Barrera: ' + s, range(lo, hi)]);
      }
    }
    const g = SB.flightAtX(m, D), where = wallHit ? `Sin la barrera, en la portería a ${D} m` : `Portería a ${D} m`;
    if (!g) out.push([`${where}: bota antes, a ${es(m.land ? m.land.x : 0, 1)} m.`, '']);
    else {
      const [lo, hi] = SB.bandAtX(fl, D);
      const v = hi < BAR_H - 0.1 ? ', bajo el larguero' : lo > BAR_H + 0.2 ? ', por encima del larguero' : sure(lo, hi) ? ', a la altura del larguero' : '';
      const lat = Math.abs(g.y) < 0.15 ? '' : ` Se desvía ${es(Math.abs(g.y))} m a la ${g.y > 0 ? 'izquierda' : 'derecha'}${Math.abs(g.y) > POST_Y ? ', más que medio arco' : ''}.`;
      out.push([`${where}: llega a ${es(g.z)} m de altura${v}.${lat}`, [range(lo, hi), 'El larguero está a 2,44 m.'].filter(Boolean).join(' ')]);
    }
    const ang = `Ángulo de salida: ${es(res.elevDeg, 0)}°`;
    if (res.elevSource === 'bote') out.push([ang + ', afinado con el primer bote.', '']);
    else if (res.elevSource === 'vídeo') out.push([ang + ', medido en el vídeo.', '']);
    else out.push([ang + ` (entre ${es(Math.max(0, res.elevRange[0]), 0)}° y ${es(res.elevRange[1], 0)}°).`, 'Es lo menos seguro con el balón solo. Se fija con el primer bote o midiéndolo en un vídeo lateral.']);
    return out;
  }

  function renderResult(kick, resIn, animate) {
    const res = resIn || analyzeKick(kick);
    S.current = kick.id; S.currentRes = res;
    $('#result').hidden = false;
    const when = new Date(kick.at);
    $('#resWhen').textContent = when.toLocaleString('es-ES', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }) + (kick.demo ? ', simulación' : '');
    $('#tag').value = kick.tag || '';
    $('#resBody').hidden = !res.ok; $('#resBad').hidden = res.ok;
    const notes = [];
    if (!res.ok) {
      $('#resType').textContent = 'Chute sin analizar';
      $('#resBad').textContent = res.reason || 'No se pudo analizar.';
      S.fl = null; scene.setFlight(null); spinBall.stop();
    } else {
      $('#resType').textContent = res.type || '';
      $('#nSpeed').textContent = Math.round(res.speedKmh);
      $('#nSpin').textContent = Math.round(res.rpm);
      $('#cSpin').textContent = `${es(res.rps, 1)} vueltas por segundo`;
      $('#mbType').textContent = res.type || ''; $('#mbSpeed').textContent = Math.round(res.speedKmh); $('#mbSpin').textContent = Math.round(res.rpm);
      const pk = prevKick(kick);
      $('#dSpeed').textContent = pk ? deltaText(res.speedKmh - pk.res.speedKmh, 'km/h') : '';
      $('#dSpin').textContent = pk ? deltaText(res.rpm - pk.res.rpm, 'rpm') : '';
      const fl = SB.kickFlight(res);
      S.fl = fl;
      $('#resReading').textContent = reading(res, fl);
      const tc = (res.dir && res.dir.tc) || 0.009;
      if (fl) {
        const m = fl.main, hit = res.secondImpactMs != null && !res.landFit;
        const recS = (res.secondImpactMs != null ? res.secondImpactMs : res.recordedMs) / 1000 - tc;
        scene.setFlight(fl, { recordedS: recS, hitS: hit ? recS : null });
        $('#flightFacts').hidden = false;
        $('#flightFacts').innerHTML = [[m.land ? es(m.land.x, 0) + ' m' : 'más de 100 m', 'hasta el primer bote'], [es(m.apex.z) + ' m', 'altura máxima'], [m.land ? es(m.land.t) + ' s' : '—', 'en el aire']].map(([v, l]) => `<li><b>${v}</b><span>${l}</span></li>`).join('');
        $('#flightNote').textContent = res.landFit ? `El balón botó a los ${es(res.landFit.flightS, 2)} s: la trayectoria está ajustada a ese bote.`
          : hit ? `Línea continua: lo que midió el balón (${es(recS, 2)} s, hasta que tocó algo). Discontinua: cómo habría seguido.`
            : `Línea continua: lo que midió el balón (${es(recS, 2)} s). Discontinua: cómo sigue según el modelo. La punteada blanca es el mismo chute sin efecto.`;
        // ¿el segundo impacto fue un bote?
        const ask = $('#landAsk');
        if (res.secondImpactMs != null && !kick.openField) {
          ask.hidden = false;
          ask.innerHTML = `A los ${es(res.secondImpactMs / 1000, 2)} s el balón tocó algo. Si fue el primer bote en el suelo, con ese dato la trayectoria queda mucho más precisa.<br><button class="btn solid" data-land="1">Fue un bote en el suelo</button>`;
        } else if (kick.openField && res.landFit) {
          ask.hidden = false;
          ask.innerHTML = 'Trayectoria ajustada con el primer bote.<br><button class="btn" data-land="0">No fue un bote: deshacer</button>';
        } else ask.hidden = true;
        $('#fkFacts').innerHTML = fkFacts(res, fl).map(([a, b]) => `<li>${escapeHtml(a)}${b ? `<small>${escapeHtml(b)}</small>` : ''}</li>`).join('');
      } else {
        scene.setFlight(null);
        $('#flightFacts').hidden = true; $('#landAsk').hidden = true;
        $('#flightNote').textContent = 'Sin la lectura del balón en reposo no se puede orientar la trayectoria.';
        $('#fkFacts').innerHTML = '';
      }
      // giro y golpeo
      const axis = spinAxis(res);
      S.spinArgs = [axis, res.rpm];
      spinBall.set(axis, res.rpm, 20);
      $('#spinCap').innerHTML = axis ? `<b>${es(res.axisAboveHorizontalDeg, 0)}° de inclinación</b>Visto desde detrás, 20 veces más lento.` + (res.topConfidence === 'baja' ? ' La orientación del eje respecto al tiro es dudosa.' : '') : '<b>Sin giro apreciable</b>No hay eje que dibujar.';
      const sp = strikeOf(res);
      SBScene.drawStrike($('#strikeCanvas'), sp);
      $('#strikeCap').innerHTML = `<b>Punto de golpeo</b>${escapeHtml(strikeText(res, sp))}`;
      const rows = [];
      if (res.topRpm != null && !res.lowSpin) rows.push([res.topRpm >= 0 ? 'Liftado' : 'Cortado', `${signed(res.topRpm)} rpm ${confTag(res.topConfidence)}`]);
      if (res.sideRpm != null && !res.lowSpin) { const fh = footHint(res, kick.foot); rows.push(['Rosca', `${signed(res.sideRpm)} rpm <small>${Math.abs(res.sideRpm) < 30 ? 'recto' : 'hacia la ' + (res.sideRpm > 0 ? 'izquierda' : 'derecha')}${fh ? ', ' + fh : ''}</small>`]); }
      if (res.rifleRpm != null && !res.lowSpin) rows.push(['En bala', `${signed(res.rifleRpm)} rpm <small>no desvía</small>`]);
      rows.push(['Giro total', `${Math.round(res.rpm)} rpm ${confTag(res.spinConfidence)}`]);
      $('#split').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
      (res.warnings || []).forEach((w) => notes.push(`<li>${escapeHtml(w)}</li>`));
      if (kick.gaps) notes.push('<li>Se perdieron paquetes en la descarga: puede haber saltos en los datos.</li>');
      if (kick.partial) notes.push('<li>Descarga incompleta: el análisis puede ser menos fiable.</li>');
      if (kick.truth) {
        const t = kick.truth;
        notes.unshift(`<li class="truth">Simulación de un ${escapeHtml(t.preset || 'chute')}: en realidad ${es(t.speedKmh, 0)} km/h, ${es(t.rpm, 0)} rpm, liftado ${signed(t.topRpm)}, rosca ${signed(t.sideRpm)}, bala ${signed(t.rifleRpm)}, salida a ${es(t.elevDeg, 0)}°.</li>`);
      }
    }
    $('#resNotes').innerHTML = notes.join('');
    document.querySelectorAll('#distSeg [data-d]').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.d === settings.goalDist)));
    $('#set_wall').checked = !!settings.wall;
    renderResMeta(kick, res);
    $('#rtVideo').hidden = !kick.video;
    refreshStage();
    showRtab(settings.rtab);
    if (animate && S.fl) scene.play();
    loadClip(kick);
  }
  // pie, favorito y reto del chute que se está viendo
  const FOOT = { left: 'izquierdo', right: 'derecho' };
  function renderResMeta(kick, res) {
    $('#resFoot').innerHTML = kick.foot ? `Pie <b>${FOOT[kick.foot]}</b>` : 'Pie sin indicar';
    $('#resFav').setAttribute('aria-pressed', String(!!kick.fav));
    $('#resFav').textContent = kick.fav ? '★ Favorito' : '☆ Favorito';
    const vc = $('#resChal'), ch = kick.chal;
    if (!ch) { vc.hidden = true; return; }
    const who = ch.name ? ch.name + ', ' : '';
    let txt, cls = '';
    if (ch.type === 'range') {
      cls = ch.hit ? 'hit' : 'miss';
      txt = ch.v == null ? `Reto: ${who}chute ${ch.k} de ${ch.n}. Sin velocidad: cuenta como fuera.`
        : `${ch.hit ? 'Dentro' : 'Fuera'} del rango: ${Math.round(ch.v)} km/h, entre ${ch.min} y ${ch.max}. ${who ? who.charAt(0).toUpperCase() + who.slice(1) : 'Chute '}${who ? 'chute ' : ''}${ch.k} de ${ch.n}.`;
    } else txt = `Reto «${RT[ch.type].label.toLowerCase()}»: ${who}chute ${ch.k} de ${ch.n}.`;
    const c = CH.active;
    if (c && c.id === ch.id) {
      const last = c.turns[c.turns.length - 1];
      if (c.done) { const w = chWinner(c); txt += c.players > 1 ? (w < 0 ? ' Reto terminado: empate.' : ` Reto terminado: gana ${chName(c, w)}.`) : ' Reto terminado.'; }
      else if (last && last.kickId === kick.id) txt += c.players > 1 ? ` Ahora le toca a ${chName(c, chTurnInfo(c).player)}.` : '';
    }
    vc.textContent = txt; vc.className = 'verdict' + (cls ? ' ' + cls : ''); vc.hidden = false;
  }
  function prevKick(kick) {
    const i = kicks.indexOf(kick); if (i < 0) return null;
    for (let j = i + 1; j < kicks.length; j++) { const k = kicks[j]; if (!!k.demo === !!kick.demo && k.res && k.res.ok) return k; }
    return null;
  }
  function deltaText(d, unit) {
    if (d == null || !isFinite(d)) return '';
    const r = Math.round(d);
    return r === 0 ? 'Igual que el anterior' : `${Math.abs(r)} ${unit} ${r > 0 ? 'más' : 'menos'} que el anterior`;
  }
  // Con el pie conocido, la rosca dice con qué parte se golpeó: con la derecha, el interior curva a la izquierda.
  function footHint(res, foot) {
    if (!foot || res.lowSpin || res.sideRpm == null || Math.abs(res.sideRpm) < 120) return '';
    const inside = (foot === 'right') === (res.sideRpm > 0);
    return inside ? 'típico del interior' : 'típico del exterior';
  }
  // pestañas del detalle
  function showRtab(name) {
    const ok = !!(S.currentRes && S.currentRes.ok), vid = !$('#rtVideo').hidden;
    if (name === 'video' && !vid) name = 'vuelo';
    if (!ok && vid) name = 'video';
    if (name !== settings.rtab && ok) { settings.rtab = name; saveSettings(); }
    document.querySelectorAll('#rtabs [data-rp]').forEach((b) => { b.setAttribute('aria-selected', String(b.dataset.rp === name)); if (b.dataset.rp !== 'video') b.hidden = !ok; });
    $('#rtabs').hidden = !ok && !vid;
    document.querySelectorAll('#result .rp').forEach((p) => { p.hidden = p.dataset.rp !== name || (!ok && name !== 'video'); });
    redrawPanels();
  }
  function redrawPanels() {
    const res = S.currentRes; if (!res || !res.ok || screen !== 'kick' || heroMode()) return;
    if (settings.rtab === 'giro') {
      if (S.spinArgs) spinBall.set(S.spinArgs[0], S.spinArgs[1], 20);
      SBScene.drawStrike($('#strikeCanvas'), strikeOf(res));
    }
    if (settings.rtab === 'video' && P.kick) drawClipOverlay();
  }
  function rerenderCurrent(animate) {
    const k = kicks.find((x) => x.id === S.current); if (!k) return;
    const res = analyzeKick(k); k.res = slim(res); storeKicks(kicks);
    renderResult(k, res, animate); renderHistory();
  }

  // ------------------------------------------------------------ vídeo del chute
  const P = { url: null, blob: null, kick: null, rate: 0.25, raf: 0, dur: 0, touched: false, measure: null, hold: null };
  const RATES = [[1, '1×'], [0.5, '½×'], [0.25, '¼×'], [0.125, '⅛×']];
  const kickS = () => (P.kick && P.kick.video ? P.kick.video.kickMs / 1000 : 0);
  function unloadClip() {
    const v = $('#clipVideo');
    if (P.raf) cancelAnimationFrame(P.raf); P.raf = 0;
    try { v.pause(); } catch (e) { /* nada */ }
    if (P.url) { v.removeAttribute('src'); try { v.load(); } catch (e) { /* nada */ } URL.revokeObjectURL(P.url); }
    P.url = null; P.blob = null; P.kick = null; P.touched = false; endMeasure();
  }
  async function loadClip(kick) {
    if (kick && kick.video && P.kick && P.kick.id === kick.id && P.url) {   // ya está cargado: solo se refresca lo que cambia
      P.kick = kick;
      measureLabel(); $('#clipBlock').hidden = false; updateClipUi(); return;
    }
    unloadClip();
    $('#clipBlock').hidden = true;
    if (!kick || !kick.video) return;
    const rec = await SBVideo.ClipStore.get(kick.id);
    if (S.current !== kick.id || !rec || !rec.blob) return;
    P.kick = kick; P.blob = rec.blob; P.url = URL.createObjectURL(rec.blob); P.dur = kick.video.durMs / 1000;
    const v = $('#clipVideo');
    v.src = P.url; v.playbackRate = P.rate;
    $('#vRate').textContent = (RATES.find((r) => r[0] === P.rate) || RATES[2])[1];
    $('#vPlay').textContent = 'Ver';
    measureLabel();
    $('#clipBlock').hidden = false;
    if ($('#rtVideo').hidden) { $('#rtVideo').hidden = false; showRtab(settings.rtab); }
    updateClipUi();
  }
  function onClipMeta() {
    const v = $('#clipVideo');
    if (v.videoWidth && v.videoHeight) $('#clipWrap').style.aspectRatio = v.videoWidth + ' / ' + v.videoHeight;
    const start = Math.max(0, kickS() - 1);
    if (!isFinite(v.duration) || !v.duration) {   // los vídeos grabados en el navegador no traen la duración
      const back = () => { v.removeEventListener('timeupdate', back); if (isFinite(v.duration)) P.dur = v.duration; v.currentTime = start; };
      v.addEventListener('timeupdate', back);
      try { v.currentTime = 1e7; } catch (e) { v.removeEventListener('timeupdate', back); }
    } else { P.dur = v.duration; v.currentTime = start; }
  }
  function videoRect() {   // rectángulo que ocupa la imagen dentro del marco
    const wrap = $('#clipWrap'), v = $('#clipVideo'), w = wrap.clientWidth, h = wrap.clientHeight;
    const a = v.videoWidth && v.videoHeight ? v.videoWidth / v.videoHeight : 16 / 9;
    let dw = w, dh = w / a; if (dh > h) { dh = h; dw = h * a; }
    return { x: (w - dw) / 2, y: (h - dh) / 2, w: dw, h: dh };
  }
  // La trayectoria que calculó el balón, encima del vídeo: los dos toques de la medida dan el origen, el sentido
  // y la escala (lo que avanzó el balón en ese intervalo, en píxeles y en metros). Solo vale con la cámara de lado.
  function drawClipOverlay() {
    const cv = $('#clipOver'); if (!cv || !cv.getContext) return;
    let ctx = null; try { ctx = cv.getContext('2d'); } catch (e) { ctx = null; }
    const k = P.kick, T = k && k.vtaps;
    const show = !!(T && k.elevVideo != null && S.fl && !P.measure && S.current === k.id);
    $('#clipNote').hidden = !show;
    if (!ctx) return;
    const wrap = $('#clipWrap'), w = wrap.clientWidth, h = wrap.clientHeight, dpr = Math.min(window.devicePixelRatio || 1, 3);
    const pw = Math.round(w * dpr), ph = Math.round(h * dpr);
    if (cv.width !== pw || cv.height !== ph) { cv.width = pw; cv.height = ph; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
    if (!show) return;
    const m = S.fl.main, R = videoRect(), z0 = m.Z[0];
    const x0 = R.x + T.u0 * R.w, y0 = R.y + T.v0 * R.h, x1 = R.x + T.u1 * R.w, y1 = R.y + T.v1 * R.h;
    const q = SB.flightAtT(m, Math.max(0.02, T.t1 - T.tk));
    const Lm = q ? Math.hypot(q.x, q.z - z0) : 0; if (!(Lm > 0.2)) return;
    const sc = Math.hypot(x1 - x0, y1 - y0) / Lm, dir = x1 >= x0 ? 1 : -1;
    const px = (x, z) => [x0 + dir * x * sc, y0 - (z - z0) * sc];
    const inside = (p) => p[0] > -30 && p[0] < w + 30 && p[1] > -30 && p[1] < h + 30;
    const recS = scene.meta && scene.meta.recordedS != null ? scene.meta.recordedS : Infinity;
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    for (const pass of [0, 1]) {            // primero un contorno oscuro para que se vea sobre cualquier fondo
      for (const part of ['medido', 'proyectado']) {
        ctx.beginPath(); let started = false;
        for (let i = 0; i < m.T.length; i++) {
          const t = m.T[i];
          if (!(part === 'medido' ? t <= recS + 1e-9 : t >= recS - 0.004)) { started = false; continue; }
          const p = px(m.X[i], m.Z[i]); if (!inside(p)) { started = false; continue; }
          if (!started) { ctx.moveTo(p[0], p[1]); started = true; } else ctx.lineTo(p[0], p[1]);
        }
        ctx.setLineDash(part === 'medido' ? [] : [6, 6]);
        ctx.strokeStyle = pass ? '#FFD60A' : 'rgba(0,0,0,0.5)'; ctx.lineWidth = pass ? 2.4 : 5; ctx.stroke();
      }
    }
    ctx.setLineDash([]);
    const rel = ($('#clipVideo').currentTime || 0) - T.tk;   // aro donde el balón dice que estaba en este fotograma
    if (rel >= -0.001 && rel <= m.T[m.T.length - 1]) {
      const b = SB.flightAtT(m, Math.max(0, rel)), p = px(b.x, b.z), r = Math.max(6, SB.PHYS.R * sc * 1.3);
      if (inside(p)) for (const pass of [0, 1]) { ctx.beginPath(); ctx.arc(p[0], p[1], r, 0, Math.PI * 2); ctx.strokeStyle = pass ? '#FFD60A' : 'rgba(0,0,0,0.55)'; ctx.lineWidth = pass ? 2.2 : 4.6; ctx.stroke(); }
    }
  }
  function updateClipUi() {
    drawClipOverlay();
    const v = $('#clipVideo'); if (!P.kick) return;
    const t = v.currentTime || 0, rel = t - kickS();
    if (document.activeElement !== $('#vSeek')) $('#vSeek').value = P.dur ? Math.round(1000 * Math.min(1, t / P.dur)) : 0;
    $('#clipStat').textContent = (Math.abs(rel) < 0.005 ? 'golpeo' : (rel > 0 ? '+' : '−') + es(Math.abs(rel), 2) + ' s') + (P.kick.video.synced ? '' : ' (aprox.)');
    if (P.touched && S.fl && stageMode() === 'scene') scene.setTime(rel);
  }
  function clipLoop() { updateClipUi(); const v = $('#clipVideo'); if (!v.paused && !v.ended) P.raf = requestAnimationFrame(clipLoop); else { P.raf = 0; $('#vPlay').textContent = 'Ver'; } }
  function clipPlayPause() {
    const v = $('#clipVideo'); if (!P.kick) return;
    if (!v.paused) { v.pause(); return; }
    P.touched = true;
    if (v.ended || v.currentTime > kickS() + 2.4 || (P.dur && v.currentTime > P.dur - 0.15)) v.currentTime = Math.max(0, kickS() - 1.5);
    v.playbackRate = P.rate;
    const p = v.play(); if (p && p.catch) p.catch((e) => log('Vídeo: ' + e.message));
    $('#vPlay').textContent = 'Pausa';
    if (!P.raf) P.raf = requestAnimationFrame(clipLoop);
  }
  function clipStep(dir) {
    const v = $('#clipVideo'); if (!P.kick) return;
    v.pause(); P.touched = true;
    const fps = (P.kick.video.fps || 30);
    v.currentTime = Math.max(0, Math.min(P.dur || 1e9, v.currentTime + dir / fps));
  }
  function holdStep(dir, on) {
    if (P.hold) { clearInterval(P.hold); P.hold = null; }
    if (on) { clipStep(dir); let n = 0; P.hold = setInterval(() => { if (++n > 3) clipStep(dir); }, 110); }
  }
  function clipHint(msg) { const el = $('#clipHint'); el.hidden = !msg; el.textContent = msg || ''; }
  function measureLabel() { $('#vMeasure').textContent = P.measure ? 'Salir de la medida' : P.kick && P.kick.elevVideo != null ? 'Quitar el ángulo medido' : 'Medir el ángulo de salida'; }
  function endMeasure() { P.measure = null; $('#mark0').hidden = true; $('#mark1').hidden = true; clipHint(''); measureLabel(); }
  function startMeasure() {
    const k = P.kick; if (!k) return;
    if (P.measure) { endMeasure(); drawClipOverlay(); return; }   // salir sin medir
    if (k.elevVideo != null) { delete k.elevVideo; delete k.vtaps; toast('Ángulo medido en el vídeo quitado.'); rerenderCurrent(false); return; }
    if (!S.currentRes || !S.currentRes.launch) { toast('Este chute no tiene trayectoria que ajustar.'); return; }
    const v = $('#clipVideo'); v.pause(); P.touched = true;
    P.measure = { p0: null, t0: 0 };
    measureLabel(); drawClipOverlay();
    v.currentTime = kickS();
    clipHint('Con la cámara de lado y el móvil derecho: busca con ‹ y › el fotograma del golpeo y toca el balón.');
  }
  function onClipTap(e) {
    if (!P.measure) { clipPlayPause(); return; }
    const wrap = $('#clipWrap'), r = wrap.getBoundingClientRect(), x = e.clientX - r.left - wrap.clientLeft, y = e.clientY - r.top - wrap.clientTop, v = $('#clipVideo');
    const put = (el) => { el.style.left = x + 'px'; el.style.top = y + 'px'; el.hidden = false; };
    if (!P.measure.p0) {
      P.measure.p0 = { x, y }; P.measure.t0 = v.currentTime; put($('#mark0'));
      v.currentTime = Math.min(P.dur || 1e9, v.currentTime + 0.2);
      clipHint('Ahora toca el balón donde está en este fotograma. Con ‹ y › puedes elegir otro: mejor entre 0,15 y 0,3 s después del golpeo.');
      return;
    }
    // instante del golpeo: el del sonido si el primer toque se hizo en ese fotograma; si no, el del primer toque
    const tk = P.kick.video.synced && Math.abs(P.measure.t0 - kickS()) < 0.08 ? kickS() : P.measure.t0;
    const dt = v.currentTime - tk, dx = Math.abs(x - P.measure.p0.x), dy = P.measure.p0.y - y;
    if (dt < 0.06) { clipHint('Avanza unos fotogramas con › antes de marcar el segundo punto.'); return; }
    if (dx < 12) { clipHint('Los dos puntos quedan casi en vertical. Para medir el ángulo la cámara tiene que ver el chute de lado. Toca de nuevo el segundo punto o pulsa «Salir de la medida».'); return; }
    put($('#mark1'));
    const chord = Math.atan2(dy, dx) * 180 / Math.PI;
    if (chord < -3 || chord > 72) { clipHint('Ese ángulo no es posible para un chute desde el suelo. Vuelve a tocar el segundo punto.'); return; }
    const e2 = SB.elevFromChord(S.currentRes.launch, chord, dt);
    const k = P.kick; k.elevVideo = Math.round(e2 * 10) / 10;
    const R = videoRect(), r4 = (n) => Math.round(n * 1e4) / 1e4;
    k.vtaps = { u0: r4((P.measure.p0.x - R.x) / R.w), v0: r4((P.measure.p0.y - R.y) / R.h), u1: r4((x - R.x) / R.w), v1: r4((y - R.y) / R.h), tk: r4(tk), t1: r4(v.currentTime) };
    log(`Vídeo: cuerda ${es(chord)}° en ${es(dt, 2)} s → salida ${es(e2)}°`);
    toast(`Ángulo de salida medido en el vídeo: ${es(e2, 0)}°. La trayectoria queda dibujada encima.`);
    endMeasure();
    rerenderCurrent(true);
  }
  async function shareClip() {
    if (!P.blob) return;
    const ext = /mp4/.test(P.blob.type) ? 'mp4' : 'webm';
    const name = `chute-${new Date(P.kick.at).toISOString().slice(0, 19).replace(/[:T]/g, '-')}.${ext}`;
    const file = new File([P.blob], name, { type: P.blob.type });
    if (navigator.canShare && navigator.canShare({ files: [file] })) { try { await navigator.share({ files: [file], title: 'Chute' }); } catch (e) { if (e.name !== 'AbortError') showError(e); } }
    else downloadBlob(name, P.blob);
  }
  async function deleteClip() {
    const k = P.kick; if (!k) return;
    await SBVideo.ClipStore.del(k.id); delete k.video; delete k.elevVideo; delete k.vtaps;
    storeKicks(kicks); unloadClip(); $('#clipBlock').hidden = true; $('#rtVideo').hidden = true; renderHistory(); renderUsage(); rerenderCurrent(false);
  }
  async function renderUsage() {
    const el = $('#clipUsage'); if (!el) return;
    const n = kicks.filter((k) => k.video).length, kb = kicks.reduce((s, k) => s + ((k.video && k.video.kb) || 0), 0);
    el.textContent = n ? `Vídeos guardados en este móvil: ${n} (${es(kb / 1024, 0)} MB). Se conservan los 40 más recientes y los favoritos.` : 'No hay vídeos guardados.';
  }

  // ------------------------------------------------------------ historial y marcas
  function renderHistory() {
    const ul = $('#history');
    renderMarks();
    if (!kicks.length) { ul.innerHTML = '<li class="empty">Todavía no hay ninguno. Conecta el balón o prueba sin él para ver cómo queda.</li>'; $('#histCount').textContent = ''; return; }
    $('#histCount').textContent = '(' + kicks.length + ')';
    ul.innerHTML = kicks.map((k) => {
      const r = k.res || {};
      const d = new Date(k.at).toLocaleString('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
      const main = r.ok ? `<b>${es(r.speedKmh, 0)} km/h</b>, ${es(r.rpm, 0)} rpm, ${escapeHtml((r.type || '').toLowerCase())}` : 'sin analizar';
      const meta = [d]; if (k.foot) meta.push('pie ' + FOOT[k.foot]); if (k.demo) meta.push('simulación'); if (k.video) meta.push('con vídeo'); if (k.tag) meta.push(escapeHtml(k.tag));
      return `<li data-id="${k.id}" class="${S.current === k.id ? 'sel' : ''}"><div><div class="h2">${main}</div><div class="h1">${meta.join(', ')}</div></div><button class="ico${k.fav ? ' on' : ''}" data-fav="${k.id}" aria-label="${k.fav ? 'Quitar de favoritos' : 'Marcar como favorito'}" aria-pressed="${!!k.fav}">★</button><button class="ico" data-del="${k.id}" aria-label="Borrar este chute">✕</button></li>`;
    }).join('');
  }
  function renderMarks() {
    const real = kicks.filter((k) => !k.demo && k.res && k.res.ok), el = $('#marks');
    if (!real.length) { el.hidden = true; return; }
    const max = (f) => real.reduce((m, k) => { const v = f(k.res); return v != null && isFinite(v) && v > m ? v : m; }, -Infinity);
    const sp = max((r) => r.speedKmh), rp = max((r) => r.rpm), tp = max((r) => (r.topConfidence !== 'baja' ? r.topRpm : null));
    el.hidden = false;
    el.innerHTML = [[es(sp, 0), 'km/h, el más rápido'], [es(rp, 0), 'rpm, el de más giro'], [tp > 0 ? es(tp, 0) : '—', 'rpm, el más liftado']].map(([v, l]) => `<li><b>${v}</b><span>${l}</span></li>`).join('');
  }

  // ------------------------------------------------------------ exportar / importar
  function csvOf(list) {
    const head = ['fecha', 'pie', 'etiqueta', 'velocidad_kmh', 'rpm', 'vueltas_s', 'eje_sobre_horizontal_grados', 'liftado_rpm', 'rosca_rpm', 'bala_rpm', 'salida_grados', 'salida_fuente', 'alcance_m', 'altura_max_m', 'segundo_impacto_ms', 'tipo', 'fiabilidad_giro', 'fiabilidad_liftado', 'video', 'simulado'];
    const num = (x, d) => (x == null || !isFinite(x) ? '' : x.toFixed(d || 0).replace('.', ','));
    const q = (s) => '"' + String(s == null ? '' : s).replace(/"/g, '""') + '"';
    const rows = list.map((k) => { const r = k.res || {}; return [q(new Date(k.at).toLocaleString('es-ES')), q(k.foot ? FOOT[k.foot] : ''), q(k.tag), num(r.speedKmh), num(r.rpm), num(r.rps, 1), num(r.axisAboveHorizontalDeg), num(r.topRpm), num(r.sideRpm), num(r.rifleRpm), num(r.elevDeg, 1), q(r.elevSource || 'balón'), num(r.reachM, 1), num(r.apexM, 1), num(r.secondImpactMs), q(r.ok ? r.type : r.reason), q(r.spinConfidence), q(r.topConfidence), k.video ? 'sí' : 'no', k.demo ? 'sí' : 'no'].join(';'); });
    return '﻿' + head.join(';') + '\n' + rows.join('\n');
  }
  function jsonOf(list) {
    return JSON.stringify({ app: 'smartball', version: VERSION, formato: 'muestras int16 little-endian x,y,z en base64; ~511 cuentas por g; periodo dtMs', exportado: new Date().toISOString(), chutes: list }, null, 1);
  }
  function stamp() { const d = new Date(); return d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0') + '-' + String(d.getHours()).padStart(2, '0') + String(d.getMinutes()).padStart(2, '0'); }
  function downloadBlob(name, blob) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  const download = (name, text, type) => downloadBlob(name, new Blob([text], { type }));
  async function share() {
    if (!kicks.length) return toast('No hay chutes que compartir.');
    const files = [new File([jsonOf(kicks)], `smartball-${stamp()}.json`, { type: 'application/json' }), new File([csvOf(kicks)], `smartball-${stamp()}.csv`, { type: 'text/csv' })];
    if (navigator.canShare && navigator.canShare({ files })) {
      try { await navigator.share({ files, title: 'Chutes Smart Ball' }); } catch (e) { if (e.name !== 'AbortError') showError(e); }
    } else { download(files[0].name, jsonOf(kicks), 'application/json'); toast('Este navegador no comparte archivos; lo he descargado.'); }
  }
  async function importFile(file) {
    try {
      const data = JSON.parse(await file.text());
      const list = Array.isArray(data) ? data : data.chutes || data.kicks || [];
      let added = 0;
      for (const k of list) {
        if (!k.raw || kicks.some((x) => x.id === k.id)) continue;
        const copy = { ...k }; delete copy.video;
        copy.res = slim(analyzeKick(copy)); kicks.push(copy); added++;
      }
      kicks.sort((a, b) => (a.at < b.at ? 1 : -1));
      storeKicks(kicks); renderHistory();
      toast(`Importados ${added} chutes.`);
    } catch (e) { showError(e); }
  }

  // ------------------------------------------------------------ evolución por semanas
  const EVO = {
    speed: { label: 'velocidad', unit: 'km/h', of: (r) => r.speedKmh },
    spin: { label: 'giro', unit: 'rpm', of: (r) => r.rpm },
    top: { label: 'liftado', unit: 'rpm', of: (r) => (r.topConfidence && r.topConfidence !== 'baja' && r.topRpm > 0 ? r.topRpm : null) },   // solo liftados
  };
  const EV = { data: null, sel: null, geom: null };
  function weekStart(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; }
  const fmtDay = (d) => d.toLocaleDateString('es-ES', { day: 'numeric', month: 'short' }).replace('.', '');
  function evoData() {
    const real = kicks.filter((k) => !k.demo && k.res && k.res.ok);
    const base = real.length ? real : kicks.filter((k) => k.res && k.res.ok);
    const M = EVO[settings.evoMetric] || EVO.speed, f = settings.evoFoot;
    const pts = base.filter((k) => f === 'all' || k.foot === f).map((k) => ({ t: new Date(k.at), v: M.of(k.res) })).filter((p) => p.v != null && isFinite(p.v));
    const out = { pts, weeks: [], demo: !real.length && base.length > 0, M };
    if (!pts.length) return out;
    const now = weekStart(new Date()), first = weekStart(new Date(Math.min(...pts.map((p) => p.t.getTime()))));
    const nW = Math.max(1, Math.min(12, Math.round((now - first) / (7 * 864e5)) + 1));
    for (let i = nW - 1; i >= 0; i--) { const d = new Date(now); d.setDate(d.getDate() - 7 * i); out.weeks.push({ start: d, vals: [] }); }
    for (const p of pts) { const ws = weekStart(p.t).getTime(); const wk = out.weeks.find((x) => x.start.getTime() === ws); if (wk) wk.vals.push(p); }
    for (const wk of out.weeks) { const v = wk.vals.map((p) => p.v); wk.n = v.length; wk.mean = v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; wk.best = v.length ? Math.max(...v) : null; }
    return out;
  }
  function niceTicks(lo, hi, n) {
    if (!(hi > lo)) { const d = Math.max(1, Math.abs(lo) * 0.1); lo -= d; hi += d; }
    const raw = (hi - lo) / Math.max(1, n), mag = Math.pow(10, Math.floor(Math.log10(raw))), fr = raw / mag;
    const step = (fr <= 1 ? 1 : fr <= 2 ? 2 : fr <= 5 ? 5 : 10) * mag, out = [];
    for (let v = Math.floor(lo / step) * step; v <= Math.ceil(hi / step) * step + step * 1e-9; v += step) out.push(Math.round(v * 1e6) / 1e6);
    return out;
  }
  function renderEvo() {
    document.querySelectorAll('#evoMetric [data-m]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.m === settings.evoMetric)));
    document.querySelectorAll('#evoFoot [data-f]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.f === settings.evoFoot)));
    const D = evoData(); EV.data = D; EV.sel = null;
    const withData = D.weeks.filter((w) => w.n);
    $('#evoLegend').hidden = !withData.length;
    $('#evoNote').textContent = !withData.length ? (kicks.length ? 'No hay chutes con este filtro.' : 'Cuando haya chutes, aquí verás cómo evolucionan semana a semana.') : evoSummary(D);
    drawEvo();
    renderEvoTable(D);
  }
  function evoSummary(D) {
    const ws = D.weeks.filter((w) => w.n), last = ws[ws.length - 1], prev = ws[ws.length - 2], u = D.M.unit, n0 = (x) => es(x, 0);
    const isNow = last === D.weeks[D.weeks.length - 1];
    let s = `${isNow ? 'Esta semana' : 'Semana del ' + fmtDay(last.start)}: media ${n0(last.mean)} ${u} y mejor ${n0(last.best)} ${u}, en ${last.n} ${last.n === 1 ? 'chute' : 'chutes'}.`;
    if (prev) { const d = Math.round(last.mean - prev.mean); s += ` Semana del ${fmtDay(prev.start)}: media ${n0(prev.mean)} ${u} (${d === 0 ? 'igual' : (d > 0 ? d + ' más ahora' : -d + ' menos ahora')}).`; }
    if (settings.evoMetric === 'top') s += ' Solo cuentan los chutes liftados.';
    if (D.demo) s += ' Son chutes de simulación: cuando haya reales, se usan solo esos.';
    return s;
  }
  function drawEvo() {
    const cv = $('#evoChart'), f = SBScene.fit(cv); if (!f) return;
    const { ctx, w, h } = f, D = EV.data;
    const padL = 42, padR = 12, padT = 12, padB = 28;
    if (!D || !D.weeks.some((x) => x.n)) {
      ctx.strokeStyle = 'rgba(244,247,241,0.14)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(padL, h - padB + 0.5); ctx.lineTo(w - padR, h - padB + 0.5); ctx.stroke();
      EV.geom = null; return;
    }
    const weeks = D.weeks, vals = D.pts.filter((p) => p.t >= weeks[0].start).map((p) => p.v);
    const ticks = niceTicks(Math.min(...vals), Math.max(...vals), 4), lo = ticks[0], hi = ticks[ticks.length - 1];
    const bw = (w - padL - padR) / weeks.length;
    const X = (i) => padL + (i + 0.5) * bw, Y = (v) => padT + (hi - v) / ((hi - lo) || 1) * (h - padT - padB);
    ctx.font = '12px ' + getComputedStyle(document.body).fontFamily;
    ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(244,247,241,0.14)'; ctx.fillStyle = 'rgba(244,247,241,0.74)'; ctx.textAlign = 'right';
    for (const t of ticks) { const y = Math.round(Y(t)) + 0.5; ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke(); ctx.fillText(String(t), padL - 7, y + 4); }
    ctx.textAlign = 'center';
    const every = Math.max(1, Math.ceil(52 / bw));
    weeks.forEach((wk, i) => { if ((weeks.length - 1 - i) % every === 0) ctx.fillText(fmtDay(wk.start), X(i), h - 9); });
    if (EV.sel != null && weeks[EV.sel]) { const x = Math.round(X(EV.sel)) + 0.5; ctx.strokeStyle = 'rgba(244,247,241,0.45)'; ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, h - padB); ctx.stroke(); }
    // cada chute, repartido dentro de su semana según el día
    ctx.fillStyle = 'rgba(244,247,241,0.5)';
    weeks.forEach((wk, i) => { for (const p of wk.vals) { const x = padL + i * bw + bw * (0.18 + 0.64 * ((p.t.getDay() + 6) % 7) / 6); ctx.beginPath(); ctx.arc(x, Y(p.v), 2.6, 0, Math.PI * 2); ctx.fill(); } });
    // media de la semana: línea de 2 px
    ctx.strokeStyle = '#F4F7F1'; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    const mid = weeks.map((wk, i) => (wk.mean == null ? null : [X(i), Y(wk.mean)])).filter(Boolean);
    if (mid.length > 1) { ctx.beginPath(); mid.forEach((q, i) => (i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]))); ctx.stroke(); }
    for (const q of mid) { ctx.beginPath(); ctx.moveTo(q[0] - 7, q[1]); ctx.lineTo(q[0] + 7, q[1]); ctx.stroke(); }
    // la mejor de la semana: punto amarillo con anillo del color del fondo
    weeks.forEach((wk, i) => { if (wk.best == null) return; ctx.beginPath(); ctx.arc(X(i), Y(wk.best), 5, 0, Math.PI * 2); ctx.fillStyle = '#FFD60A'; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = '#0B5539'; ctx.stroke(); });
    EV.geom = { padL, bw, n: weeks.length };
  }
  function evoPick(i) {
    const D = EV.data; if (!D || !EV.geom) return;
    EV.sel = Math.max(0, Math.min(D.weeks.length - 1, i));
    const wk = D.weeks[EV.sel], u = D.M.unit;
    $('#evoNote').textContent = wk.n ? `Semana del ${fmtDay(wk.start)}: media ${es(wk.mean, 0)} ${u}, mejor ${es(wk.best, 0)} ${u}, ${wk.n} ${wk.n === 1 ? 'chute' : 'chutes'}.` : `Semana del ${fmtDay(wk.start)}: sin chutes.`;
    drawEvo();
  }
  function renderEvoTable(D) {
    const t = $('#evoTable'); if (!t) return;
    const rows = D.weeks.filter((w) => w.n).reverse();
    t.innerHTML = rows.length ? `<thead><tr><th>Semana del</th><th>Chutes</th><th>Media</th><th>Mejor</th></tr></thead><tbody>${rows.map((w) => `<tr><td>${fmtDay(w.start)}</td><td>${w.n}</td><td>${es(w.mean, 0)}</td><td>${es(w.best, 0)}</td></tr>`).join('')}</tbody>` : '';
    $('#evoTableBox').hidden = !rows.length;
    $('#evoTableUnit').textContent = D.M.unit;
  }

  // ------------------------------------------------------------ retos
  const CH_KEY = 'smartball.v1.retos';
  const CH = { active: null, past: [] };
  try { Object.assign(CH, JSON.parse(localStorage.getItem(CH_KEY) || '{}')); } catch (e) { /* sin almacenamiento */ }
  const saveCH = () => { try { localStorage.setItem(CH_KEY, JSON.stringify(CH)); } catch (e) { /* nada */ } };
  const RT = {
    range: { label: 'Velocidad en un rango', unit: 'km/h', of: (r) => r.speedKmh },
    speed: { label: 'El más rápido', unit: 'km/h', of: (r) => r.speedKmh },
    spin: { label: 'El de más giro', unit: 'rpm', of: (r) => r.rpm },
    top: { label: 'El más liftado', unit: 'rpm', of: (r) => (r.lowSpin ? 0 : r.topRpm) },
  };
  const chTitle = (c) => (c.type === 'range' ? `Entre ${c.min} y ${c.max} km/h` : RT[c.type].label);
  const chName = (c, p) => ((c.names && c.names[p]) || '').trim() || 'Jugador ' + (p + 1);
  function chTurnInfo(c) { const i = c.turns.length; return { idx: i, player: i % c.players, k: Math.floor(i / c.players) + 1, done: i >= c.n * c.players }; }
  function chScore(c, p) {
    const mine = c.turns.filter((t) => t.player === p);
    if (c.type === 'range') return mine.filter((t) => t.hit).length;
    const v = mine.map((t) => t.v).filter((x) => x != null && isFinite(x));
    return v.length ? Math.max(...v) : null;
  }
  function chCompare(c) {   // -1 empate, 0 o 1 quién va delante (o gana)
    if (c.players < 2) return null;
    const a = chScore(c, 0), b = chScore(c, 1);
    const ra = a == null ? -Infinity : Math.round(a), rb = b == null ? -Infinity : Math.round(b);
    return ra === rb ? -1 : ra > rb ? 0 : 1;
  }
  const chWinner = chCompare;
  function chStart(cfg) {
    const names = (cfg.names || ['', '']).slice(0, 2);
    CH.active = { id: Date.now(), type: cfg.type, min: cfg.min, max: cfg.max, players: cfg.players === 2 ? 2 : 1, n: cfg.n, names, turns: [], startedAt: new Date().toISOString(), done: false };
    saveCH(); chRefresh();
  }
  function chRefresh() { renderChallenge(); renderChalStrip(); $('#tabBadge').hidden = !(CH.active && !CH.active.done); }
  function chAssign(kick, res) {
    const c = CH.active; if (!c || c.done) return '';
    const ti = chTurnInfo(c); if (ti.done) return '';
    const raw = res && res.ok ? RT[c.type].of(res) : null, v = raw == null || !isFinite(raw) ? null : Math.round(raw * 10) / 10;
    const hit = c.type === 'range' ? v != null && v >= c.min && v <= c.max : null;
    c.turns.push({ kickId: kick.id, player: ti.player, v, hit });
    if (kick.foot) { c.feet = c.feet || [null, null]; c.feet[ti.player] = kick.foot; }
    kick.chal = { id: c.id, player: ti.player, name: c.players > 1 ? chName(c, ti.player) : '', k: ti.k, n: c.n, type: c.type, min: c.min, max: c.max, v, hit };
    const parts = [];
    if (c.type === 'range') parts.push(hit ? 'Dentro' : 'Fuera');
    if (chTurnInfo(c).done) {
      c.done = true; c.finishedAt = new Date().toISOString();
      const w = chWinner(c);
      CH.past.unshift({ id: c.id, at: c.finishedAt, title: chTitle(c), summary: chSummary(c) });
      if (CH.past.length > 20) CH.past.length = 20;
      parts.push('Reto terminado' + (c.players > 1 ? (w < 0 ? ', empate' : ', gana ' + chName(c, w)) : ''));
    } else if (c.players > 1) {
      const nx = chTurnInfo(c).player;
      parts.push('Le toca a ' + chName(c, nx));
      if (c.feet && c.feet[nx]) { settings.foot = c.feet[nx]; saveSettings(); }   // cada jugador con su pie
    }
    saveCH(); chRefresh();
    return parts.join('. ');
  }
  function chScoreLine(c) {
    const u = RT[c.type].unit, sc = (p) => { const s = chScore(c, p); return c.type === 'range' ? `${s} de ${c.n}` : (s == null ? '—' : `${Math.round(s)} ${u}`); };
    if (c.players < 2) return c.type === 'range' ? `${sc(0)} dentro del rango.` : `Mejor chute: ${sc(0)}.`;
    return `${chName(c, 0)} ${sc(0)}, ${chName(c, 1)} ${sc(1)}.`;
  }
  function chSummary(c) {
    if (c.players < 2) return chScoreLine(c);
    const w = chWinner(c);
    return (w < 0 ? 'Empate. ' : `Gana ${chName(c, w)}. `) + chScoreLine(c);
  }
  function chUndo() {
    const c = CH.active; if (!c || !c.turns.length) return;
    const t = c.turns.pop();
    const k = kicks.find((x) => x.id === t.kickId); if (k) { delete k.chal; storeKicks(kicks); }
    if (c.done) { c.done = false; delete c.finishedAt; CH.past = CH.past.filter((x) => x.id !== c.id); }
    saveCH(); chRefresh();
    if (k && S.current === k.id) renderResMeta(k, S.currentRes);
    toast('Chute anulado: ya no cuenta para el reto.');
  }
  let quitAt = 0;
  function chQuit() {
    const c = CH.active; if (!c) return;
    if (!c.done && c.turns.length && Date.now() - quitAt > 4000) {
      quitAt = Date.now(); $('#rbQuit').textContent = '¿Seguro? Pulsa otra vez';
      setTimeout(() => { if (CH.active === c && !c.done) $('#rbQuit').textContent = 'Terminar el reto'; }, 4000);
      return;
    }
    quitAt = 0; CH.active = null; saveCH(); chRefresh();
  }
  function renderChallenge() {
    const c = CH.active;
    $('#retoSetup').hidden = !!c; $('#retoBoard').hidden = !c;
    if (!c) { renderRtSetup(); renderRtPast(); return; }
    $('#rbTitle').textContent = chTitle(c);
    $('#rbSub').textContent = c.players > 1 ? `${chName(c, 0)} contra ${chName(c, 1)}, ${c.n} chutes cada uno, por turnos.` : `${c.n} chutes.`;
    const ti = chTurnInfo(c), lead = chCompare(c);
    $('#rbGrid').innerHTML = Array.from({ length: c.players }, (_, p) => {
      const mine = c.turns.filter((t) => t.player === p), sc = chScore(c, p);
      let bestI = -1;
      if (c.type !== 'range') { let bv = -Infinity; mine.forEach((t, i) => { if (t.v != null && t.v > bv) { bv = t.v; bestI = i; } }); }
      const cells = Array.from({ length: c.n }, (_, i) => {
        const t = mine[i];
        if (!t) return `<span class="cell${!c.done && ti.player === p && ti.k === i + 1 ? ' now' : ''}" aria-label="Chute ${i + 1}, pendiente">${i + 1}</span>`;
        const val = t.v == null ? '—' : Math.round(t.v);
        if (c.type === 'range') return `<span class="cell ${t.hit ? 'hit' : 'miss'}" aria-label="Chute ${i + 1}: ${val} km/h, ${t.hit ? 'dentro' : 'fuera'}">${val}</span>`;
        return `<span class="cell ${i === bestI ? 'best' : 'val'}" aria-label="Chute ${i + 1}: ${val} ${RT[c.type].unit}">${val}</span>`;
      }).join('');
      const scoreTxt = c.type === 'range' ? String(sc) : (sc == null ? '—' : String(Math.round(sc)));
      const sub = c.type === 'range' ? `dentro del rango, de ${mine.length} ${mine.length === 1 ? 'chute' : 'chutes'}` : `su mejor chute, en ${RT[c.type].unit}`;
      return `<div class="prow${c.players > 1 && lead === p ? ' lead' : ''}"><div class="name">${escapeHtml(chName(c, p))}<small>${sub}</small></div><div class="score">${scoreTxt}</div><div class="cells">${cells}</div></div>`;
    }).join('');
    const res = $('#rbResult');
    if (c.done) {
      const w = chWinner(c), head = c.players > 1 ? (w < 0 ? 'Empate' : `Gana ${escapeHtml(chName(c, w))}`) : (c.type === 'range' ? `${chScore(c, 0)} de ${c.n} dentro` : `Mejor chute: ${Math.round(chScore(c, 0) || 0)} ${RT[c.type].unit}`);
      res.innerHTML = `<b>${head}</b>${c.players > 1 ? escapeHtml(chScoreLine(c)) : ''}`; res.hidden = false;
      $('#rbTurn').textContent = '';
    } else {
      res.hidden = true;
      $('#rbTurn').textContent = c.players > 1 ? `Le toca a ${chName(c, ti.player)}: chute ${ti.k} de ${c.n}.` : `Chute ${ti.k} de ${c.n}.`;
    }
    $('#rbGo').hidden = c.done; $('#rbAgain').hidden = !c.done;
    $('#rbUndo').hidden = !c.turns.length;
    $('#rbQuit').textContent = c.done ? 'Nuevo reto' : 'Terminar el reto';
  }
  function renderRtSetup() {
    const r = settings.rt;
    document.querySelectorAll('#rtType [data-t]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.t === r.type)));
    document.querySelectorAll('#rtPlayers [data-p]').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.p === r.players)));
    document.querySelectorAll('#rtN [data-n]').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.n === r.n)));
    $('#rtRange').hidden = r.type !== 'range';
    $('#rtMin').textContent = r.min; $('#rtMax').textContent = r.max;
    $('#rtName2').hidden = r.players !== 2;
    if (document.activeElement !== $('#rtName1')) $('#rtName1').value = r.names[0] || '';
    if (document.activeElement !== $('#rtName2')) $('#rtName2').value = r.names[1] || '';
  }
  function renderRtPast() {
    const ul = $('#rtPast');
    ul.innerHTML = CH.past.length ? CH.past.slice(0, 10).map((x) => `<li>${escapeHtml(x.title)}<small>${new Date(x.at).toLocaleString('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}. ${escapeHtml(x.summary)}</small></li>`).join('') : '<li class="empty">Todavía no has terminado ninguno.</li>';
  }
  function renderChalStrip() {
    const el = $('#chalStrip'), c = CH.active;
    const show = !!c && !c.done && !!(S.t && S.t.connected) && screen === 'kick';
    el.hidden = !show;
    if (scene.captionOff !== show) { scene.captionOff = show; if (screen === 'kick') scene.draw(); }
    if (!show) return;
    const ti = chTurnInfo(c);
    const who = c.players > 1 ? `Turno de <b>${escapeHtml(chName(c, ti.player))}</b>, chute ${ti.k} de ${c.n}` : `Reto: chute <b>${ti.k} de ${c.n}</b>`;
    const goal = c.type === 'range' ? `, de ${c.min} a ${c.max} km/h` : '';
    el.innerHTML = `<span>${who}${goal}</span><button class="go" data-go="retos">Marcador</button>`;
  }

  // ------------------------------------------------------------ eventos
  function bind() {
    $('#btnMain').onclick = () => act($('#btnMain').dataset.act);
    $('#btnAlt').onclick = () => act($('#btnAlt').dataset.act);
    $('#btnDisc').onclick = disconnect;
    $('#btnCam').onclick = toggleCam;
    $('#tabs').onclick = (e) => { const b = e.target.closest('[data-scr]'); if (b) showScreen(b.dataset.scr); };
    $('#footSel').onclick = (e) => { const b = e.target.closest('[data-foot]'); if (!b) return; settings.foot = b.dataset.foot; saveSettings(); renderFootSel(); };
    $('#chalStrip').onclick = (e) => { if (e.target.closest('[data-go]')) showScreen('retos'); };
    $('#resFoot').onclick = () => {
      const k = kicks.find((x) => x.id === S.current); if (!k) return;
      k.foot = k.foot == null ? 'left' : k.foot === 'left' ? 'right' : null;
      storeKicks(kicks); renderResult(k, S.currentRes, false); renderHistory();
    };
    $('#resFav').onclick = () => { const k = kicks.find((x) => x.id === S.current); if (!k) return; k.fav = !k.fav; storeKicks(kicks); renderResMeta(k, S.currentRes); renderHistory(); };
    $('#rtabs').onclick = (e) => { const b = e.target.closest('[data-rp]'); if (b) showRtab(b.dataset.rp); };
    // evolución
    $('#evoMetric').onclick = (e) => { const b = e.target.closest('[data-m]'); if (!b) return; settings.evoMetric = b.dataset.m; saveSettings(); renderEvo(); };
    $('#evoFoot').onclick = (e) => { const b = e.target.closest('[data-f]'); if (!b) return; settings.evoFoot = b.dataset.f; saveSettings(); renderEvo(); };
    const evoAt = (e) => { const g = EV.geom; if (!g) return; const r = $('#evoChart').getBoundingClientRect(); evoPick(Math.floor((e.clientX - r.left - g.padL) / g.bw)); };
    $('#evoChart').addEventListener('pointerdown', evoAt);
    $('#evoChart').addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse' || e.buttons) evoAt(e); });
    $('#evoChart').addEventListener('keydown', (e) => {
      if (!EV.data || !EV.geom) return;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); evoPick((EV.sel == null ? EV.data.weeks.length - 1 : EV.sel) + (e.key === 'ArrowLeft' ? -1 : 1)); }
    });
    // retos
    $('#rtType').onclick = (e) => { const b = e.target.closest('[data-t]'); if (!b) return; settings.rt.type = b.dataset.t; saveSettings(); renderRtSetup(); };
    $('#rtPlayers').onclick = (e) => { const b = e.target.closest('[data-p]'); if (!b) return; settings.rt.players = +b.dataset.p; saveSettings(); renderRtSetup(); };
    $('#rtN').onclick = (e) => { const b = e.target.closest('[data-n]'); if (!b) return; settings.rt.n = +b.dataset.n; saveSettings(); renderRtSetup(); };
    $('#rtRange').onclick = (e) => {
      const b = e.target.closest('[data-step]'); if (!b) return;
      const [k, d] = b.dataset.step.split(':'), r = settings.rt;
      if (k === 'min') r.min = Math.max(10, Math.min(r.max - 5, r.min + +d)); else r.max = Math.min(160, Math.max(r.min + 5, r.max + +d));
      saveSettings(); renderRtSetup();
    };
    for (const [id, i] of [['#rtName1', 0], ['#rtName2', 1]]) $(id).oninput = () => { settings.rt.names[i] = $(id).value; saveSettings(); };
    $('#rtStart').onclick = () => {
      chStart(settings.rt);
      const c = CH.active;
      toast(c.players > 1 ? `Reto en marcha. Empieza ${chName(c, 0)}.` : 'Reto en marcha.');
      showScreen('kick');
    };
    $('#rbGo').onclick = () => showScreen('kick');
    $('#rbUndo').onclick = chUndo;
    $('#rbQuit').onclick = chQuit;
    $('#rbAgain').onclick = () => { const c = CH.active; if (!c) return; chStart(c); showScreen('kick'); };
    $('#views').onclick = (e) => {
      const b = e.target.closest('button'); if (!b) return;
      P.touched = false;
      if (b.dataset.view) { settings.view = b.dataset.view; saveSettings(); scene.t = null; scene.setView(b.dataset.view); refreshStage(); }
      else if (b.id === 'btnReplay') scene.play();
    };
    $('#distSeg').onclick = (e) => {
      const b = e.target.closest('[data-d]'); if (!b) return;
      settings.goalDist = +b.dataset.d; saveSettings(); scene.setContext(settings.goalDist, settings.wall);
      const k = kicks.find((x) => x.id === S.current); if (k) renderResult(k, S.currentRes, false);
    };
    $('#set_wall').onchange = () => { settings.wall = $('#set_wall').checked; saveSettings(); scene.setContext(settings.goalDist, settings.wall); const k = kicks.find((x) => x.id === S.current); if (k) renderResult(k, S.currentRes, false); };
    $('#landAsk').onclick = (e) => {
      const b = e.target.closest('[data-land]'); if (!b) return;
      const k = kicks.find((x) => x.id === S.current); if (!k) return;
      k.openField = b.dataset.land === '1';
      rerenderCurrent(true);
      if (k.openField && S.currentRes && !S.currentRes.landFit) toast('Ese impacto no encaja con un bote en el suelo; dejo la trayectoria como estaba.');
    };
    // vídeo
    const v = $('#clipVideo');
    v.addEventListener('loadedmetadata', onClipMeta);
    v.addEventListener('seeked', updateClipUi); v.addEventListener('timeupdate', updateClipUi);
    v.addEventListener('pause', () => { $('#vPlay').textContent = 'Ver'; });
    $('#clipWrap').addEventListener('pointerdown', onClipTap);
    window.addEventListener('resize', () => { if (P.kick) drawClipOverlay(); });
    $('#vPlay').onclick = clipPlayPause;
    for (const [id, dir] of [['#vBack', -1], ['#vFwd', 1]]) {
      const b = $(id);
      b.addEventListener('pointerdown', (e) => { e.preventDefault(); holdStep(dir, true); });
      for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(ev, () => holdStep(dir, false));
      b.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); clipStep(dir); } });
    }
    $('#vKick').onclick = () => { if (!P.kick) return; v.pause(); P.touched = true; v.currentTime = kickS(); };
    $('#vRate').onclick = () => { const i = RATES.findIndex((r) => r[0] === P.rate); const n = RATES[(i + 1) % RATES.length]; P.rate = n[0]; v.playbackRate = P.rate; $('#vRate').textContent = n[1]; };
    $('#vSeek').oninput = () => { if (!P.kick) return; v.pause(); P.touched = true; v.currentTime = (P.dur || 0) * $('#vSeek').value / 1000; };
    $('#vSetKick').onclick = () => { if (!P.kick) return; P.kick.video.kickMs = Math.round(v.currentTime * 1000); P.kick.video.synced = true; storeKicks(kicks); updateClipUi(); toast('Golpeo fijado en este fotograma.'); };
    $('#vMeasure').onclick = startMeasure;
    $('#vShare').onclick = shareClip;
    $('#vDelete').onclick = deleteClip;
    // historial
    $('#btnCsv').onclick = () => (kicks.length ? download(`smartball-${stamp()}.csv`, csvOf(kicks), 'text/csv') : toast('No hay chutes.'));
    $('#btnJson').onclick = () => (kicks.length ? download(`smartball-${stamp()}.json`, jsonOf(kicks), 'application/json') : toast('No hay chutes.'));
    $('#btnShare').onclick = share;
    $('#btnImport').onclick = () => $('#fileIn').click();
    $('#fileIn').onchange = (e) => { const f = e.target.files[0]; if (f) importFile(f); e.target.value = ''; };
    $('#btnClear').onclick = () => { $('#confirmClear').hidden = false; };
    $('#btnClearNo').onclick = () => { $('#confirmClear').hidden = true; };
    $('#btnClearYes').onclick = async () => {
      kicks = []; storeKicks(kicks); await SBVideo.ClipStore.clear();
      S.current = null; S.currentRes = null; S.fl = null; scene.setFlight(null); unloadClip();
      $('#result').hidden = true; $('#confirmClear').hidden = true; renderHistory(); renderUsage(); renderDock(); refreshStage();
    };
    $('#history').onclick = async (e) => {
      const fav = e.target.closest('[data-fav]');
      if (fav) { const k = kicks.find((x) => x.id === +fav.dataset.fav); if (k) { k.fav = !k.fav; storeKicks(kicks); renderHistory(); if (k.id === S.current) renderResMeta(k, S.currentRes); } return; }
      const del = e.target.closest('[data-del]');
      if (del) {
        const id = +del.dataset.del, k = kicks.find((x) => x.id === id);
        if (k && k.video) await SBVideo.ClipStore.del(id);
        kicks = kicks.filter((x) => x.id !== id); storeKicks(kicks);
        if (S.current === id) { S.current = null; S.currentRes = null; S.fl = null; scene.setFlight(null); unloadClip(); $('#result').hidden = true; refreshStage(); }
        renderHistory(); renderUsage(); renderDock(); renderEvo(); return;
      }
      const li = e.target.closest('li[data-id]'); if (!li) return;
      const k = kicks.find((x) => x.id === +li.dataset.id); if (!k) return;
      showScreen('kick');
      renderResult(k, null, true); renderHistory();
    };
    $('#tag').onchange = () => { const k = kicks.find((x) => x.id === S.current); if (k) { k.tag = $('#tag').value.trim(); storeKicks(kicks); renderHistory(); } };
    document.querySelectorAll('.chips button').forEach((ch) => { ch.onclick = () => { const t = $('#tag'); t.value = (t.value ? t.value + ', ' : '') + ch.textContent; t.onchange(); }; });
    for (const k of ['sound', 'speak', 'vibrate', 'openField', 'camAudio', 'cam60']) {
      const el = $('#set_' + k); el.checked = !!settings[k];
      el.onchange = () => { settings[k] = el.checked; saveSettings(); if ((k === 'cam60' || k === 'camAudio') && S.cam.open && !S.cam.rolling) { S.cam.close(); if (settings.cam) ensureCam().then(refreshStage).catch((e) => toast(camError(e))); } };
    }
    // diagnóstico
    $('#btnAnyDevice').onclick = () => connect(true, false);
    $('#btnReadStatus').onclick = async () => { if (S.t && S.t.connected) { await readInfo(); toast('Estado leído. Mira el registro.'); } else toast('Conecta primero el balón.'); };
    $('#btnRate').onclick = async () => {
      if (!S.t || !S.t.connected) return toast('Conecta primero el balón.');
      try { await S.t.write('CMD', SB.samplePeriodCommand(1)); await sleep(300); await readInfo(); toast('Periodo de muestreo: ' + S.info.samplePeriodMs + ' ms.'); } catch (e) { showError(e); }
    };
    $('#btnForce').onclick = async () => {
      if (!S.t || !S.t.connected) return toast('Conecta primero el balón.');
      S.pollGen++; S.autoRetried = true;
      await downloadNow(true);
    };
    $('#btnCopyLog').onclick = async () => {
      const text = `Smart Ball app ${VERSION}\n${navigator.userAgent}\n\n` + logLines.join('\n');
      try { await navigator.clipboard.writeText(text); toast('Registro copiado. Pégamelo en el chat.'); } catch (e) { download(`smartball-registro-${stamp()}.txt`, text, 'text/plain'); }
    };
    $('#diag').addEventListener('toggle', () => { if ($('#diag').open) $('#log').textContent = logLines.slice(-400).join('\n'); });
    window.addEventListener('pagehide', () => { if (S.t && S.t.connected && !S.t.isDemo) { try { S.t.write('CMD', SB.CMD.RESET); } catch (e) { /* nada */ } } S.cam.close(); });
    let rz = 0;
    window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { if (screen === 'kick') { scene.draw(); redrawPanels(); } else if (screen === 'hist') drawEvo(); }, 120); });
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => scene.draw()).catch(() => {});
  }

  function checkSupport() {
    const warn = $('#support');
    const msgs = [];
    if (!navigator.bluetooth) msgs.push('Este navegador no tiene Bluetooth web. En el Galaxy usa Google Chrome (Samsung Internet no sirve). En iPhone no funciona. Puedes probar sin balón.');
    else if (!window.isSecureContext) msgs.push('La página tiene que abrirse por https para usar Bluetooth.');
    warn.textContent = msgs.join(' ');
    warn.hidden = !msgs.length;
    if (navigator.bluetooth && navigator.bluetooth.getAvailability) {
      navigator.bluetooth.getAvailability().then((ok) => { if (!ok) { warn.textContent = 'El Bluetooth de este dispositivo está apagado o no existe. Puedes probar sin balón.'; warn.hidden = false; } }).catch(() => {});
    }
  }

  function init() {
    bind();
    checkSupport();
    const ver = $('#ver'); if (ver) ver.textContent = VERSION;
    showScreen('kick');
    setState('disconnected');
    renderHistory(); renderUsage();
    if (kicks.length) renderResult(kicks[0], null, false);
    renderHistory(); chRefresh(); renderFootSel();
    watchMinibar();
    log('App Smart Ball ' + VERSION + ' · ' + navigator.userAgent);
    setTimeout(refreshOldResults, 400);
    window.SmartBallApp = { S, P, act, scene, settings, showScreen, CH, kicks: () => kicks, current: () => ({ kick: kicks.find((x) => x.id === S.current) || null, res: S.currentRes }), analyzeKick };
  }
  // los números principales se quedan arriba al bajar por el detalle
  function watchMinibar() {
    const mb = $('#minibar'), target = $('#nums'), root = $('#screens');
    if (!mb || !target || typeof IntersectionObserver !== 'function') return;
    const io = new IntersectionObserver((ents) => {
      const e = ents[ents.length - 1], above = e.boundingClientRect.bottom < (e.rootBounds ? e.rootBounds.top : 0) + 4;
      mb.classList.toggle('on', !e.isIntersecting && above && screen === 'kick' && !heroMode() && !!(S.currentRes && S.currentRes.ok));
    }, { root, threshold: 0 });
    io.observe(target);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
