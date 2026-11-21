/* video.js — cámara: graba cada chute (unos segundos antes y después), guarda el vídeo en el móvil
 * y busca el sonido del golpeo para sincronizarlo con los datos del balón. */
(function (root) {
  'use strict';
  const SLOT_MS = 6000;   // cada cuánto se renueva una de las dos grabaciones en curso
  const POST_MS = 3000;   // cuánto se graba después del golpeo

  const supported = () => !!(root.navigator && navigator.mediaDevices && navigator.mediaDevices.getUserMedia && root.MediaRecorder);
  function pickMime() {
    const list = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
    for (const m of list) { try { if (MediaRecorder.isTypeSupported(m)) return m; } catch (e) { /* siguiente */ } }
    return '';
  }

  class KickCam {
    constructor(log) { this.stream = null; this.recs = []; this.timer = null; this.pending = null; this.log = log || (() => {}); this.fps = 30; this.hasAudio = false; this.mime = ''; this.onLost = null; }
    get open() { return !!(this.stream && this.stream.getVideoTracks().some((t) => t.readyState === 'live')); }
    get rolling() { return this.recs.length > 0; }
    async start(opts) {
      const o = opts || {};
      if (this.open) return;
      const video = { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: o.fps60 ? 60 : 30 } };
      const audio = o.audio === false ? false : { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
      try { this.stream = await navigator.mediaDevices.getUserMedia({ video, audio }); }
      catch (e) {
        if (!audio) throw e;
        this.log('Cámara con sonido no disponible (' + e.name + '): pruebo sin micrófono');
        this.stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
      }
      const vt = this.stream.getVideoTracks()[0], st = vt.getSettings ? vt.getSettings() : {};
      this.fps = Math.round(st.frameRate || 30); this.width = st.width; this.height = st.height;
      this.hasAudio = this.stream.getAudioTracks().length > 0;
      this.mime = pickMime();
      vt.addEventListener('ended', () => { this.log('La cámara se ha detenido'); this.stopRolling(); if (this.onLost) this.onLost(); });
      this.log(`Cámara: ${st.width}×${st.height} a ${this.fps} fps, sonido ${this.hasAudio ? 'sí' : 'no'}, formato ${this.mime || 'por defecto'}`);
    }
    close() {
      this.stopRolling();
      if (this.stream) this.stream.getTracks().forEach((t) => { try { t.stop(); } catch (e) { /* nada */ } });
      this.stream = null;
    }
    attach(el) { if (!el) return; el.srcObject = this.stream; el.muted = true; const p = el.play && el.play(); if (p && p.catch) p.catch(() => {}); }
    _rec() {
      const opt = { videoBitsPerSecond: 3500000 }; if (this.mime) opt.mimeType = this.mime;
      const r = new MediaRecorder(this.stream, opt);
      const rec = { r, chunks: [], wall: Date.now() };
      r.ondataavailable = (e) => { if (e.data && e.data.size) rec.chunks.push(e.data); };
      r.onerror = (e) => this.log('Error de grabación: ' + ((e.error && e.error.name) || e.type));
      r.start();
      return rec;
    }
    _drop(rec) { try { rec.r.ondataavailable = null; if (rec.r.state !== 'inactive') rec.r.stop(); } catch (e) { /* nada */ } }
    // Dos grabaciones solapadas que se renuevan por turnos: en cualquier momento hay una con 6–12 s de antelación
    // (margen para cuando el aviso del chute llega tarde porque el balón se ha ido fuera de alcance).
    startRolling() {
      if (!this.open || this.rolling) return false;
      this.pending = null;
      try { this.recs = [this._rec()]; } catch (e) { this.log('No se puede grabar: ' + e.message); this.recs = []; return false; }
      this.timer = setInterval(() => {
        if (this.pending) return;
        try {
          if (this.recs.length >= 2) this._drop(this.recs.shift());
          this.recs.push(this._rec());
        } catch (e) { this.log('Grabación continua: ' + e.message); }
      }, SLOT_MS);
      return true;
    }
    stopRolling() {
      if (this.timer) clearInterval(this.timer); this.timer = null;
      if (!this.pending) { this.recs.forEach((r) => this._drop(r)); this.recs = []; }
    }
    // Cierra el clip: kickWall = instante (Date.now) en que se supo del chute. Devuelve una promesa con el clip.
    markKick(kickWall) {
      if (this.pending) return this.pending;
      if (!this.rolling) return Promise.resolve(null);
      if (this.timer) clearInterval(this.timer); this.timer = null;
      const rec = this.recs[0];
      this.recs.slice(1).forEach((r) => this._drop(r));
      this.recs = [rec];
      this.pending = new Promise((resolve) => {
        const finish = () => {
          const type = (rec.r.mimeType || this.mime || 'video/webm').split(';')[0];
          const blob = new Blob(rec.chunks, { type });
          this.recs = []; this.pending = null;
          resolve(blob.size > 2000 ? { blob, mime: type, kickOffsetMs: Math.max(0, kickWall - rec.wall), durationMs: Date.now() - rec.wall, fps: this.fps, width: this.width, height: this.height, hasAudio: this.hasAudio } : null);
        };
        setTimeout(() => {
          try { rec.r.onstop = finish; if (rec.r.state !== 'inactive') rec.r.stop(); else finish(); } catch (e) { this.log('Cierre del vídeo: ' + e.message); this.recs = []; this.pending = null; resolve(null); }
        }, Math.max(0, POST_MS - (Date.now() - kickWall)));
      });
      return this.pending;
    }
  }

  // ------------------------------------------------------------------ sonido del golpeo
  // Busca el chasquido del golpeo cerca del instante estimado (el aviso por Bluetooth llega 0,1–0,4 s después).
  async function findImpactSound(blob, guessMs) {
    const OAC = root.OfflineAudioContext || root.webkitOfflineAudioContext;
    if (!OAC || !blob || !blob.arrayBuffer) return null;
    try {
      const ctx = new OAC(1, 44100, 44100);
      const data = await blob.arrayBuffer();
      const buf = await new Promise((res, rej) => { const p = ctx.decodeAudioData(data, res, rej); if (p && p.catch) p.catch(rej); });
      const ch = buf.getChannelData(0), sr = buf.sampleRate, hop = Math.max(1, Math.round(sr * 0.002)), n = Math.floor(ch.length / hop);
      const env = new Float32Array(n);
      for (let i = 0; i < n; i++) { let m = 0; for (let j = 0; j < hop; j++) { const v = Math.abs(ch[i * hop + j]); if (v > m) m = v; } env[i] = m; }
      const hopMs = 1000 * hop / sr;
      const i0 = Math.max(40, Math.floor((guessMs - 900) / hopMs)), i1 = Math.min(n - 1, Math.ceil((guessMs + 150) / hopMs));
      if (i1 - i0 < 20) return null;
      const win = Array.from(env.subarray(i0, i1)).sort((a, b) => a - b), floor = win[Math.floor(win.length / 2)] || 0;
      let best = -1, bestScore = 0;
      for (let i = i0; i < i1; i++) {
        let prev = 0; for (let k = 4; k <= 30; k++) prev = Math.max(prev, env[i - k]);
        const score = env[i] - 1.6 * prev;                 // subida brusca respecto a los 60 ms anteriores
        if (score > bestScore) { bestScore = score; best = i; }
      }
      if (best < 0 || env[best] < 0.04 || env[best] < 5 * floor) return null;
      return { ms: best * hopMs, peak: env[best], floor };
    } catch (e) { return null; }
  }

  // ------------------------------------------------------------------ almacén de vídeos (IndexedDB)
  const ClipStore = {
    _db: null,
    available() { return !!root.indexedDB; },
    open() {
      if (this._db) return Promise.resolve(this._db);
      if (!this.available()) return Promise.resolve(null);
      return new Promise((resolve) => {
        let req;
        try { req = indexedDB.open('smartball', 1); } catch (e) { resolve(null); return; }
        req.onupgradeneeded = () => { req.result.createObjectStore('clips', { keyPath: 'id' }); };
        req.onsuccess = () => { this._db = req.result; resolve(this._db); };
        req.onerror = () => resolve(null);
      });
    },
    async _tx(mode, fn) {
      const db = await this.open(); if (!db) return null;
      return new Promise((resolve) => {
        try {
          const tx = db.transaction('clips', mode), req = fn(tx.objectStore('clips'));
          tx.oncomplete = () => resolve(req ? req.result : true);
          tx.onerror = () => resolve(null); tx.onabort = () => resolve(null);
        } catch (e) { resolve(null); }
      });
    },
    put(id, clip) { return this._tx('readwrite', (s) => s.put({ id, blob: clip.blob, mime: clip.mime })); },
    get(id) { return this._tx('readonly', (s) => s.get(id)); },
    del(id) { return this._tx('readwrite', (s) => s.delete(id)); },
    clear() { return this._tx('readwrite', (s) => s.clear()); },
    keys() { return this._tx('readonly', (s) => s.getAllKeys()); },
  };

  root.SBVideo = { KickCam, ClipStore, findImpactSound, supported, POST_MS, SLOT_MS };
})(typeof self !== 'undefined' ? self : this);
