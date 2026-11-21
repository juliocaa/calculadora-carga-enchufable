// Pruebas del núcleo: codificar/decodificar y analizar chutes simulados.
const SB = require('../src/sbcore.js');
let fails = 0;
const check = (cond, msg) => { if (!cond) { fails++; console.log('  FALLO:', msg); } };

// 1) ida y vuelta del formato tipo 2
{
  const sim = SB.simulateKick({ seed: 7 });
  const pk = SB.encodeType2(sim.samples);
  const d = new SB.Decoder();
  const kinds = pk.map((p) => d.push(p));
  const out = d.result();
  check(kinds[0] === 'header', 'cabecera');
  check(kinds[kinds.length - 1] === 'end', 'fin');
  check(out.length === sim.samples.length, 'longitud ' + out.length + ' vs ' + sim.samples.length);
  let maxErr = 0;
  out.forEach((s, i) => s.forEach((v, k) => { maxErr = Math.max(maxErr, Math.abs(v - sim.samples[i][k])); }));
  check(maxErr === 0, 'muestras idénticas (err ' + maxErr + ')');
  const comp = pk.slice(1, -1).filter((p) => (p[1] & 0xE0) !== 0).length;
  console.log(`codec: ${pk.length} paquetes, ${comp} con grupos comprimidos, ${d.gaps} saltos, err=${maxErr}`);
}

// 1b) el ejemplo de línea tipo 2 del informe de la USC
{
  const d = new SB.Decoder();
  d.push([0x8A, 10, 0, 0, 0, 0, 72, 4, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  d.last = [100, 200, 300];
  d.push([1, -32 & 255, 1, 2, -3 & 255, -3 & 255, -4 & 255, 1, -3 & 255, 0, 1, -1 & 255, -1 & 255, 0, -1 & 255, -2 & 255, 1, 3, 0, 0]);
  console.log('línea ejemplo USC →', JSON.stringify(d.samples));
  check(d.samples.length === 6, 'tres grupos comprimidos = 6 muestras');
  check(JSON.stringify(d.samples[0]) === JSON.stringify([101, 202, 297]), 'primera muestra delta');
}

// 2) análisis de chutes simulados
const cases = [
  { name: 'liftado puro 25 m/s 500 rpm', o: { speed: 25, rpm: 500, top: 1, side: 0, rifle: 0, elevDeg: 15 } },
  { name: 'cortado 22 m/s 400 rpm', o: { speed: 22, rpm: 400, top: -1, side: 0, rifle: 0, elevDeg: 22 } },
  { name: 'rosca izq 24 m/s 600 rpm', o: { speed: 24, rpm: 600, top: 0, side: 1, rifle: 0, elevDeg: 16 } },
  { name: 'rosca der + liftado 26 m/s 550 rpm', o: { speed: 26, rpm: 550, top: 0.7, side: -0.7, rifle: 0, elevDeg: 14 } },
  { name: 'interior típico (rosca izq + cortado) 23 m/s', o: { speed: 23, rpm: 520, top: -0.5, side: 0.85, rifle: 0.15, elevDeg: 18 } },
  { name: 'knuckle 31 m/s 30 rpm', o: { speed: 31, rpm: 30, top: 0.3, side: 0.2, rifle: 1, elevDeg: 10 } },
  { name: 'liftado fuerte 28 m/s 800 rpm', o: { speed: 28, rpm: 800, top: 1, side: 0.15, rifle: 0, elevDeg: 12 } },
  { name: 'pase suave 14 m/s 250 rpm cortado', o: { speed: 14, rpm: 250, top: -1, side: 0.2, rifle: 0, elevDeg: 30 } },
];
const rows = [];
for (const c of cases) {
  for (let seed = 1; seed <= 6; seed++) {
    const sim = SB.simulateKick({ seed: seed * 101 + 3, ...c.o, cdScale: 0.9 + 0.2 * (seed % 3) / 2, clScale: 0.85 + 0.3 * (seed % 2) });
    // pasar por el códec, como en la app
    const d = new SB.Decoder();
    SB.encodeType2(sim.samples).forEach((p) => d.push(p));
    const r = SB.analyze(d.result(), 0.001);
    const rOpen = SB.analyze(d.result(), 0.001, { openField: true });
    const t = sim.truth;
    if (!r.ok) { console.log(`${c.name} s${seed}: NO OK → ${r.reason}`); fails++; continue; }
    const scales = { cdScale: 0.9 + 0.2 * (seed % 3) / 2, clScale: 0.85 + 0.3 * (seed % 2) };
    const truthFl = SB.flight({ speed: t.speedKmh / 3.6, elevDeg: t.elevDeg, top: t.topRpm, side: t.sideRpm, rifle: t.rifleRpm }, scales);
    const truthNo = SB.flight({ speed: t.speedKmh / 3.6, elevDeg: t.elevDeg }, scales);
    const fl = SB.kickFlight(r);
    rows.push({ c: c.name, seed, t, r, truthFl, truthNo, fl, rOpen, flOpen: SB.kickFlight(rOpen) });
  }
}
const f = (x, d = 0) => (x == null ? '—' : x.toFixed(d));
console.log('\ncaso | rpm real/est | vel real/est km/h | eje sobre horiz real/est | lateral real/est | liftado real/est (conf) | elev real/est | tipo');
for (const { c, seed, t, r } of rows) {
  console.log(`${c} s${seed} | ${f(t.rpm)}/${f(r.rpm)} | ${f(t.speedKmh)}/${f(r.speedKmh)} | ${f(t.axisAboveHorizontalDeg)}/${f(r.axisAboveHorizontalDeg)} | ${f(t.sideRpm)}/${f(r.sideRpm)} | ${f(t.topRpm)}/${f(r.topRpm)} (${r.topConfidence || '-'}) | ${f(t.elevDeg)}/${f(r.elevDeg)} | ${r.type}`);
}
// métricas agregadas
const spinRows = rows.filter((x) => x.t.rpm >= 150);
const rpmErr = spinRows.map((x) => Math.abs(x.r.rpm - x.t.rpm) / x.t.rpm * 100);
const tiltErr = spinRows.map((x) => Math.abs(x.r.axisAboveHorizontalDeg - x.t.axisAboveHorizontalDeg));
const sideSign = spinRows.filter((x) => Math.abs(x.t.sideRpm) > 0.3 * x.t.rpm).map((x) => Math.sign(x.r.sideRpm) === Math.sign(x.t.sideRpm));
const topSign = spinRows.filter((x) => Math.abs(x.t.topRpm) > 0.3 * x.t.rpm && x.r.topConfidence !== 'baja').map((x) => Math.sign(x.r.topRpm) === Math.sign(x.t.topRpm));
const spdErr = rows.map((x) => (x.r.speedKmh - x.t.speedKmh) / x.t.speedKmh * 100);
const q = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
console.log(`\nrpm: error mediano ${q(rpmErr, 0.5).toFixed(1)} %, p90 ${q(rpmErr, 0.9).toFixed(1)} %`);
console.log(`eje sobre horizontal: error mediano ${q(tiltErr, 0.5).toFixed(1)}°, p90 ${q(tiltErr, 0.9).toFixed(1)}°`);
console.log(`sentido lateral correcto: ${sideSign.filter(Boolean).length}/${sideSign.length}`);
console.log(`liftado/cortado correcto (confianza media/alta): ${topSign.filter(Boolean).length}/${topSign.length}`);
console.log(`velocidad: error mediano ${q(spdErr.map(Math.abs), 0.5).toFixed(1)} %, rango ${Math.min(...spdErr).toFixed(1)}…${Math.max(...spdErr).toFixed(1)} %`);
// trayectoria: efecto del giro (robusto) y altura (depende del ángulo de salida)
{
  const D = 18;
  const eff = [], hgt = [], cover = [], lat = [], strike = [];
  for (const x of rows) {
    if (!x.fl) { fails++; console.log('  FALLO: sin trayectoria en', x.c); continue; }
    const xe = Math.min(D, x.truthFl.land ? x.truthFl.land.x : D, x.truthNo.land ? x.truthNo.land.x : D, x.fl.main.land ? x.fl.main.land.x : D, x.fl.noSpin.land ? x.fl.noSpin.land.x : D) - 0.01;
    const tA = SB.flightAtX(x.truthFl, xe), tB = SB.flightAtX(x.truthNo, xe), pA = SB.flightAtX(x.fl.main, xe), pB = SB.flightAtX(x.fl.noSpin, xe);
    if (!tA || !tB || !pA || !pB) continue;
    eff.push((pA.z - pB.z) - (tA.z - tB.z)); lat.push(pA.y - tA.y); hgt.push(pA.z - tA.z);
    const [lo, hi] = SB.bandAtX(x.fl, xe); cover.push(tA.z >= lo - 0.05 && tA.z <= hi + 0.05);
    const sp = SB.strikePoint(x.r.launch), st = SB.strikePoint({ speed: x.t.speedKmh / 3.6, elevDeg: x.t.elevDeg, top: x.t.topRpm, side: x.t.sideRpm, rifle: x.t.rifleRpm });
    if (x.t.rpm >= 150) strike.push(Math.hypot(sp.up - st.up, sp.right - st.right) * 100);
  }
  const abs = (a) => a.map(Math.abs);
  console.log(`\ntrayectoria (hasta ${D} m, ${eff.length} chutes):`);
  console.log(`  efecto vertical del giro: error mediano ${q(abs(eff), 0.5).toFixed(2)} m, p90 ${q(abs(eff), 0.9).toFixed(2)} m`);
  console.log(`  desvío lateral: error mediano ${q(abs(lat), 0.5).toFixed(2)} m, p90 ${q(abs(lat), 0.9).toFixed(2)} m`);
  console.log(`  altura: error mediano ${q(abs(hgt), 0.5).toFixed(2)} m, p90 ${q(abs(hgt), 0.9).toFixed(2)} m; banda cubre la verdad en ${cover.filter(Boolean).length}/${cover.length}`);
  console.log(`  punto de golpeo: error mediano ${q(strike, 0.5).toFixed(2)} cm, p90 ${q(strike, 0.9).toFixed(2)} cm`);
  const er = rows.filter((x) => x.r.elevRange).map((x) => (x.r.elevRange[1] - x.r.elevRange[0]) / 2);
  console.log(`  semiancho de la banda de ángulo: mediana ${q(er, 0.5).toFixed(1)}°, p90 ${q(er, 0.9).toFixed(1)}°`);
  const ee = rows.filter((x) => x.r.elevDeg != null).map((x) => Math.abs(x.r.elevDeg - x.t.elevDeg));
  console.log(`  ángulo de salida: error mediano ${q(ee, 0.5).toFixed(1)}°, p90 ${q(ee, 0.9).toFixed(1)}°, máx ${Math.max(...ee).toFixed(1)}°`);
  // campo abierto: el bote dentro de la grabación fija el ángulo
  {
    const fitted = rows.filter((x) => x.rOpen.ok && x.rOpen.landFit);
    const eo = fitted.map((x) => Math.abs(x.rOpen.elevDeg - x.t.elevDeg));
    const ho = [], topo = [], co = [];
    for (const x of fitted) {
      const xe = Math.min(12, x.truthFl.land ? x.truthFl.land.x : 12, x.flOpen.main.land ? x.flOpen.main.land.x : 12) - 0.01;
      const a = SB.flightAtX(x.flOpen.main, xe), b = SB.flightAtX(x.truthFl, xe);
      if (a && b) { ho.push(Math.abs(a.z - b.z)); const [lo, hi] = SB.bandAtX(x.flOpen, xe); co.push(b.z >= lo - 0.05 && b.z <= hi + 0.05); }
      if (x.t.rpm >= 150) topo.push(Math.abs(x.rOpen.topRpm - x.t.topRpm));
      const dl = Math.abs((x.flOpen.main.land ? x.flOpen.main.land.x : NaN) - (x.truthFl.land ? x.truthFl.land.x : NaN));
      x.landErr = dl;
    }
    const le = fitted.map((x) => x.landErr).filter(isFinite);
    console.log(`  campo abierto (${fitted.length} chutes con bote grabado): ángulo error mediano ${q(eo, 0.5).toFixed(1)}°, p90 ${q(eo, 0.9).toFixed(1)}°; altura p90 ${q(ho, 0.9).toFixed(2)} m; bote: error mediano ${q(le, 0.5).toFixed(2)} m, p90 ${q(le, 0.9).toFixed(2)} m; liftado error p90 ${q(topo, 0.9).toFixed(0)} rpm; banda cubre ${co.filter(Boolean).length}/${co.length}`);
    check(fitted.length >= 10, 'hay chutes con bote grabado');
    check(q(eo, 0.9) < 4, 'ángulo con bote p90 < 4°');
  }
  check(q(abs(eff), 0.9) < 0.8, 'efecto vertical p90 < 0,8 m');
  check(cover.filter(Boolean).length >= 0.85 * cover.length, 'la banda cubre la verdad ≥ 85 %');
}
check(q(rpmErr, 0.9) < 5, 'rpm p90 < 5 %');
check(q(tiltErr, 0.9) < 8, 'eje p90 < 8°');
check(sideSign.every(Boolean), 'sentido lateral');
check(topSign.filter(Boolean).length >= 0.9 * topSign.length, 'liftado/cortado ≥ 90 %');
// Sensor descentrado y mucho giro: la aceleración centrípeta satura algún eje durante parte de cada vuelta.
{
  console.log('\nsensor descentrado (satura en vuelo):');
  const rng = SB.mulberry32(4242), cases = [];
  for (const mm of [4, 6, 8]) for (const rpm of [500, 650, 760]) for (const [name, o] of [['liftado', { top: 1, side: 0.1 }], ['rosca', { top: -0.3, side: 0.9, rifle: 0.15 }]]) for (let k = 0; k < 3; k++) {
    const d = [rng() - 0.5, rng() - 0.5, rng() - 0.5], dn = Math.hypot(...d);
    const sim = SB.simulateKick({ seed: Math.floor(rng() * 1e9), speed: 22 + 6 * rng(), rpm, elevDeg: 13 + 7 * rng(), sensorOffset: d.map((x) => x / dn * mm / 1000), ...o });
    const r = SB.analyze(sim.samples, sim.dt, {});
    cases.push({ mm, rpm, name, r, t: sim.truth });
  }
  const usable = cases.filter((c) => c.r.ok && c.r.saturatedFrac < 0.7);
  const eR = usable.map((c) => Math.abs(c.r.rpm - c.t.rpm) / c.t.rpm * 100), eV = usable.map((c) => Math.abs(c.r.speedKmh - c.t.speedKmh) / c.t.speedKmh * 100);
  const sat = cases.map((c) => c.r.saturatedFrac), nSat = usable.filter((c) => c.r.saturatedFrac > 0.15).length;
  const signOk = usable.every((c) => (c.name === 'liftado' ? c.r.topRpm > 0 : c.r.sideRpm > 0));
  console.log(`  ${cases.length} chutes, ${usable.length} con menos del 70 % saturado (${nSat} de ellos con más del 15 %); saturación máxima ${(100 * Math.max(...sat)).toFixed(0)} %; rpm error máx ${Math.max(...eR).toFixed(1)} %; velocidad error máx ${Math.max(...eV).toFixed(1)} %`);
  check(usable.every((c) => !c.r.lowSpin), 'ninguno se toma por «sin giro»');
  check(nSat >= 4, 'la prueba incluye chutes con saturación en vuelo (' + nSat + ')');
  check(Math.max(...eR) < 5, 'rpm con saturación < 5 %');
  check(Math.max(...eV) < 25, 'velocidad con saturación < 25 %');
  check(signOk, 'sentido del efecto con saturación');
  check(cases.filter((c) => c.r.saturatedFrac >= 0.7).every((c) => c.r.warnings.length > 0), 'los muy saturados llevan aviso');
}
console.log(fails ? `\n${fails} FALLOS` : '\nTODO OK');
process.exit(fails ? 1 : 0);
