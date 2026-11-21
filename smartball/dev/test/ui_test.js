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
  let fails = 0;
  const check = (c, m) => { if (!c) { fails++; console.log('  FALLO:', m); } else console.log('  ok:', m); };

  console.log('== 1) Modo demostración');
  {
    const { w, d, errors, app, main, alt } = await boot(false);
    check(!d.querySelector('#support').hidden, 'aviso de navegador sin Bluetooth visible');
    check(txt(d, '#statusText') === 'Conecta el balón' && !d.querySelector('#banner').hidden, 'cartel inicial');
    alt('demo');
    await waitFor(() => app.S.state === 'idle', 3000, 'conectado demo');
    check(txt(d, '#btnMain') === 'Preparar chute', 'botón Preparar chute');
    check(/Demostración, batería 86 %/.test(txt(d, '#conn')), 'cabecera: ' + txt(d, '#conn'));
    for (let k = 0; k < 6; k++) {
      main('arm');
      await waitFor(() => app.S.state === 'ready', 4000, 'listo');
      if (k === 0) check(txt(d, '#statusText') === '¡Chuta!' && d.querySelector('#banner').className.includes('go'), 'cartel ¡Chuta!');
      await waitFor(() => app.S.state === 'downloading', 7000, 'descargando');
      await waitFor(() => app.S.state === 'idle' && app.S.current, 15000, 'fin de descarga');
      console.log('   chute', k + 1, '→', summary(d));
      console.log('      ', txt(d, '#resReading'));
      console.log('      ', [...d.querySelectorAll('#fkFacts li')].map((li) => li.firstChild.textContent).join(' / '));
      const truth = d.querySelector('#resNotes .truth'); console.log('      ', truth ? truth.textContent : '(sin verdad)');
      const { kick, res } = app.current();
      if (k === 0) {
        check(d.querySelector('#banner').hidden && !d.querySelector('#views').hidden, 'con resultado: cartel oculto y vistas visibles');
        check(d.querySelectorAll('#flightFacts li').length === 3, 'tres datos de vuelo');
      }
      if (res.secondImpactMs != null && !kick.openField && !d.querySelector('#landAsk').hidden) {
        const before = res.elevDeg;
        d.querySelector('#landAsk [data-land="1"]').click();
        const r2 = app.current().res;
        console.log(`       bote: ángulo ${before.toFixed(1)}° → ${r2.elevDeg.toFixed(1)}° (real ${kick.truth.elevDeg.toFixed(1)}°), fuente ${r2.elevSource}`);
        if (r2.landFit) check(Math.abs(r2.elevDeg - kick.truth.elevDeg) < 3, 'ángulo afinado con el bote a menos de 3° del real');
      }
    }
    check(d.querySelectorAll('#history li[data-id]').length === 6, 'historial con 6 chutes');
    const kicks = app.kicks();
    check(kicks.every((k) => k.raw && k.res && k.res.ok), 'chutes guardados con datos crudos y análisis');
    // cambiar distancia y vista
    d.querySelector('#distSeg [data-d="25"]').click();
    check(app.settings.goalDist === 25 && app.scene.goalDist === 25 && /25 m/.test(txt(d, '#fkFacts')), 'cambio de distancia a 25 m');
    d.querySelector('#views [data-view="side"]').click();
    check(app.scene.view === 'side', 'vista lateral');
    // abrir otro chute del historial, favorito y borrar
    d.querySelectorAll('#history li[data-id]')[3].click();
    check(app.S.current === kicks[3].id, 'abrir un chute del historial');
    d.querySelector('#history [data-fav]').click();
    check(app.kicks()[0].fav === true, 'marcar favorito');
    d.querySelector('#history [data-del]').click();
    await sleep(50);
    check(d.querySelectorAll('#history li[data-id]').length === 5, 'borrar un chute');
    check(d.querySelector('#marks').hidden, 'sin marcas con chutes simulados');
    check(errors.length === 0, 'sin errores JS (' + errors.join(' | ') + ')');
    w.close();
  }

  console.log('== 2) Ruta Bluetooth (Web Bluetooth simulado a nivel GATT)');
  {
    const { w, d, errors, fake, app, main } = await boot(true);
    check(d.querySelector('#support').hidden, 'sin aviso de soporte');
    main('connect');
    await waitFor(() => app.S.state === 'idle', 3000, 'conectado BLE');
    check(/DB00321654, batería 77 %, en la base/.test(txt(d, '#conn')), 'cabecera: ' + txt(d, '#conn'));
    main('arm');
    await waitFor(() => app.S.state === 'ready', 3000, 'listo BLE');
    await waitFor(() => app.S.state === 'idle' && app.S.current, 15000, 'resultado BLE');
    const cmds = fake.log.map((c) => c[0]);
    console.log('   comandos enviados:', JSON.stringify(cmds));
    check(JSON.stringify(cmds.slice(0, 4)) === JSON.stringify([6, 3, 4, 10]), 'secuencia reset→logging→stop→descarga');
    check(JSON.stringify(fake.log[3]) === JSON.stringify([10, 0, 0, 0, 0, 72, 4, 0, 0, 2, 0, 0, 0, 0]), 'comando de descarga idéntico al SDK');
    console.log('   resultado:', summary(d));
    console.log('   real: 86 km/h, 520 rpm, liftado -261, rosca +443, bala +78');
    check(!d.querySelector('#marks').hidden && /km\/h/.test(txt(d, '#marks')), 'marcas visibles con un chute real');
    check(errors.length === 0, 'sin errores JS (' + errors.join(' | ') + ')');
    w.close();
  }

  console.log('== 3) Corte de conexión durante la descarga y reconexión automática');
  {
    const { w, d, errors, app, main } = await boot(true, { dropAfterKick: true });
    main('connect');
    await waitFor(() => app.S.state === 'idle', 3000, 'conectado');
    main('arm');
    await waitFor(() => app.S.state === 'needReconnect' || app.S.state === 'downloading', 6000, 'corte o descarga');
    await waitFor(() => app.S.state === 'idle' && app.S.current, 20000, 'reconexión y descarga');
    check(d.querySelectorAll('#history li[data-id]').length === 1, 'chute recuperado tras reconectar');
    check(errors.length === 0, 'sin errores JS (' + errors.join(' | ') + ')');
    w.close();
  }

  for (const [name, opts] of [['0 al armar', { zeroAtArm: true }], ['0 en el chute', { zeroAtKick: true }], ['0 al armar y en el chute', { zeroAtArm: true, zeroAtKick: true }], ['sin AD33 (chute por AD14)', { noProgress: true }], ['se mueve antes del chute', { moveBeforeKick: true }], ['sale de alcance al chutar, sin aviso', { vanishAtKick: true }]]) {
    console.log('== 4) Variante del balón: ' + name);
    const { w, d, errors, fake, app, main } = await boot(true, opts);
    main('connect');
    await waitFor(() => app.S.state === 'idle', 3000, 'conectado');
    main('arm');
    await waitFor(() => app.S.state === 'idle' && app.S.current, 25000, 'resultado (' + name + ')');
    const cmds = fake.log.map((c) => c[0]);
    console.log('   comandos:', JSON.stringify(cmds), '→', txt(d, '#resType'));
    const starts = cmds.filter((c) => c === 3).length;
    check(starts === (opts.moveBeforeKick ? 2 : 1), 'número de «empezar registro» = ' + starts);
    check(/rosca a la izquierda/i.test(txt(d, '#resType')), 'chute analizado');
    check(errors.length === 0, 'sin errores JS (' + errors.join(' | ') + ')');
    w.close();
  }
  console.log(fails ? `\n${fails} FALLOS` : '\nTODO OK');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('EXCEPCIÓN', e); process.exit(2); });
