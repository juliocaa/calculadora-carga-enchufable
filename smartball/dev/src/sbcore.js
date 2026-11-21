/* sbcore.js — núcleo de la app Smart Ball.
 *
 * Protocolo tomado del SDK oficial "adidas-sensors-api" (hackathon Munich TechFest, sept. 2016:
 * clase com.adidas.sensors.api.smartball.SmartBallService / DataDownloader) y del informe
 * "All you need to know about the Smart Soccer Ball" (Stone, Stone, Guan, Nelakuditi,
 * University of South Carolina).
 *
 * Contiene: constantes del protocolo, decodificador de la descarga (tipo 2, comprimida),
 * codificador (para el balón simulado), simulador físico de un chute y el análisis
 * (giro, eje, componentes, velocidad estimada).
 */
(function (root, factory) {
  const SB = factory();
  if (typeof module === 'object' && module.exports) module.exports = SB;
  else root.SB = SB;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ------------------------------------------------------------------ protocolo
  const UUID16 = {
    SERVICE: 0xAD04,        // DIGITAL_BALL_SERVICE
    KICK_EVENT: 0xAD12,
    LOGGING: 0xAD14,        // notify: 1 = listo para chutar, 0 = no listo
    COMMAND: 0xAD15,        // write: comandos
    RESPONSE: 0xAD17,       // notify: datos de la descarga (20 bytes por paquete)
    STATUS: 0xAD1F,         // read: uint16 LE con bits de carga
    SAMPLE_PERIOD: 0xAD20,  // read/notify: uint16 LE, periodo de muestreo en ms
    PROGRESS: 0xAD33,       // read: byte[0] = % de grabación del chute
    ERROR: 0xADFE,          // notify: respuesta a comandos
    BATTERY_SERVICE: 0x180F,
    BATTERY_LEVEL: 0x2A19,
    DEVICE_INFO: 0x180A,
    MODEL: 0x2A24,
    FIRMWARE: 0x2A26,
    SOFTWARE: 0x2A28,
    MANUFACTURER: 0x2A29,
  };

  const CMD = {
    RESET: [6, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    START_LOGGING: [3, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    STOP_LOGGING: [4, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    // 0x0448 = 1096 muestras, tipo 2 (comprimido)
    DOWNLOAD: [10, 0, 0, 0, 0, 0x48, 0x04, 0, 0, 2, 0, 0, 0, 0],
  };
  function samplePeriodCommand(ms) {
    return [11, ms & 255, (ms >> 8) & 255, 0, 0, 0, 0, 0, 0, 0];
  }
  const STATUS_BITS = { CHARGING: 0x08, ON_CHARGER: 0x10, CHARGE_STOPPED: 0x20 };
  const N_SAMPLES = 1096;
  const KICK_PROGRESS_THRESHOLD = 10; // % (SDK oficial)

  function describeStatus(v) {
    return {
      raw: v,
      charging: !!(v & STATUS_BITS.CHARGING),
      onCharger: !!(v & STATUS_BITS.ON_CHARGER),
      chargeStopped: !!(v & STATUS_BITS.CHARGE_STOPPED),
    };
  }

  const toHex = (bytes) => Array.from(bytes, (b) => (b & 255).toString(16).padStart(2, '0')).join(' ');

  // ------------------------------------------------------------------ decodificador
  // Cada notificación de AD17 trae 20 bytes:
  //   bytes 0-1: uint16 LE = secuencia (13 bits) | banderas de compresión (bits 15,14,13)
  //   bytes 2-19: 3 grupos de 6 bytes. Grupo sin comprimir: x,y,z int16 LE.
  //               Grupo comprimido: 6 int8 = dos muestras como incrementos sobre la anterior.
  // Primera notificación: cabecera [0x8A, 0x0A, ...]. Fin: byte0 = 0x9A (si no toca la secuencia 154).
  const MASKS = [0x8000, 0x4000, 0x2000];
  const i8 = (b) => (b << 24) >> 24;
  const i16 = (v) => (v << 16) >> 16;

  class Decoder {
    constructor(maxSamples) {
      this.max = maxSamples || 3291;
      this.reset();
    }
    reset() {
      this.samples = [];
      this.last = [0, 0, 0];
      this.expectedSeq = null;
      this.header = null;
      this.declared = null;
      this.done = false;
      this.gaps = 0;
      this.packets = 0;
      this.endPacket = null;
    }
    static looksLikeEnd(b) {
      if (b[0] !== 0x9A) return false;
      for (let i = 2; i <= 4; i++) if (b[i] !== 0) return false;
      for (let i = 7; i < b.length; i++) if (b[i] !== 0) return false;
      return true;
    }
    push(bytesIn) {
      const b = bytesIn instanceof Uint8Array ? bytesIn : Uint8Array.from(bytesIn);
      if (this.done || b.length < 2) return 'ignored';
      if (this.header === null && this.packets === 0 && b[0] === 0x8A && b[1] === 0x0A) {
        this.header = Array.from(b);
        if (b.length >= 10) this.declared = (b[6] | (b[7] << 8) | (b[8] << 16) | (b[9] << 24)) >>> 0;
        return 'header';
      }
      if (b[0] === 0x9A && (this.expectedSeq !== 154 || Decoder.looksLikeEnd(b))) {
        this.done = true;
        this.endPacket = Array.from(b);
        return 'end';
      }
      if (b.length < 20) return 'ignored';
      const hdr = b[0] | (b[1] << 8);
      const seq = hdr & 0x1FFF;
      if (this.expectedSeq !== null && seq !== this.expectedSeq) this.gaps++;
      this.expectedSeq = (seq + 1) & 0x1FFF;
      this.packets++;
      for (let g = 0; g < 3; g++) {
        if (this.samples.length >= this.max) break;
        const off = 2 + 6 * g;
        if (hdr & MASKS[g]) {
          let [x, y, z] = this.last;
          x = i16(x + i8(b[off])); y = i16(y + i8(b[off + 1])); z = i16(z + i8(b[off + 2]));
          this.samples.push([x, y, z]);
          if (this.samples.length < this.max) {
            x = i16(x + i8(b[off + 3])); y = i16(y + i8(b[off + 4])); z = i16(z + i8(b[off + 5]));
            this.samples.push([x, y, z]);
          }
          this.last = [x, y, z];
        } else {
          const x = i16(b[off] | (b[off + 1] << 8));
          const y = i16(b[off + 2] | (b[off + 3] << 8));
          const z = i16(b[off + 4] | (b[off + 5] << 8));
          this.samples.push([x, y, z]);
          this.last = [x, y, z];
        }
      }
      return 'data';
    }
    result() {
      // El SDK oficial guarda como máximo 1097 muestras (índices 0..1096).
      const lim = this.declared && this.declared < 5000 ? this.declared + 1 : 1097;
      return this.samples.slice(0, lim);
    }
  }

  // ------------------------------------------------------------------ codificador (balón simulado / pruebas)
  function encodeType2(samples, opts) {
    const o = opts || {};
    const packets = [];
    const n = samples.length;
    packets.push(Uint8Array.from([0x8A, 0x0A, 0, 0, 0, 0, 0x48, 0x04, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
    const fits = (d) => d >= -128 && d <= 127;
    let i = 0, seq = o.firstSeq || 0, last = null;
    while (i < n) {
      const p = new Uint8Array(20);
      let flags = 0;
      for (let g = 0; g < 3; g++) {
        const off = 2 + 6 * g;
        if (i >= n) { // relleno: repite la última muestra sin comprimir
          const s = last || [0, 0, 0];
          for (let k = 0; k < 3; k++) { p[off + 2 * k] = s[k] & 255; p[off + 2 * k + 1] = (s[k] >> 8) & 255; }
          continue;
        }
        const a = samples[i], bb = samples[i + 1];
        let comp = false;
        if (last && bb && !(seq === (o.firstSeq || 0) && g === 0)) {
          const d = [a[0] - last[0], a[1] - last[1], a[2] - last[2], bb[0] - a[0], bb[1] - a[1], bb[2] - a[2]];
          if (d.every(fits)) {
            flags |= MASKS[g];
            for (let k = 0; k < 6; k++) p[off + k] = d[k] & 255;
            last = bb; i += 2; comp = true;
          }
        }
        if (!comp) {
          for (let k = 0; k < 3; k++) { p[off + 2 * k] = a[k] & 255; p[off + 2 * k + 1] = (a[k] >> 8) & 255; }
          last = a; i += 1;
        }
      }
      const hdr = (seq & 0x1FFF) | flags;
      p[0] = hdr & 255; p[1] = (hdr >> 8) & 255;
      packets.push(p);
      seq++;
    }
    packets.push(Uint8Array.from([0x9A, 0xC2, 0, 0, 0, 74, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
    return packets;
  }

  // ------------------------------------------------------------------ álgebra
  const V = {
    add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
    sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
    mul: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
    dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
    cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
    norm: (a) => Math.hypot(a[0], a[1], a[2]),
    unit: (a) => { const n = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / n, a[1] / n, a[2] / n]; },
    rot: (v, k, th) => { // Rodrigues, k unitario
      const c = Math.cos(th), s = Math.sin(th), kv = V.cross(k, v), kd = V.dot(k, v) * (1 - c);
      return [v[0] * c + kv[0] * s + k[0] * kd, v[1] * c + kv[1] * s + k[1] * kd, v[2] * c + kv[2] * s + k[2] * kd];
    },
    perp: (k) => { const a = Math.abs(k[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]; return V.unit(V.cross(k, a)); },
  };
  const M = {
    vec: (m, v) => [m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2], m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2], m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2]],
    tvec: (m, v) => [m[0][0] * v[0] + m[1][0] * v[1] + m[2][0] * v[2], m[0][1] * v[0] + m[1][1] * v[1] + m[2][1] * v[2], m[0][2] * v[0] + m[1][2] * v[1] + m[2][2] * v[2]],
    mul: (a, b) => a.map((r) => [0, 1, 2].map((j) => r[0] * b[0][j] + r[1] * b[1][j] + r[2] * b[2][j])),
    rot: (k, th) => { // matriz de rotación (Rodrigues)
      const c = Math.cos(th), s = Math.sin(th), t = 1 - c, [x, y, z] = k;
      return [[c + x * x * t, x * y * t - z * s, x * z * t + y * s], [y * x * t + z * s, c + y * y * t, y * z * t - x * s], [z * x * t - y * s, z * y * t + x * s, c + z * z * t]];
    },
  };

  function solveLinear(A, b) { // Gauss con pivoteo parcial; A n×n (se copia)
    const n = b.length, a = A.map((r) => r.slice()), x = b.slice();
    for (let c = 0; c < n; c++) {
      let p = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
      if (Math.abs(a[p][c]) < 1e-14) return null;
      [a[c], a[p]] = [a[p], a[c]]; [x[c], x[p]] = [x[p], x[c]];
      for (let r = c + 1; r < n; r++) {
        const f = a[r][c] / a[c][c];
        if (!f) continue;
        for (let k = c; k < n; k++) a[r][k] -= f * a[c][k];
        x[r] -= f * x[c];
      }
    }
    for (let r = n - 1; r >= 0; r--) {
      let s = x[r];
      for (let k = r + 1; k < n; k++) s -= a[r][k] * x[k];
      x[r] = s / a[r][r];
    }
    return x;
  }

  function symEigenvalues(A) { // Jacobi, matriz simétrica pequeña
    const n = A.length, a = A.map((r) => r.slice());
    for (let sweep = 0; sweep < 60; sweep++) {
      let off = 0;
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += a[i][j] * a[i][j];
      if (off < 1e-22) break;
      for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) {
        if (Math.abs(a[p][q]) < 1e-300) continue;
        const th = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1));
        const c = 1 / Math.sqrt(t * t + 1), s = t * c;
        for (let k = 0; k < n; k++) { const akp = a[k][p], akq = a[k][q]; a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq; }
        for (let k = 0; k < n; k++) { const apk = a[p][k], aqk = a[q][k]; a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk; }
      }
    }
    return a.map((r, i) => r[i]).sort((x, y) => x - y);
  }

  const median = (arr) => { const s = Float64Array.from(arr).sort(); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : NaN; };
  const mean = (arr) => arr.reduce((s, v) => s + v, 0) / (arr.length || 1);

  function lowpass(series, fs, fc) { // Butterworth 2º orden, ida y vuelta (fase cero)
    const w0 = 2 * Math.PI * fc / fs, cw = Math.cos(w0), al = Math.sin(w0) / (2 * Math.SQRT1_2);
    const a0 = 1 + al;
    const b0 = (1 - cw) / 2 / a0, b1 = (1 - cw) / a0, b2 = b0, a1 = -2 * cw / a0, a2 = (1 - al) / a0;
    const pass = (x) => {
      const y = new Float64Array(x.length);
      let x1 = x[0], x2 = x[0], y1 = x[0], y2 = x[0];
      for (let i = 0; i < x.length; i++) {
        const v = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
        x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
      }
      return y;
    };
    const f = pass(series);
    return pass(f.reverse()).reverse();
  }

  // ------------------------------------------------------------------ física del balón
  const PHYS = { g: 9.80665, rho: 1.2, R: 0.11, m: 0.43 };
  PHYS.A = Math.PI * PHYS.R * PHYS.R;
  // Coeficiente de arrastre con crisis de arrastre hacia 12 m/s (balón de 32 paneles).
  // Valores de túnel de viento y de análisis de trayectorias (Asai et al. 2007; Goff y Carré 2009-2010):
  // sin giro, Cd ≈ 0,45 por debajo de ~12 m/s y ≈ 0,21 por encima; el giro lo sube hasta ≈ 0,35 con S = 0,3.
  const cdModel = (v, S) => 0.21 + 0.24 / (1 + Math.exp((v - 12.5) / 1.3)) + Math.min(0.47 * Math.max(0, S || 0), 0.2);
  // Coeficiente de sustentación (Magnus) en función del parámetro de giro S = R·ω/v.
  const clModel = (S) => 0.33 * (1 - Math.exp(-Math.max(0, S) / 0.11));

  // ------------------------------------------------------------------ simulador
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function randomRotation(rng) {
    let q;
    do { q = [rng() * 2 - 1, rng() * 2 - 1, rng() * 2 - 1, rng() * 2 - 1]; } while (Math.hypot(...q) > 1 || Math.hypot(...q) < 0.1);
    const n = Math.hypot(...q); const [w, x, y, z] = q.map((v) => v / n);
    return [[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)], [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)], [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]];
  }

  /**
   * Simula el registro del balón para un chute.
   * Mundo: x = dirección del chute (horizontal), y = izquierda, z = arriba.
   * Giro: componentes {top (eje y, liftado > 0), side (eje z, rosca a la izquierda > 0), rifle (eje x)}.
   */
  function simulateKick(opts) {
    const o = opts || {};
    const rng = mulberry32(o.seed == null ? 1 : o.seed);
    const gauss = () => { let u = 0, v = 0; while (u === 0) u = rng(); while (v === 0) v = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
    const dt = o.dt || 0.001, N = o.n || N_SAMPLES, pre = o.pre == null ? 60 : o.pre;
    const cpg = o.countsPerG || 511, noise = o.noise == null ? 3 : o.noise;
    const v0 = o.speed == null ? 25 : o.speed, elevDeg = o.elevDeg == null ? 18 : o.elevDeg, elev = elevDeg * Math.PI / 180;
    const rpm = o.rpm == null ? 500 : o.rpm;
    const axW = V.unit([o.rifle || 0, o.top == null ? 1 : o.top, o.side || 0]);
    const wMag = rpm * 2 * Math.PI / 60, wW = V.mul(axW, wMag);
    const Tc = (o.contactMs || 9) / 1000;
    const R0 = o.R0 || randomRotation(rng);
    const off = o.sensorOffset || [0.0015 * gauss(), 0.0015 * gauss(), 0.0015 * gauss()];
    const { g, rho, R: Rb, m, A } = PHYS;
    const cdScale = o.cdScale || 1, clScale = o.clScale || 1;
    const ringDir = V.unit([gauss(), gauss(), gauss()]), ringA = o.ringG == null ? 3 : o.ringG, ringTau = 0.015, ringF = o.ringHz || 95;
    const vL = [v0 * Math.cos(elev), 0, v0 * Math.sin(elev)];
    const samples = [];
    let pos = [0, 0, Rb], vel = [0, 0, 0], landed = false, tLand = 0, launched = false;
    for (let i = 0; i < N; i++) {
      const t = (i - pre) * dt;
      let fW, Rm, wB = [0, 0, 0];
      if (t < 0) { Rm = R0; fW = [0, 0, g]; }
      else if (t < Tc) {
        Rm = M.mul(M.rot(axW, 0.5 * wMag * t * t / Tc), R0);
        const s = Math.sin(Math.PI * t / Tc);
        fW = V.add(V.mul(V.unit(vL), v0 * Math.PI / (2 * Tc) * s), [0, 0, g * (1 - t / Tc)]);
        wB = M.tvec(Rm, V.mul(wW, t / Tc));
      } else {
        Rm = M.mul(M.rot(axW, wMag * (t - Tc / 2)), R0);
        if (!launched) { vel = vL.slice(); launched = true; }
        const sp = V.norm(vel), S = Rb * wMag / Math.max(sp, 1);
        const k = rho * A / (2 * m);
        fW = V.add(V.mul(vel, -k * cdModel(sp, S) * cdScale * sp), V.mul(V.cross(axW, vel), k * clModel(S) * clScale * sp));
        if (!landed) {
          vel = V.add(vel, V.mul(V.add(fW, [0, 0, -g]), dt));
          pos = V.add(pos, V.mul(vel, dt));
          if (pos[2] < Rb && t > 0.05) { landed = true; tLand = t; }
        }
        if (landed) {
          const tl = t - tLand;
          fW = tl < 0.008 ? [0, 0, 40 * g * Math.sin(Math.PI * tl / 0.008)] : [0, 0, g];
        }
        wB = M.tvec(Rm, wW);
      }
      let aB = M.tvec(Rm, fW);
      aB = V.add(aB, V.cross(wB, V.cross(wB, off)));
      if (t >= Tc) {
        const tr = t - Tc;
        aB = V.add(aB, V.mul(ringDir, ringA * g * Math.exp(-tr / ringTau) * Math.sin(2 * Math.PI * ringF * tr)));
      }
      samples.push(aB.map((c) => Math.max(-2039, Math.min(2040, Math.round(c / g * cpg + noise * gauss())))));
    }
    return {
      samples, dt,
      truth: {
        speedKmh: v0 * 3.6, elevDeg, rpm,
        topRpm: rpm * axW[1], sideRpm: rpm * axW[2], rifleRpm: rpm * axW[0],
        axisAboveHorizontalDeg: Math.asin(Math.min(1, Math.abs(axW[2]))) * 180 / Math.PI,
        landedMs: landed ? Math.round(tLand * 1000) : null,
      },
    };
  }

  // ------------------------------------------------------------------ análisis
  function analyze(samples, dtIn, opts) {
    const o = opts || {};
    const dt = dtIn > 0 && dtIn < 0.05 ? dtIn : 0.001;
    const fs = 1 / dt;
    const N = samples.length;
    const res = { ok: false, n: N, dt, warnings: [] };
    if (N < 200) { res.reason = 'Muy pocos datos (' + N + ' muestras).'; return res; }
    const mag = samples.map((s) => Math.hypot(s[0], s[1], s[2]));
    // Escala provisional: el informe de la USC mide ≈511 cuentas por g (±4 g, 2 mg/LSB, 12 bits).
    // Si el balón empieza quieto, se toma la de las primeras muestras; así no dependo de ese valor.
    let CPG0 = 511;
    {
      const head = mag.slice(0, 20), med = median(head);
      const spread = Math.max(...head) - Math.min(...head);
      if (med > 300 && med < 20000 && spread < 0.15 * med) CPG0 = med;
    }
    let maxAbs = 0;
    for (const s of samples) maxAbs = Math.max(maxAbs, Math.abs(s[0]), Math.abs(s[1]), Math.abs(s[2]));
    const CLIP = maxAbs >= 1.8 * CPG0 ? 0.955 * maxAbs : Infinity; // nivel de saturación observado
    res.saturationCounts = maxAbs;
    const clipped = (i) => Math.abs(samples[i][0]) >= CLIP || Math.abs(samples[i][1]) >= CLIP || Math.abs(samples[i][2]) >= CLIP;

    // 1) golpeo
    let iImp = -1;
    for (let i = 0; i < N; i++) if (clipped(i) || mag[i] > 2.5 * CPG0) { iImp = i; break; }
    if (iImp < 0) {
      res.reason = 'No se ve un golpeo (máximo ' + (Math.max(...mag) / CPG0).toFixed(1) + ' g). Puede que se moviera al cogerlo.';
      return res;
    }
    res.iImp = iImp;

    // 2) reposo previo → escala (cuentas por g) y vertical
    let rest = null, cpg = CPG0;
    const r1 = iImp - 3, r0 = Math.max(0, iImp - 120);
    if (r1 - r0 >= 10) {
      const seg = samples.slice(r0, r1);
      rest = [0, 1, 2].map((k) => median(seg.map((s) => s[k])));
      const rn = V.norm(rest);
      const dev = Math.sqrt(mean(seg.map((s) => (s[0] - rest[0]) ** 2 + (s[1] - rest[1]) ** 2 + (s[2] - rest[2]) ** 2))) / (rn || 1);
      res.restNoiseG = dev;
      if (rn > 0.75 * CPG0 && rn < 1.3 * CPG0) cpg = rn;
      else { res.warnings.push('El reposo antes del golpeo no mide 1 g; uso la escala por defecto.'); rest = null; }
      if (dev > 0.06) res.warnings.push('El balón no estaba del todo quieto antes del golpeo.');
    } else {
      res.warnings.push('No hay datos de reposo antes del golpeo: no puedo orientar el eje respecto al suelo.');
    }
    res.countsPerG = cpg;
    const up = rest ? V.unit(rest) : null;
    const G = samples.map((s) => [s[0] / cpg, s[1] / cpg, s[2] / cpg]);
    const magG = mag.map((v) => v / cpg);

    // 3) duración del contacto = bloque saturado inicial
    let iCe = iImp, gap = 0;
    for (let i = iImp + 1; i < Math.min(N, iImp + Math.round(0.04 * fs)); i++) {
      if (clipped(i) || magG[i] > 3.6) { iCe = i; gap = 0; } else if (++gap > 2) break;
    }
    const TcSat = (iCe - iImp + 1) * dt;
    res.contactMs = Math.round(TcSat * 1000);
    const Tc = Math.max(0.006, Math.min(0.012, TcSat)); // para la fase del giro: contacto típico de 7 a 10 ms

    // 4) ventana de vuelo
    let iS = iCe + Math.round(0.05 * fs);
    const hp = (i) => V.norm(V.sub(G[i], G[Math.max(0, i - 3)]));
    for (let extra = 0; extra < 4 && iS + 40 < N; extra++) {
      const e1 = mean(Array.from({ length: 30 }, (_, k) => hp(iS + k)));
      const e2 = mean(Array.from({ length: Math.min(200, N - iS - 31) }, (_, k) => hp(iS + 30 + k)));
      if (e1 > 3 * e2 + 0.02) iS += Math.round(0.03 * fs); else break;
    }
    // Segundo impacto (suelo, red, portero…): salto brusco entre muestras consecutivas. En vuelo la señal
    // es suave (gira como mucho a ~15 Hz: cambia menos de 0,4 g por muestra); un golpe la rompe y satura.
    let iE = N - 6, second = false;
    for (let i = Math.max(iS, 1); i < N; i++) {
      const jerk = V.norm(V.sub(G[i], G[i - 1]));
      let nClip = 0;
      for (let k = 0; k < 3; k++) if (Math.abs(samples[i][k]) >= CLIP) nClip++;
      if (jerk > 1.0 || (nClip >= 2 && jerk > 0.4)) {
        iE = i - Math.round(0.012 * fs); second = true; res.secondImpactMs = Math.round((i - iImp) * dt * 1000); break;
      }
    }
    res.iS = iS; res.iE = iE; res.secondImpact = second;
    res.recordedMs = Math.round((N - iImp) * dt * 1000);
    res.flightMs = Math.round((iE - iS) * dt * 1000);
    if (iE - iS < Math.round(0.12 * fs)) {
      res.reason = 'Vuelo demasiado corto para analizarlo (' + Math.max(0, res.flightMs) + ' ms). El chute debe subir ≥1 m y recorrer ≥10 m sin tocar nada.';
      return res;
    }

    // 5) filtrado
    const p0 = Math.max(0, iS - 60), p1 = Math.min(N, iE + 60);
    const fc = o.fc || 30;
    const F = [0, 1, 2].map((k) => lowpass(Float64Array.from(G.slice(p0, p1), (s) => s[k]), fs, fc));
    const A = [];
    for (let i = iS; i <= iE; i++) A.push([F[0][i - p0], F[1][i - p0], F[2][i - p0]]);
    const n = A.length;
    // Con mucho giro, si el sensor no está justo en el centro, la aceleración centrípeta satura algún eje
    // (±4 g) durante parte de cada vuelta. Esas muestras, y sus vecinas (el filtro reparte el recorte), no
    // cumplen el modelo y se dejan fuera de todos los ajustes.
    const bad = new Uint8Array(n), halo = Math.round(0.014 * fs);
    for (let i = Math.max(0, iS - halo); i <= Math.min(N - 1, iE + halo); i++) {
      if (!clipped(i)) continue;
      for (let j = Math.max(iS, i - halo); j <= Math.min(iE, i + halo); j++) bad[j - iS] = 1;
    }
    let nBad = 0; for (let i = 0; i < n; i++) nBad += bad[i];
    res.saturatedFrac = nBad / n;
    if (nBad > 0.8 * n) { for (let i = 0; i < n; i++) bad[i] = 0; nBad = 0; res.warnings.push('El sensor está saturado casi todo el vuelo: el análisis es poco fiable.'); }
    else if (nBad > 0.05 * n) res.warnings.push('Con tanto giro el sensor se satura en parte de cada vuelta (' + Math.round(100 * nBad / n) + ' % del vuelo): uso solo el resto.');

    // 6) ajuste del giro: ȧ = a × ω − k  (k = c × ω, c = término centrípeto constante)
    const AtA = Array.from({ length: 6 }, () => new Array(6).fill(0)), Atb = new Array(6).fill(0);
    for (let i = 1; i < n - 1; i++) {
      if (bad[i]) continue;
      const ad = [0, 1, 2].map((k) => (A[i + 1][k] - A[i - 1][k]) / (2 * dt));
      const [x, y, z] = A[i];
      const rows = [[0, -z, y, -1, 0, 0], [z, 0, -x, 0, -1, 0], [-y, x, 0, 0, 0, -1]]; // a×ω − k
      for (let r = 0; r < 3; r++) for (let p = 0; p < 6; p++) {
        Atb[p] += rows[r][p] * ad[r];
        for (let q = 0; q < 6; q++) AtA[p][q] += rows[r][p] * rows[r][q];
      }
    }
    const ev = symEigenvalues(AtA);
    const cond = ev[0] / (ev[5] || 1);
    let sol = cond > 1e-7 ? solveLinear(AtA, Atb) : null;
    let w, c = [0, 0, 0], model = 6;
    if (sol) {
      w = sol.slice(0, 3);
      const k = sol.slice(3, 6), wn2 = V.dot(w, w);
      c = wn2 > 1e-6 ? V.mul(V.cross(w, k), 1 / wn2) : [0, 0, 0];
      // centrípeto admisible: el de un sensor a 12 mm del centro como mucho (ω²·r), nunca menos de 2,5 g
      const cMax = Math.max(2.5, Math.min(6, wn2 * 0.012 / PHYS.g));
      if (V.norm(c) > cMax) { sol = null; } // centrípeto absurdo → modelo simple
    }
    let ctr = c;   // centro de la circunferencia que describe el vector medido
    if (!sol) { // modelo de 3 parámetros sobre datos centrados
      model = 3;
      const Ag = A.filter((_, i) => !bad[i]);
      const mu = [0, 1, 2].map((k) => mean(Ag.map((s) => s[k])));
      ctr = mu;
      const B = Array.from({ length: 3 }, () => [0, 0, 0]), bb = [0, 0, 0];
      for (let i = 1; i < n - 1; i++) {
        if (bad[i]) continue;
        const ad = [0, 1, 2].map((k) => (A[i + 1][k] - A[i - 1][k]) / (2 * dt));
        const [x, y, z] = V.sub(A[i], mu);
        const rows = [[0, -z, y], [z, 0, -x], [-y, x, 0]];
        for (let r = 0; r < 3; r++) for (let p = 0; p < 3; p++) {
          bb[p] += rows[r][p] * ad[r];
          for (let q = 0; q < 3; q++) B[p][q] += rows[r][p] * rows[r][q];
        }
      }
      w = solveLinear(B, bb) || [0, 0, 0];
      c = [0, 0, 0];
    }
    res.model = model;
    let wn = V.norm(w);
    let s = wn > 1e-9 ? V.mul(w, 1 / wn) : [0, 0, 1];

    // 7) refinado de la velocidad angular con el ángulo del vector en el plano ⊥ eje
    const e1 = V.perp(s), e2 = V.cross(s, e1);
    // Solo con las muestras fiables; al saltar un hueco, el avance esperado (−ω·Δt) dice cuántas vueltas han pasado.
    const ang = [], tt = [], rad = [];
    let prev = null, prevI = 0, acc = 0;
    for (let i = 0; i < n; i++) {
      if (bad[i]) continue;
      const pv = V.sub(A[i], ctr);
      const u = V.dot(pv, e1), v = V.dot(pv, e2);
      rad.push(Math.hypot(u, v));
      const th = Math.atan2(v, u);
      if (prev !== null) {
        const exp = i - prevI > 1 ? -wn * (i - prevI) * dt : 0;
        let d = th - prev - exp; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
        acc += exp + d;
      } else acc = th;
      prev = th; prevI = i; ang.push(acc); tt.push(i * dt);
    }
    const nA = ang.length;
    const tm = mean(tt), am = mean(ang);
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < nA; i++) { sxy += (tt[i] - tm) * (ang[i] - am); sxx += (tt[i] - tm) ** 2; syy += (ang[i] - am) ** 2; }
    const slope = sxx > 0 ? sxy / sxx : 0;
    const r2 = syy > 0 ? (sxy * sxy) / (sxx * syy) : 0;
    const revs = nA ? Math.abs(ang[nA - 1] - ang[0]) / (2 * Math.PI) : 0;
    const radius = median(rad);
    res.fit = { cond, slope, r2, revs, radiusG: radius, lsRpm: wn * 60 / (2 * Math.PI) };
    let wRate = wn;
    if (r2 > 0.9 && revs > 0.4) wRate = Math.abs(slope);
    if (slope > 0 && revs > 0.4 && r2 > 0.9) { s = V.mul(s, -1); } // ȧ = a×ω ⇒ el vector gira en sentido negativo
    const rpm = wRate * 60 / (2 * Math.PI);
    res.rpm = rpm; res.rps = rpm / 60; res.axisBody = s;
    const lowSpin = rpm < 90 || revs < 0.35 || radius < 0.05;
    res.lowSpin = lowSpin;
    if (lowSpin || rpm < 150) c = [0, 0, 0]; // con poco giro el término centrípeto es despreciable y el ajuste no lo resuelve
    res.centripetalG = V.norm(c);
    res.spinConfidence = lowSpin ? 'baja' : (r2 > 0.98 && revs > 1 ? 'alta' : 'media');

    // 8) fuerza aerodinámica y velocidad estimada
    let nEarly = Math.min(n, Math.round(0.2 * fs));
    let fMags = [], fIdx = [];
    for (let i = 0; i < nEarly; i++) if (!bad[i]) { fMags.push(V.norm(V.sub(A[i], c))); fIdx.push(i); }
    if (fMags.length < 0.25 * nEarly) {   // demasiado saturado al principio: se amplía la ventana
      nEarly = Math.min(n, Math.round(0.4 * fs)); fMags = []; fIdx = [];
      for (let i = 0; i < nEarly; i++) if (!bad[i]) { fMags.push(V.norm(V.sub(A[i], c))); fIdx.push(i); }
    }
    if (!fMags.length) { for (let i = 0; i < nEarly; i++) { fMags.push(V.norm(V.sub(A[i], c))); fIdx.push(i); } }
    const aeroG = median(fMags);
    res.aeroG = aeroG;
    const { g, rho, R: Rb, m, A: Ab } = PHYS;
    const Fms2 = aeroG * g;
    let v = 25, Cd = 0.26, Cl = 0;
    for (let it = 0; it < 30; it++) {
      const S = lowSpin ? 0 : Rb * wRate / Math.max(v, 1);
      Cd = cdModel(v, S); Cl = clModel(S);
      v = Math.sqrt(2 * m * Fms2 / (rho * Ab * Math.hypot(Cd, Cl)));
    }
    const tMid = ((iS + mean(fIdx)) - iImp) * dt;
    const kD = rho * Ab * Cd / (2 * m);
    const inv = 1 / v - kD * tMid;
    const v0 = inv > 0 ? 1 / inv : v;
    res.speedMs = v0; res.speedKmh = v0 * 3.6;
    res.cd = Cd; res.cl = Cl;
    if (v0 > 45) res.warnings.push('La velocidad calculada no es creíble (ningún chute pasa de unos 150 km/h): no te fíes de la trayectoria de este chute.');
    if (res.saturatedFrac > 0.5 && res.spinConfidence === 'alta') res.spinConfidence = 'media';

    // 9) eje respecto al suelo
    if (up) {
      const cosT = V.dot(s, up);
      res.axisAboveHorizontalDeg = Math.asin(Math.min(1, Math.abs(cosT))) * 180 / Math.PI;
      res.sideRpm = rpm * cosT;               // > 0: gira antihorario visto desde arriba → curva a la izquierda
      res.horizRpm = rpm * Math.sqrt(Math.max(0, 1 - cosT * cosT));
      res.curve = Math.abs(res.sideRpm) < 30 ? 'recto' : (res.sideRpm > 0 ? 'izquierda' : 'derecha');
    }

    // 10) dirección de salida y componentes liftado / lateral / bala (estimación)
    if (up) {
      // Con poco giro se usa un ajuste sin término centrípeto (ȧ = a × ω) solo para deshacer el giro del vector.
      let axD = s, rateD = wRate, cD = c;
      if (lowSpin) {
        const B = Array.from({ length: 3 }, () => [0, 0, 0]), bb = [0, 0, 0];
        for (let i = 1; i < n - 1; i++) {
          if (bad[i]) continue;
          const ad = [0, 1, 2].map((k) => (A[i + 1][k] - A[i - 1][k]) / (2 * dt));
          const [x, y, z] = A[i];
          const rows = [[0, -z, y], [z, 0, -x], [-y, x, 0]];
          for (let r = 0; r < 3; r++) for (let p = 0; p < 3; p++) { bb[p] += rows[r][p] * ad[r]; for (let q = 0; q < 3; q++) B[p][q] += rows[r][p] * rows[r][q]; }
        }
        const wl = solveLinear(B, bb) || [0, 0, 0];
        rateD = Math.min(V.norm(wl), 12); axD = rateD > 1e-6 ? V.unit(wl) : s; cD = [0, 0, 0];
      }
      // Dirección de la velocidad en el marco del balón en reposo, a partir de la fuerza aerodinámica media
      // de las muestras [i0, i1) una vez deshecho el giro.
      const dirOf = (i0, i1, phiOffset, thOffset, thScale) => {
        let Fr = [0, 0, 0], sumMag = 0, anyGood = false;
        for (let i = i0; i < i1; i++) if (!bad[i]) { anyGood = true; break; }
        for (let i = i0; i < i1; i++) {
          if (anyGood && bad[i]) continue;
          const t = (iS + i - iImp) * dt;
          const Th = rateD * (t - Tc / 2) * (thScale == null ? 1 : thScale) + thOffset;
          const fr = V.rot(V.sub(A[i], cD), axD, Th);
          Fr = V.add(Fr, fr); sumMag += V.norm(fr);
        }
        const phi = (lowSpin ? 0 : Math.atan2(Cl, Cd)) + phiOffset;
        const Fpar = V.dot(Fr, axD);
        const Fper = V.sub(Fr, V.mul(axD, Fpar));
        const uDir = V.rot(V.unit(Fper), axD, -(Math.PI - phi));
        let al = -Fpar, be = V.norm(Fper) * Math.cos(phi);
        const nn = Math.hypot(al, be) || 1; al /= nn; be /= nn;
        return { vhat: V.add(V.mul(axD, al), V.mul(uDir, be)), steadiness: V.norm(Fr) / (sumMag || 1) };
      };
      const comp = (phiOffset, thOffset, thScale) => {
        // Dos tramos consecutivos y extrapolación lineal al instante de salida: la gravedad (y el efecto) van
        // girando la velocidad durante el vuelo y, sin esto, el ángulo de salida saldría sesgado a la baja.
        const nDir = Math.min(n, Math.round((lowSpin ? 0.15 : 0.25) * fs)), h1 = Math.floor(nDir / 2);
        const d1 = dirOf(0, h1, phiOffset, thOffset, thScale), d2 = dirOf(h1, nDir, phiOffset, thOffset, thScale);
        const t1 = (iS + h1 / 2 - iImp) * dt - Tc / 2, t2 = (iS + (h1 + nDir) / 2 - iImp) * dt - Tc / 2;
        const vhat = V.unit(V.sub(d1.vhat, V.mul(V.sub(d2.vhat, d1.vhat), t1 / (t2 - t1))));
        const steadiness = Math.min(d1.steadiness, d2.steadiness);
        const elev = Math.asin(Math.max(-1, Math.min(1, V.dot(vhat, up))));
        const h = V.unit(V.sub(vhat, V.mul(up, V.dot(vhat, up))));
        const left = V.cross(up, h);
        return { steadiness, vhat, elevDeg: elev * 180 / Math.PI, top: rpm * V.dot(s, left), side: rpm * V.dot(s, up), rifle: rpm * V.dot(s, h) };
      };
      const base = comp(0, 0);
      const variants = [];
      if (lowSpin) { for (const dp of [-0.15, 0, 0.15]) for (const sc of [0, 1, 2]) variants.push(comp(dp, 0, sc)); }
      else { for (const dp of [-0.17, 0, 0.17]) for (const dth of [-wRate * Tc / 4, 0, wRate * Tc / 4]) variants.push(comp(dp, dth)); }
      const elevs = variants.map((x) => x.elevDeg);
      res.elevDeg = base.elevDeg;
      res.elevRange = [Math.min(...elevs), Math.max(...elevs)];
      res.directionSteadiness = base.steadiness;
      res.variants = variants.map((x) => ({ elevDeg: x.elevDeg, top: lowSpin ? 0 : x.top, rifle: lowSpin ? 0 : x.rifle }));
      if (!lowSpin) {
        const tops = variants.map((x) => x.top);
        const signFlip = Math.min(...tops) < 0 && Math.max(...tops) > 0;
        res.topRpm = base.top; res.rifleRpm = base.rifle;
        res.topRange = [Math.min(...tops), Math.max(...tops)];
        res.topConfidence = signFlip || base.steadiness < 0.6 ? 'baja' : (Math.abs(base.top) > 0.5 * rpm && base.steadiness > 0.85 ? 'alta' : 'media');
      } else res.topConfidence = 'baja';
      res.elevConfidence = (res.elevRange[1] - res.elevRange[0]) > 22 || base.steadiness < 0.6 ? 'baja' : ((res.elevRange[1] - res.elevRange[0]) < 9 ? 'alta' : 'media');
      if (base.elevDeg < -15 || base.elevDeg > 70) {
        res.topConfidence = 'baja'; res.elevConfidence = 'baja';
        res.warnings.push('La dirección de salida estimada no es coherente; toma liftado/cortado y la trayectoria con cautela.');
      }
      res.launch = {
        speed: v0, elevDeg: base.elevDeg, lowSpin,
        top: lowSpin ? 0 : base.top, side: lowSpin ? 0 : res.sideRpm, rifle: lowSpin ? 0 : base.rifle,
      };
      res.dir = { vhat: base.vhat, s, up, tc: Tc };

      // 10b) Campo abierto: si el segundo impacto es el primer bote, el tiempo de vuelo fija el ángulo de salida
      // mucho mejor que la dirección de la fuerza (sobre todo en liftados y cortados).
      if (o.openField && res.secondImpactMs) {
        const Tfl = res.secondImpactMs / 1000 - Tc;
        const fit = fitLanding(res.launch, Tfl);
        if (fit != null && fit > res.elevRange[0] - 6 && fit < res.elevRange[1] + 6) {
          let e = fit;
          for (let pass = 0; pass < 3; pass++) {      // el reparto liftado/bala cambia el tiempo de vuelo: se repite
            setElevation(res, e, 'bote');
            const f2 = fitLanding(res.launch, Tfl);
            if (f2 == null || Math.abs(f2 - e) < 0.2) break;
            e = f2;
          }
          res.landFit = { flightS: Tfl };
        } else if (fit != null) {
          res.warnings.push('El segundo impacto no encaja con un bote en el suelo: no se usa para afinar la trayectoria.');
        }
      }
    }

    // 11) clasificación
    res.type = classify(res);
    res.ok = true;
    // series para dibujar (submuestreo)
    res.plot = { mag: magG.map((x) => Math.round(x * 100) / 100), iImp, iS, iE };
    return res;
  }

  function classify(r) {
    if (r.lowSpin || r.rpm < 90) return r.speedKmh >= 90 ? 'Sin giro' : 'Casi sin giro';
    const parts = [];
    const tot = r.rpm;
    if (r.topRpm != null && r.topConfidence !== 'baja') {
      if (r.topRpm > 0.35 * tot) parts.push('liftado');
      else if (r.topRpm < -0.35 * tot) parts.push('cortado');
    }
    if (r.sideRpm != null && Math.abs(r.sideRpm) > 0.35 * tot) parts.push('rosca a la ' + (r.sideRpm > 0 ? 'izquierda' : 'derecha'));
    if (r.rifleRpm != null && r.topConfidence !== 'baja' && Math.abs(r.rifleRpm) > 0.6 * tot) parts.push('giro en bala');
    if (!parts.length) return r.horizRpm > 0.7 * tot ? 'Eje horizontal: liftado o cortado' : 'Giro mixto';
    const s = parts.length === 1 ? parts[0] : parts[0] + ' con ' + parts.slice(1).join(' y ');
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  // Fija el ángulo de salida con un dato mejor (el bote o el vídeo) y recoloca el reparto liftado/bala:
  // se gira la dirección de salida alrededor del eje de giro hasta que tenga ese ángulo (corrige la fase).
  function setElevation(res, elevDeg, source) {
    if (!res || !res.launch) return res;
    const L = { ...res.launch, elevDeg };
    if (!res.lowSpin && res.dir) {
      const { vhat, s, up } = res.dir, rpm = res.rpm;
      let best = null;
      for (let dDeg = -75; dDeg <= 75; dDeg += 0.5) {
        const vh = V.rot(vhat, s, dDeg * Math.PI / 180);
        const el = Math.asin(Math.max(-1, Math.min(1, V.dot(vh, up)))) * 180 / Math.PI;
        if (Math.abs(el - elevDeg) < 0.6 && (!best || Math.abs(dDeg) < Math.abs(best.dDeg))) best = { dDeg, vh };
      }
      if (best) {
        const h = V.unit(V.sub(best.vh, V.mul(up, V.dot(best.vh, up)))), left = V.cross(up, h);
        L.top = rpm * V.dot(s, left); L.rifle = rpm * V.dot(s, h);
        res.topRpm = L.top; res.rifleRpm = L.rifle; res.phaseFixDeg = best.dDeg;
        if (res.topConfidence === 'baja' && Math.abs(L.top) > 0.25 * rpm) res.topConfidence = 'media';
      }
    }
    res.launch = L; res.elevDeg = elevDeg; res.elevSource = source;
    res.elevRange = [elevDeg - 2, elevDeg + 2]; res.elevConfidence = 'alta';
    res.variants = [-2, 2].map((d) => ({ elevDeg: elevDeg + d, top: L.top, rifle: L.rifle }));
    res.type = classify(res);
    return res;
  }
  // Ángulo de salida a partir de dos posiciones del balón en un vídeo lateral: la cuerda entre el golpeo y
  // dtS segundos después forma chordDeg con la horizontal; se busca la salida que la reproduce.
  function elevFromChord(launch, chordDeg, dtS) {
    const chord = (e) => { const tr = flight({ ...launch, elevDeg: e }, { tMax: dtS + 0.5 }); const q = flightAtT(tr, dtS); return Math.atan2(q.z - tr.Z[0], q.x) * 180 / Math.PI; };
    let lo = 1, hi = 75;
    if (!(dtS > 0.02) || chord(lo) > chordDeg) return Math.max(1, chordDeg);
    if (chord(hi) < chordDeg) return hi;
    for (let i = 0; i < 24; i++) { const mid = (lo + hi) / 2; if (chord(mid) < chordDeg) lo = mid; else hi = mid; }
    return (lo + hi) / 2;
  }

  // ------------------------------------------------------------------ trayectoria
  // Mundo: x hacia el objetivo (horizontal), y a la izquierda, z arriba. El balón sale del origen.
  // Giro en rpm: top (eje y; liftado > 0), side (eje z; curva a la izquierda > 0), rifle (eje x).
  function flight(launch, opts) {
    const o = opts || {};
    const dt = o.dt || 0.004, tMax = o.tMax || 8, xMax = o.xMax || 120;
    const { g, rho, R: Rb, m, A } = PHYS, k = rho * A / (2 * m);
    const cdS = o.cdScale || 1, clS = o.clScale == null ? 1 : o.clScale;
    const e = Math.max(1, Math.min(75, launch.elevDeg || 0)) * Math.PI / 180, v0 = Math.max(1, launch.speed || 0);
    const w = [launch.rifle || 0, launch.top || 0, launch.side || 0].map((x) => x * 2 * Math.PI / 60);
    const wMag = V.norm(w), sx = wMag > 1e-9 ? V.mul(w, 1 / wMag) : [0, 0, 0];
    const acc = (v) => {
      const sp = V.norm(v), S = Rb * wMag / Math.max(sp, 1);
      const a = V.add(V.mul(v, -k * cdModel(sp, S) * cdS * sp), V.mul(V.cross(sx, v), k * clModel(S) * clS * sp));
      a[2] -= g; return a;
    };
    let p = [0, 0, Rb], v = [v0 * Math.cos(e), 0, v0 * Math.sin(e)], t = 0;
    const T = [0], X = [0], Y = [0], Z = [Rb];
    let apex = { t: 0, x: 0, z: Rb }, land = null;
    while (t < tMax && p[0] < xMax) {
      const a1 = acc(v), vm = V.add(v, V.mul(a1, dt / 2)), a2 = acc(vm);   // punto medio
      const pn = V.add(p, V.mul(vm, dt)), vn = V.add(v, V.mul(a2, dt));
      if (pn[2] <= Rb && t > 0.02) {
        const f = (p[2] - Rb) / ((p[2] - pn[2]) || 1e-9);
        land = { t: t + f * dt, x: p[0] + f * (pn[0] - p[0]), y: p[1] + f * (pn[1] - p[1]), speed: V.norm(v) };
        T.push(land.t); X.push(land.x); Y.push(land.y); Z.push(Rb);
        break;
      }
      p = pn; v = vn; t += dt;
      T.push(t); X.push(p[0]); Y.push(p[1]); Z.push(p[2]);
      if (p[2] > apex.z) apex = { t, x: p[0], y: p[1], z: p[2] };
    }
    return { T, X, Y, Z, apex, land, launch };
  }
  const lerpAt = (arr, i, f) => arr[i - 1] + f * (arr[i] - arr[i - 1]);
  // Estado al cruzar la distancia x (null si bota antes).
  function flightAtX(tr, x) {
    if (!tr) return null;
    if (x <= 0) return { t: 0, x: 0, y: 0, z: tr.Z[0] };
    const X = tr.X;
    for (let i = 1; i < X.length; i++) if (X[i] >= x) { const f = (x - X[i - 1]) / ((X[i] - X[i - 1]) || 1e-9); return { t: lerpAt(tr.T, i, f), x, y: lerpAt(tr.Y, i, f), z: lerpAt(tr.Z, i, f) }; }
    return null;
  }
  // Posición en el instante t (se queda en el final si t es mayor).
  function flightAtT(tr, t) {
    const T = tr.T, n = T.length;
    if (t <= 0) return { t: 0, x: tr.X[0], y: tr.Y[0], z: tr.Z[0], done: false };
    if (t >= T[n - 1]) return { t: T[n - 1], x: tr.X[n - 1], y: tr.Y[n - 1], z: tr.Z[n - 1], done: true };
    let lo = 1, hi = n - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (T[mid] >= t) hi = mid; else lo = mid + 1; }
    const f = (t - T[lo - 1]) / ((T[lo] - T[lo - 1]) || 1e-9);
    return { t, x: lerpAt(tr.X, lo, f), y: lerpAt(tr.Y, lo, f), z: lerpAt(tr.Z, lo, f), done: false };
  }
  // Ángulo de salida con el que el primer bote llega a los T segundos (bisección); null si no hay solución.
  function fitLanding(launch, T, opts) {
    const landT = (e) => { const tr = flight({ ...launch, elevDeg: e }, { ...(opts || {}), tMax: T + 3 }); return tr.land ? tr.land.t : Infinity; };
    let lo = 1, hi = 60;
    if (!(T > 0.15) || landT(lo) > T || landT(hi) < T) return null;
    for (let i = 0; i < 24; i++) { const mid = (lo + hi) / 2; if (landT(mid) < T) lo = mid; else hi = mid; }
    return (lo + hi) / 2;
  }
  // Trayectoria del chute analizado, la misma sin efecto y las variantes para la banda de incertidumbre.
  function kickFlight(res, opts) {
    if (!res || !res.ok || !res.launch) return null;
    const L = res.launch, o = opts || {};
    const main = flight(L, o);
    const noSpin = flight({ speed: L.speed, elevDeg: L.elevDeg }, o);
    const alts = (res.variants || []).map((v) => flight({ speed: L.speed, elevDeg: v.elevDeg, top: v.top, side: L.side, rifle: v.rifle }, o));
    for (const f of [0.92, 1.08]) {
      let e = L.elevDeg;
      if (res.landFit) { const fe = fitLanding({ ...L, speed: L.speed * f }, res.landFit.flightS, o); if (fe != null) e = fe; }
      alts.push(flight({ speed: L.speed * f, elevDeg: e, top: L.top, side: L.side, rifle: L.rifle }, o));
    }
    return { main, noSpin, alts };
  }
  // Altura mínima y máxima de las variantes al cruzar x (0 = ya ha botado).
  function bandAtX(fl, x) {
    let lo = Infinity, hi = -Infinity;
    for (const tr of [fl.main].concat(fl.alts)) { const q = flightAtX(tr, x); const z = q ? q.z : 0; if (z < lo) lo = z; if (z > hi) hi = z; }
    return [lo, hi];
  }
  // Lo que cambia el giro respecto al mismo chute sin efecto, a la distancia x (o donde bote el primero).
  function spinEffect(fl, x) {
    const xe = Math.min(x, fl.main.land ? fl.main.land.x : x, fl.noSpin.land ? fl.noSpin.land.x : x);
    const a = flightAtX(fl.main, xe), b = flightAtX(fl.noSpin, xe);
    if (!a || !b) return null;
    return { x: xe, dz: a.z - b.z, dy: a.y - b.y, dt: a.t - b.t };
  }
  // Punto de golpeo: por dónde pasa la línea del impulso respecto al centro, visto desde detrás del tiro.
  // I·ω = r × m·v, con I = (2/3)·m·R² (esfera hueca).  Devuelve metros: up (+ arriba), right (+ derecha).
  function strikePoint(launch) {
    if (!launch || !launch.speed) return null;
    const k = (2 / 3) * PHYS.R * PHYS.R, e = (launch.elevDeg || 0) * Math.PI / 180, toRad = 2 * Math.PI / 60;
    const wx = (launch.rifle || 0) * toRad, wy = (launch.top || 0) * toRad, wz = (launch.side || 0) * toRad;
    const up = k * wy / launch.speed, right = k * (Math.cos(e) * wz - Math.sin(e) * wx) / launch.speed;
    return { up, right, r: Math.hypot(up, right) };
  }

  // ------------------------------------------------------------------ utilidades de datos
  function samplesToB64(samples) {
    const a = new Int16Array(samples.length * 3);
    samples.forEach((s, i) => { a[3 * i] = s[0]; a[3 * i + 1] = s[1]; a[3 * i + 2] = s[2]; });
    const u = new Uint8Array(a.buffer);
    let bin = '';
    for (let i = 0; i < u.length; i++) bin += String.fromCharCode(u[i]);
    return typeof btoa === 'function' ? btoa(bin) : Buffer.from(u).toString('base64');
  }
  function b64ToSamples(b64) {
    const bin = typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString('binary');
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    const a = new Int16Array(u.buffer);
    const out = [];
    for (let i = 0; i + 2 < a.length; i += 3) out.push([a[i], a[i + 1], a[i + 2]]);
    return out;
  }

  return {
    UUID16, CMD, samplePeriodCommand, STATUS_BITS, describeStatus, N_SAMPLES, KICK_PROGRESS_THRESHOLD,
    Decoder, encodeType2, simulateKick, analyze, classify, PHYS, cdModel, clModel, V, toHex,
    flight, flightAtX, flightAtT, kickFlight, bandAtX, spinEffect, strikePoint, fitLanding, setElevation, elevFromChord,
    samplesToB64, b64ToSamples, mulberry32,
  };
});
