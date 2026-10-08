// Modelo de un híbrido enchufable en dos monedas (puntos de batería y euros). Versión JavaScript idéntica a modelo_phev.py
// (validada con validar.js). Versión 3: leyes de profundidad de descarga, clase de celda, margen superior y uso del níquel.
// LFP: Naumann et al. 2018 (reposo) y 2020 (uso). Níquel: Schmalstieg et al. 2014 (reposo y uso, este escalado) con la tensión
// en vacío de Ecker et al. 2014. Sin dependencias; se ejecuta en el navegador. Licencia MIT.
(function (root) {
  const R_GAS = 8.314, K_REF = 1.2571e-5, EA = 17126.0;
  const DIAS_MES = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const CLIMAS = {
    "A Coruña": [10.8, 11.1, 12.4, 13.0, 15.0, 17.4, 19.0, 19.6, 18.6, 16.1, 13.3, 11.5],
    "Santander": [9.7, 9.8, 11.3, 12.4, 15.1, 17.8, 19.8, 20.3, 18.6, 16.1, 12.5, 10.5],
    "Oviedo": [8.3, 8.7, 10.5, 11.3, 13.9, 16.7, 18.7, 19.1, 17.6, 14.6, 10.9, 8.9],
    "Bilbao": [9.3, 9.7, 11.5, 12.6, 15.7, 18.4, 20.4, 20.9, 19.2, 16.4, 12.4, 9.9],
    "León": [3.2, 4.7, 7.6, 9.0, 12.6, 17.1, 19.8, 19.6, 16.5, 11.7, 7.0, 4.2],
    "Valladolid": [4.2, 5.9, 9.0, 10.7, 14.5, 19.3, 22.3, 22.1, 18.5, 13.2, 7.9, 5.0],
    "Madrid": [6.3, 7.9, 11.2, 12.9, 16.7, 22.2, 25.6, 25.1, 20.9, 15.1, 9.9, 6.9],
    "Zaragoza": [6.6, 8.2, 11.6, 13.8, 18.0, 22.6, 25.3, 25.0, 21.2, 16.2, 10.6, 7.0],
    "Barcelona": [9.2, 9.9, 11.8, 13.7, 16.9, 20.9, 23.9, 24.4, 21.7, 17.8, 13.0, 10.0],
    "Valencia": [11.8, 12.5, 14.4, 16.2, 19.0, 22.9, 25.6, 26.1, 23.5, 19.7, 15.3, 12.6],
    "Palma": [9.5, 9.8, 11.3, 13.6, 17.5, 21.7, 24.8, 25.1, 22.2, 18.5, 13.7, 10.8],
    "Murcia": [10.6, 12.2, 14.3, 16.5, 20.0, 24.2, 27.2, 27.6, 24.2, 19.8, 14.6, 11.5],
    "Málaga": [12.1, 12.9, 14.7, 16.3, 19.3, 23.0, 25.5, 26.0, 23.5, 19.5, 15.7, 13.2],
    "Sevilla": [10.9, 12.5, 15.6, 17.3, 20.7, 25.1, 28.2, 27.9, 25.0, 20.2, 15.1, 11.9],
    "Tenerife": [18.2, 18.3, 19.0, 19.7, 21.0, 22.9, 25.0, 25.5, 24.9, 23.4, 21.3, 19.4],
    "25 °C constante": [25, 25, 25, 25, 25, 25, 25, 25, 25, 25, 25, 25],
  };

  // ---------- LFP (Naumann)
  function kSocNaumann(s) { return 2.8575 * Math.pow(s - 0.5, 3) + 0.60225; }
  function kSoc(s, variante) {
    let k = kSocNaumann(s);
    if (variante === "alta" && s > 0.7) { const k50 = kSocNaumann(0.5), k70 = kSocNaumann(0.7); k = k70 + (s - 0.7) / 0.3 * (2.2 * k50 - k70); }
    return k;
  }
  function kCal(s, TC, variante) { const T = TC + 273.15; return K_REF * Math.exp(-EA / R_GAS * (1 / T - 1 / 298.15)) * kSoc(s, variante); }
  const K_DOD_1 = 4.0253 * Math.pow(0.4, 3) + 1.0923; // 1,3499
  function kC(c) { return 0.0630 * c + 0.0971; }
  function kDodNaumann(d) { return 4.0253 * Math.pow(d - 0.6, 3) + 1.0923; }
  function kDod(d, ley) {
    d = Math.max(1e-6, Math.min(1, d)); ley = ley || "naumann";
    if (ley === "naumann") return kDodNaumann(d);
    if (ley === "plana") return d >= 0.10 ? K_DOD_1 : kDodNaumann(d);
    if (ley === "omar") return K_DOD_1 * Math.pow(d, 0.36);
    if (ley === "inversa") return K_DOD_1 * Math.sqrt(d);
    throw new Error("ley " + ley);
  }
  function kCyc(c, dod, ley) { return kC(c) * kDod(dod, ley) / 100; }
  function fecHasta(perdida, c, dod, ley) { return Math.pow((perdida == null ? 0.20 : perdida) / kCyc(c == null ? 0.5 : c, dod == null ? 1 : dod, ley), 2); }
  const N80_NAUMANN = fecHasta();
  const CELDAS = { naumann: N80_NAUMANN, blade5000: 5000, sandia: 2500 };
  function escalaUso(celda) { const n80 = (typeof celda === "number") ? celda : (CELDAS[celda || "naumann"] || N80_NAUMANN); return Math.sqrt(N80_NAUMANN / n80); }

  // ---------- Níquel (Schmalstieg), solo reposo
  const SOC_PTS = [0, 0.10, 0.20, 0.30, 0.50, 0.60, 0.70, 0.80, 0.85, 0.90, 0.95, 1.00];
  const V_PTS = [3.331, 3.494, 3.578, 3.626, 3.699, 3.782, 3.869, 3.964, 4.018, 4.072, 4.117, 4.162];
  function ocv(s) {
    if (s <= 0) return V_PTS[0];
    if (s >= 1) return V_PTS[V_PTS.length - 1];
    let i = 1; while (SOC_PTS[i] < s) i++;
    return V_PTS[i - 1] + (V_PTS[i] - V_PTS[i - 1]) * (s - SOC_PTS[i - 1]) / (SOC_PTS[i] - SOC_PTS[i - 1]);
  }
  function alphaNmc(s, TC) { return (7.543 * ocv(s) - 23.75) * 1e6 * Math.exp(-6976.0 / (TC + 273.15)); }
  const AH_CELDA = 2.05;
  function betaNmc(v, ddod) { return 7.348e-3 * Math.pow(v - 3.667, 2) + 7.6e-4 + 4.081e-3 * ddod; }
  function escalaNiUsabc(ventana, ciclos, perdida, socMedio) {
    ventana = ventana == null ? 0.70 : ventana; ciclos = ciclos == null ? 5000 : ciclos; perdida = perdida == null ? 0.20 : perdida; socMedio = socMedio == null ? 0.5 : socMedio;
    return perdida / (betaNmc(ocv(socMedio), ventana) * Math.sqrt(ciclos * ventana * 2 * AH_CELDA));
  }
  const ESCALA_NI_USABC = escalaNiUsabc();

  function temperaturaHoraria(clima, off) {
    const t = CLIMAS[clima], out = new Float64Array(8760); let i = 0;
    for (let m = 0; m < 12; m++) for (let h = 0; h < 24 * DIAS_MES[m]; h++) out[i++] = t[m] + (off || 0);
    return out;
  }

  // ---------- Tarifa de tres periodos (2.0TD)
  function periodo(d, h) { if (d >= 5 || h < 8) return "valle"; if ((h >= 10 && h < 14) || (h >= 18 && h < 22)) return "punta"; return "llano"; }
  function precioHora(d, h, precios) { return (typeof precios === "number") ? precios : precios[periodo(d, h)]; }

  // ---------- Perfil semanal (idéntico a simular_perfil)
  function simularPerfil(coche, km, potenciaKw, o) {
    o = o || {};
    const objetivo = o.objetivo == null ? 1.0 : o.objetivo, programada = !!o.programada, cadaN = o.cada_n_dias || 1, nunca = !!o.nunca;
    const ef = o.eficiencia == null ? 0.9 : o.eficiencia, hS = o.h_salida == null ? 8 : o.h_salida, hR = o.h_regreso == null ? 18 : o.h_regreso;
    const hE = o.h_enchufe == null ? 19 : o.h_enchufe, reparto = o.reparto == null ? 0.55 : o.reparto, fHev = o.f_hev == null ? 1 / 3 : o.f_hev;
    const semanas = o.semanas || 4, capRel = o.capacidad_rel == null ? 1.0 : o.capacidad_rel;
    const trabajo = o.trabajo || null, semanal100 = o.semanal_100 == null ? null : o.semanal_100, inicioFijo = o.inicio_fijo == null ? null : o.inicio_fijo;
    const top = coche.top == null ? 1.0 : coche.top;
    const kwh = coche.kwh * top * capRel, suelo = o.suelo_ev == null ? coche.suelo : o.suelo_ev, cons = coche.cons_ev;
    const pCasa = Math.min(potenciaKw, coche.p_ca) * ef / kwh;
    const n = 168 * semanas, soc = new Float64Array(n), red = new Float64Array(168), redTrabajo = new Float64Array(168);
    let s = nunca ? suelo : objetivo, carga = null, kmEv = 0, kmHev = 0, fecProf = 0, fecMicro = 0;
    const tramos = [];
    function trayecto(kmT, ultimo) {
      const e = kmT * cons / kwh, disp = Math.max(0, s - suelo);
      if (e <= disp + 1e-12) { s -= e; if (ultimo) { kmEv += kmT; fecProf += e * top * capRel; } }
      else {
        const kEv = disp * kwh / cons; s -= disp;
        if (ultimo) { kmEv += kEv; kmHev += kmT - kEv; fecProf += disp * top * capRel; fecMicro += (kmT - kEv) * cons * fHev / coche.kwh; }
      }
    }
    for (let t = 0; t < n; t++) {
      const d = Math.floor(t / 24) % 7, h = t % 24, ultimo = t >= n - 168;
      if (h === hS) { if (carga !== null && carga[3] === "casa") carga = null; trayecto(km[d] * reparto, ultimo); }
      if (trabajo !== null && d < 5 && h === (trabajo.h_ini == null ? hS + 1 : trabajo.h_ini) && s < 1 - 1e-9) {
        const pT = Math.min(trabajo.potencia, coche.p_ca) * ef / kwh;
        carga = [1.0, t, pT, "trabajo"];
        if (ultimo) tramos.push([s, 1.0, pT * top * capRel]);
      }
      if (h === hR) {
        if (carga !== null && carga[3] === "trabajo") { if (ultimo && tramos.length) tramos[tramos.length - 1][1] = s; carga = null; }
        trayecto(km[d] * (1 - reparto), ultimo);
      }
      if (h === hE && !nunca) {
        let diaCarga = (d % cadaN === 0), obj = objetivo, prog = programada;
        if (semanal100 !== null && d === semanal100) { diaCarga = true; obj = 1.0; prog = true; }
        if (diaCarga && obj > s + 1e-9) {
          const horas = (obj - s) / pCasa, fin = t + (24 - hE) + hS;
          let ini = prog ? Math.max(t, fin - horas) : t;
          if (inicioFijo !== null && !prog) ini = t + ((((inicioFijo - hE) % 24) + 24) % 24);
          carga = [obj, ini, pCasa, "casa"];
          if (ultimo) tramos.push([s, obj, pCasa * top * capRel]);
        }
      }
      if (carga !== null) {
        const obj = carga[0], ini = carga[1], p = carga[2], lugar = carga[3];
        if (t + 1 > ini) {
          const paso = p * Math.min(1, t + 1 - ini), sNew = Math.min(obj, s + paso);
          if (ultimo) { const eRed = (sNew - s) * kwh / ef; if (lugar === "casa") red[t % 168] += eRed; else redTrabajo[t % 168] += eRed; }
          s = sNew;
          if (s >= obj - 1e-9) carga = null;
        }
      }
      soc[t] = s;
    }
    return { soc: soc.slice(n - 168), km_ev: kmEv, km_hev: kmHev, fec_prof: fecProf, fec_micro: fecMicro, red: red, red_trabajo: redTrabajo,
             tramos: tramos.filter(x => x[1] > x[0] + 1e-9), top: top };
  }

  // ---------- Envejecimiento LFP
  function envejecer(coche, perfil, clima, o) {
    o = o || {};
    const anos = o.anos || 15, variante = o.variante || "naumann", vMedia = o.v_media || 50, cMicro = o.c_micro || 1.0, dodMicro = o.dod_micro || 0.03;
    const ley = o.ley || "naumann", esc = escalaUso(o.celda == null ? "naumann" : o.celda), top = perfil.top == null ? (coche.top == null ? 1 : coche.top) : perfil.top;
    const T = temperaturaHoraria(clima, o.offset_T || 0), nH = 8760, socSem = new Float64Array(168);
    for (let h = 0; h < 168; h++) socSem[h] = perfil.soc[h] * top;
    const ks = new Float64Array(nH);
    const socH = new Float64Array(nH);
    for (let h = 0; h < nH; h++) socH[h] = socSem[h % 168];
    if (o.parada) { let h0 = 0; for (let m = 0; m < 7; m++) h0 += 24 * DIAS_MES[m]; for (let h = h0; h < h0 + 24 * o.parada.dias && h < nH; h++) socH[h] = o.parada.soc * top; }
    for (let h = 0; h < nH; h++) ks[h] = kCal(socH[h], T[h], variante);
    const cDesc = coche.cons_ev * vMedia / coche.kwh;
    const fecProfAno = perfil.fec_prof * 365 / 7, fecMicroAno = perfil.fec_micro * 365 / 7;
    let den = 0; for (const tr of perfil.tramos) den += tr[1] - tr[0];
    let k2Ano = 0, sw = 0, sdod = 0, sc = 0;
    for (const tr of perfil.tramos) {
      const w = (tr[1] - tr[0]) * top, c = 0.5 * (tr[2] + cDesc);
      k2Ano += den > 0 ? Math.pow(kCyc(c, w, ley), 2) * fecProfAno * (tr[1] - tr[0]) / den : 0;
      sw += w; sdod += w * w; sc += c * w;
    }
    k2Ano += Math.pow(kCyc(cMicro, dodMicro, ley), 2) * fecMicroAno;
    k2Ano *= esc * esc;
    const fecAno = fecProfAno + fecMicroAno;
    const res = { anos: [], total: [], cal: [], cyc: [] };
    let Q = 0;
    for (let a = 1; a <= anos; a++) {
      for (let h = 0; h < nH; h++) { const k = ks[h]; const tv = Q > 0 ? (Q / k) * (Q / k) : 0; Q = k * Math.sqrt(tv + 3600); }
      const Qc = Math.sqrt(k2Ano * a);
      res.anos.push(a); res.cal.push(Q); res.cyc.push(Qc); res.total.push(Q + Qc);
    }
    let h95 = 0, smin = 1, smax = 0, sm = 0;
    for (let h = 0; h < 168; h++) { const sd = perfil.soc[h]; if (sd >= 0.95) h95++; if (socSem[h] < smin) smin = socSem[h]; if (socSem[h] > smax) smax = socSem[h]; sm += socSem[h]; }
    res.h_sem_95 = h95; res.soc_min = smin; res.soc_max = smax; res.soc_medio = sm / 168;
    res.fec_prof_ano = fecProfAno; res.fec_micro_ano = fecMicroAno; res.fec_ano = fecAno; res.escala_uso = esc;
    res.dod = sw > 0 ? sdod / sw : 0; res.c_eff = sw > 0 ? sc / sw : cDesc;
    return res;
  }

  // ---------- Reposo de una batería de níquel (perfil de SOC real de la celda)
  function envejecerNmcReposo(socReal, clima, anos, offT) {
    const T = temperaturaHoraria(clima, offT || 0), nH = 8760, al = new Float64Array(nH);
    for (let h = 0; h < nH; h++) al[h] = alphaNmc(socReal[h % 168], T[h]);
    const out = []; let Q = 0;
    for (let a = 1; a <= (anos || 15); a++) {
      for (let h = 0; h < nH; h++) { const x = al[h]; const tv = Q > 0 ? Math.pow(Q / x, 1 / 0.75) : 0; Q = x * Math.pow(tv + 1 / 24, 0.75); }
      out.push(Q);
    }
    return out;
  }

  // ---------- Uso de una batería de níquel (β de Schmalstieg sobre la ventana real, escalada a una clase de celda)
  function usoNmc(perfil, kwhUtil, kwhBruta, lo, hi, anos, escala) {
    anos = anos || 15; escala = escala == null ? ESCALA_NI_USABC : escala;
    const r = hi - lo, fecProfAno = perfil.fec_prof * 365 / 7 * kwhUtil / kwhBruta, fecMicroAno = perfil.fec_micro * 365 / 7 * kwhUtil / kwhBruta;
    let den = 0; for (const tr of perfil.tramos) den += tr[1] - tr[0];
    let b2 = 0, sw = 0, sdod = 0, sv = 0;
    for (const tr of perfil.tramos) {
      const ddod = (tr[1] - tr[0]) * r, v = ocv(lo + 0.5 * (tr[0] + tr[1]) * r), bb = betaNmc(v, ddod);
      b2 += den > 0 ? bb * bb * fecProfAno * (tr[1] - tr[0]) / den : 0;
      sw += ddod; sdod += ddod * ddod; sv += v * ddod;
    }
    b2 += Math.pow(betaNmc(ocv(lo), 0.03), 2) * fecMicroAno;
    const out = []; for (let a = 1; a <= anos; a++) out.push(escala * Math.sqrt(b2 * 2 * AH_CELDA * a));
    return { curva: out, fec_ano: fecProfAno + fecMicroAno, fec_prof_ano: fecProfAno, ddod: sw > 0 ? sdod / sw : 0, v_avg: sw > 0 ? sv / sw : ocv(lo) };
  }

  // ---------- Euros
  function eurosSemana(coche, perfil, precios, precioGasolina, precioTrabajo) {
    let eCasa = 0, kwhCasa = 0, kwhTrab = 0;
    for (let i = 0; i < 168; i++) { if (perfil.red[i] > 0) { eCasa += perfil.red[i] * precioHora(Math.floor(i / 24), i % 24, precios); kwhCasa += perfil.red[i]; } kwhTrab += perfil.red_trabajo[i]; }
    const eTrab = kwhTrab * (precioTrabajo || 0), litros = perfil.km_hev * coche.cons_hev;
    return { casa: eCasa, trabajo: eTrab, gasolina: litros * precioGasolina, litros: litros, kwh_casa: kwhCasa, kwh_trabajo: kwhTrab, total: eCasa + eTrab + litros * precioGasolina };
  }

  // ---------- Simulación completa. o.quimica === "NMC": solo reposo (Schmalstieg) con la ventana real [o.real_lo, o.real_hi]
  function simular(coche, km, potenciaKw, o) {
    o = o || {};
    const anos = o.anos || 15, clima = o.clima || "Madrid";
    const precios = o.precios == null ? { punta: 0.199, llano: 0.159, valle: 0.119 } : o.precios;
    const gas = o.precio_gasolina == null ? 1.92 : o.precio_gasolina, pTrab = o.precio_trabajo || 0;
    const perfil = simularPerfil(coche, km, potenciaKw, o);
    let res;
    if (coche.quimica === "NMC") {
      const lo = coche.real_lo, hi = coche.real_hi, real = new Float64Array(168);
      for (let h = 0; h < 168; h++) real[h] = lo + perfil.soc[h] * (hi - lo);
      const cal = envejecerNmcReposo(real, clima, anos, o.offset_T || 0);
      const escNi = o.escala_ni == null ? ESCALA_NI_USABC : o.escala_ni;
      const u = usoNmc(perfil, coche.kwh, coche.kwh_bruta || coche.kwh / (hi - lo), lo, hi, anos, escNi);
      res = { anos: cal.map((_, i) => i + 1), total: cal.map((c, i) => c + u.curva[i]), cal: cal, cyc: u.curva, solo_reposo: escNi === 0 };
      let h95 = 0; for (let h = 0; h < 168; h++) if (perfil.soc[h] >= 0.95) h95++;
      res.h_sem_95 = h95; res.fec_prof_ano = u.fec_prof_ano; res.fec_micro_ano = u.fec_ano - u.fec_prof_ano; res.fec_ano = u.fec_ano; res.dod = u.ddod; res.v_avg = u.v_avg;
    } else {
      res = envejecer(coche, perfil, clima, o);
    }
    const e0 = eurosSemana(coche, perfil, precios, gas, pTrab);
    res.perfil = perfil;
    res.euros_ano_nueva = {}; for (const k in e0) res.euros_ano_nueva[k] = e0[k] * 365 / 7;
    res.km_ev_ano_nueva = perfil.km_ev * 365 / 7; res.km_hev_ano_nueva = perfil.km_hev * 365 / 7;
    res.euros_ano = []; res.km_ev_ano = []; res.km_hev_ano = [];
    const escala = o.escala == null ? 1 : o.escala;
    for (let a = 1; a <= anos; a++) {
      const media = 0.5 * ((a > 1 ? res.total[a - 2] : 0) + res.total[a - 1]) * escala;
      const oa = Object.assign({}, o, { capacidad_rel: 1 - media });
      const pa = simularPerfil(coche, km, potenciaKw, oa), ea = eurosSemana(coche, pa, precios, gas, pTrab);
      res.euros_ano.push(ea.total * 365 / 7); res.km_ev_ano.push(pa.km_ev * 365 / 7); res.km_hev_ano.push(pa.km_hev * 365 / 7);
    }
    return res;
  }

  function anosHasta(total, umbral) {
    const n = total.length;
    if (total[n - 1] < umbral) return n * Math.pow(umbral / total[n - 1], 2);
    let i = 0; while (i < n && total[i] < umbral) i++;
    if (i === 0) return umbral / total[0];
    return i + (umbral - total[i - 1]) / (total[i] - total[i - 1]);
  }

  const api = { CLIMAS, kSoc, kCal, kCyc, kDod, kC, escalaUso, N80_NAUMANN, ocv, alphaNmc, betaNmc, ESCALA_NI_USABC, periodo, precioHora, simularPerfil, envejecer, envejecerNmcReposo, usoNmc, eurosSemana, simular, anosHasta };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.ModeloPHEV = api;
})(typeof window !== "undefined" ? window : globalThis);
