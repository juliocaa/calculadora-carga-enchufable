// Prueba de extremo a extremo en jsdom: (1) modo demostración, (2) ruta Bluetooth real con un
// balón falso a nivel GATT (Web Bluetooth simulado) que sigue el protocolo del SDK oficial.
const path = require('path');
const fs = require('fs');
const { JSDOM, VirtualConsole } = require('jsdom');   // npm install jsdom (o NODE_PATH apuntando a donde esté)
const SB = require('../src/sbcore.js');
const html = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeFakeBluetooth(window, opts) {
  const o = opts || {};
  const ET = window.EventTarget, Ev = window.Event;
  const log = [];
  const ball = { state: 'idle', pct: 0, timers: [], kick: null, truth: null };
  const later = (ms, fn) => ball.timers.push(setTimeout(fn, ms));
  const clear = () => { ball.timers.forEach(clearTimeout); ball.timers = []; };
  const chars = {};
  function mkChar(uuid, props, initial) {
    const c = new ET();
    c.uuid = uuid; c.properties = Object.assign({ read: false, write: false, writeWithoutResponse: false, notify: false, indicate: false }, props);
    c.value = new window.DataView(Uint8Array.from(initial || [0]).buffer);
    c.notifying = false;
    c.readValue = async () => { await sleep(5); if (!device.gatt.connected) throw new Error('GATT Server is disconnected.'); if (uuid === 0xAD33) c.value = new window.DataView(Uint8Array.from([Math.min(100, Math.round(ball.pct))]).buffer); return c.value; };
    c.startNotifications = async () => { await sleep(3); c.notifying = true; return c; };
    c.writeValueWithResponse = async (data) => { await sleep(5); if (!device.gatt.connected) throw new Error('GATT Server is disconnected.'); onWrite(uuid, Uint8Array.from(data)); };
    c.writeValue = c.writeValueWithResponse;
    c.emit = (arr) => { if (!c.notifying || !device.gatt.connected) return; c.value = new window.DataView(Uint8Array.from(arr).buffer); c.dispatchEvent(new Ev('characteristicvaluechanged')); };
    chars[uuid] = c;
    return c;
  }
  mkChar(0xAD14, { read: true, notify: true }, [0]);
  mkChar(0xAD15, { write: true }, [0]);
  mkChar(0xAD17, { notify: true }, [0]);
  mkChar(0xAD1F, { read: true }, [0x10, 0]);
  mkChar(0xAD20, { read: true, notify: true }, [1, 0]);
  if (!o.noProgress) mkChar(0xAD33, { read: true }, [0]);
  mkChar(0xADFE, { read: true, notify: true }, [0]);
  mkChar(0xAD12, { read: true, notify: true }, [0]);
  const batt = mkChar(0x2A19, { read: true }, [77]);
  const fw = mkChar(0x2A26, { read: true }, Array.from(Buffer.from('3.5')));
  function onWrite(uuid, d) {
    log.push(Array.from(d));
    if (uuid !== 0xAD15) return;
    const c = d[0];
    if (c === 6) { clear(); ball.state = 'idle'; ball.pct = 0; later(20, () => chars[0xADFE].emit([250])); }
    else if (c === 3) {
      clear(); ball.state = 'logging'; ball.pct = 0; ball.armCount = (ball.armCount || 0) + 1;
      if (o.zeroAtArm) later(10, () => chars[0xAD14].emit([0]));
      later(300, () => {
        ball.state = 'ready'; chars[0xAD14].emit([1]);
        if (o.moveBeforeKick && ball.armCount === 1) { later(200, () => { ball.state = 'idle'; chars[0xAD14].emit([0]); }); return; }
        later(600, () => doKick());
      });
    } else if (c === 4) { ball.state = 'stopped'; }
    else if (c === 10) {
      if (o.dropAfterKick && !ball.dropped) { ball.dropped = true; later(30, () => device.gatt.disconnect()); return; }
      const pk = SB.encodeType2(ball.kick);
      let i = 0;
      const send = () => { for (let j = 0; j < 5 && i < pk.length; j++, i++) chars[0xAD17].emit(pk[i]); if (i < pk.length) later(5, send); };
      later(20, send);
    }
  }
  function doKick() {
    if (ball.state !== 'ready') return;
    ball.state = 'recording';
    if (o.vanishAtKick && !ball.vanished) { ball.vanished = true; setTimeout(() => device.gatt.disconnect(), 40); }
    if (o.zeroAtKick || o.noProgress) later(5, () => chars[0xAD14].emit([0]));
    const sim = SB.simulateKick({ seed: 42, speed: 24, rpm: 520, top: -0.5, side: 0.85, rifle: 0.15, elevDeg: 18 });
    ball.kick = sim.samples; ball.truth = sim.truth;
    const t0 = Date.now();
    const step = () => { ball.pct = Math.min(100, (Date.now() - t0) / 11); if (ball.pct < 100) setTimeout(step, 15); };
    step();
  }
  const services = {
    0xAD04: { getCharacteristic: async (u) => { if (!chars[u]) throw new Error('NotFoundError'); return chars[u]; } },
    0x180F: { getCharacteristic: async (u) => { if (u !== 0x2A19) throw new Error('NotFoundError'); return batt; } },
    0x180A: { getCharacteristic: async (u) => { if (u === 0x2A26) return fw; throw new Error('NotFoundError'); } },
  };
  const server = { getPrimaryService: async (u) => { if (!services[u]) throw new Error('NotFoundError'); return services[u]; } };
  const device = new ET();
  device.name = 'DB00321654'; device.id = 'fake-id';
  device.gatt = {
    connected: false,
    connect: async () => { await sleep(20); device.gatt.connected = true; return server; },
    disconnect: () => { if (!device.gatt.connected) return; device.gatt.connected = false; Object.values(chars).forEach((c) => { c.notifying = false; }); device.dispatchEvent(new Ev('gattserverdisconnected')); },
  };
  return { bluetooth: { requestDevice: async () => device, getAvailability: async () => true }, ball, log, device };
}

async function boot(withBle, bleOpts) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => { if (!/Not implemented: (HTMLCanvasElement|HTMLMediaElement|window\.scrollTo)/.test(e.message)) errors.push('jsdom: ' + e.message); });
  vc.on('error', (e) => errors.push('console.error: ' + e));
  let fake = null;
  const dom = new JSDOM(html, {
    url: 'https://juliocaa.github.io/smartball/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(window) {
      window.isSecureContext = true;
      if (withBle) { fake = makeFakeBluetooth(window, bleOpts); Object.defineProperty(window.navigator, 'bluetooth', { value: fake.bluetooth, configurable: true }); }
      window.TextEncoder = TextEncoder; window.TextDecoder = TextDecoder;
    },
  });
  await sleep(200);
  const w = dom.window, d = w.document, app = w.SmartBallApp;
  const main = (act) => { const b = d.querySelector('#btnMain'); if (b.dataset.act !== act) throw new Error(`el botón principal es «${b.textContent}» (${b.dataset.act}), esperaba ${act}`); b.click(); };
  const alt = (act) => { const b = d.querySelector('#btnAlt'); if (b.hidden || b.dataset.act !== act) throw new Error(`el botón secundario es «${b.textContent}» (${b.dataset.act}), esperaba ${act}`); b.click(); };
  return { dom, w, d, errors, fake, app, main, alt };
}
const txt = (d, s) => d.querySelector(s).textContent.trim();
async function waitFor(fn, ms, label) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(50); } throw new Error('Timeout esperando: ' + label); }
const summary = (d) => `${txt(d, '#resType')} | ${txt(d, '#nSpeed')} km/h, ${txt(d, '#nSpin')} rpm | ${[...d.querySelectorAll('#split dt')].map((dt) => dt.textContent + ' ' + dt.nextElementSibling.textContent.trim()).join(' · ')}`;


(async () => {
  const N = +process.argv[2] || 12, variant = process.argv[3] || 'vanishAtKick';
  let bad = 0;
  for (let i = 0; i < N; i++) {
    const { w, d, errors, fake, app, main } = await boot(true, { [variant]: true });
    main('connect');
    await waitFor(() => app.S.state === 'idle', 3000, 'conectado');
    main('arm');
    let ok = true;
    try { await waitFor(() => app.S.state === 'idle' && app.S.current, 22000, 'resultado'); } catch (e) { ok = false; }
    if (!ok || errors.length) {
      bad++;
      console.log(`--- intento ${i + 1}: ${ok ? 'errores' : 'ATASCADO'} en estado ${app.S.state}; conectado ${fake.device.gatt.connected}; comandos ${JSON.stringify(fake.log.map((c) => c[0]))}; pct ${fake.ball.pct}`);
      console.log('errores:', errors.join(' | '));
      console.log(d.querySelector('#log').textContent.split('\n').slice(-45).join('\n'));
    } else console.log(`intento ${i + 1}: ok, comandos ${JSON.stringify(fake.log.map((c) => c[0]))}`);
    w.close();
  }
  console.log(bad ? `\n${bad} de ${N} MAL` : `\nlos ${N} bien`);
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error('EXCEPCIÓN', e); process.exit(2); });
