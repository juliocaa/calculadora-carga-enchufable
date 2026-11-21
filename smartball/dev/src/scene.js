/* scene.js — dibujo en canvas: el campo con la trayectoria (vista del lanzador, perspectiva, lateral y
 * desde arriba), el balón en 3D girando sobre su eje real y el punto de golpeo.
 * Mundo: x hacia el objetivo, y a la izquierda, z arriba; el balón sale del origen. */
(function (root) {
  'use strict';
  const SB = root.SB, V = SB.V;
  const C = {
    sky: '#06281B', g1: '#0D6B45', g2: '#0B5F3D', chalk: '#F4F7F1', chalkDim: 'rgba(244,247,241,0.5)',
    trace: '#FFD60A', traceDim: 'rgba(255,214,10,0.45)', band: 'rgba(255,214,10,0.15)',
    wall: '#2F6FE0', wallHead: '#9DBDF7', shadow: 'rgba(3,20,13,0.42)', ink: '#0A1E16', ball: '#FFFFFF',
  };
  const FONT = '"Atkinson Hyperlegible", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  const GOAL_W = 7.32, GOAL_H = 2.44, WALL_X = 9.15, WALL_H = 1.8, RB = SB.PHYS.R;
  const WALL_YS = [-0.93, -0.31, 0.31, 0.93];
  const reducedMotion = () => !!(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const es = (x, d) => (x == null || !isFinite(x) ? '—' : x.toFixed(d == null ? 1 : d).replace('.', ','));
  const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  const lerp = (a, b, t) => a + (b - a) * t;
  const lerp3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

  function fit(cv) {
    if (!cv || !cv.getContext) return null;
    let ctx = null;
    try { ctx = cv.getContext('2d'); } catch (e) { ctx = null; }
    if (!ctx) return null;
    const dpr = Math.min(root.devicePixelRatio || 1, 3);
    const w = cv.clientWidth || 320, h = cv.clientHeight || 200;
    const pw = Math.round(w * dpr), ph = Math.round(h * dpr);
    if (cv.width !== pw || cv.height !== ph) { cv.width = pw; cv.height = ph; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    return { ctx, w, h };
  }

  // ------------------------------------------------------------------ balón clásico: icosaedro truncado
  // 12 pentágonos oscuros y 20 hexágonos blancos; costuras en las aristas.
  const BALL = (() => {
    const ph = (1 + Math.sqrt(5)) / 2, raw = [];
    for (const a of [-1, 1]) for (const b of [-1, 1]) raw.push([0, a, b * ph], [a, b * ph, 0], [a * ph, 0, b]);
    const U = raw.map((v) => V.unit(v));
    const edge = Math.min(...U.slice(1).map((v) => V.norm(V.sub(v, U[0]))));
    const nb = U.map((p) => U.filter((q) => q !== p && Math.abs(V.norm(V.sub(p, q)) - edge) < 1e-6));
    const mix = (p, q, t) => V.unit(V.add(V.mul(p, 1 - t), V.mul(q, t)));
    const arc = (p, q, n) => { const out = []; for (let i = 0; i < n; i++) out.push(mix(p, q, i / n)); return out; };
    const tv = (p, q) => mix(p, q, 1 / 3);   // vértice del truncado sobre la arista p-q
    const pents = U.map((p, i) => {
      const e1 = V.perp(p), e2 = V.cross(p, e1), ang = (q) => Math.atan2(V.dot(q, e2), V.dot(q, e1));
      const verts = nb[i].slice().sort((x, y) => ang(x) - ang(y)).map((q) => tv(p, q));
      const outline = []; verts.forEach((v, k) => outline.push(...arc(v, verts[(k + 1) % 5], 5)));
      return { c: p, outline };
    });
    const seams = [];
    U.forEach((p, i) => nb[i].forEach((q) => { if (U.indexOf(q) > i) seams.push(arc(tv(p, q), tv(q, p), 5).concat([tv(q, p)])); }));
    return { pents, seams };
  })();
  const LIGHT_VIEW = V.unit([-0.42, 0.62, 0.66]);   // luz arriba a la izquierda, de frente

  // toView: vector unitario del balón → [x a la derecha, y arriba, z hacia quien mira]
  function drawBall3D(ctx, cx, cy, r, toView, light) {
    const L = light || LIGHT_VIEW;
    const hx = cx + L[0] * r * 0.48, hy = cy - L[1] * r * 0.48;
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
    const g = ctx.createRadialGradient(hx, hy, r * 0.04, cx, cy, r);
    g.addColorStop(0, '#FFFFFF'); g.addColorStop(0.5, '#EEF2EF'); g.addColorStop(0.82, '#C6D1CA'); g.addColorStop(1, '#8F9F96');
    ctx.fillStyle = g; ctx.fill();
    ctx.clip();
    const scr = (q) => { let x = q[0], y = q[1]; if (q[2] < 0) { const n = Math.hypot(x, y) || 1; x /= n; y /= n; } return [cx + x * r, cy - y * r]; };
    if (r >= 12) {   // costuras
      ctx.strokeStyle = 'rgba(60,82,72,0.38)'; ctx.lineWidth = Math.max(0.6, r * 0.014); ctx.beginPath();
      for (const s of BALL.seams) {
        let on = false;
        for (const v of s) { const q = toView(v); if (q[2] < 0.03) { on = false; continue; } const P = scr(q); if (on) ctx.lineTo(P[0], P[1]); else ctx.moveTo(P[0], P[1]); on = true; }
      }
      ctx.stroke();
    }
    for (const p of BALL.pents) {
      const c = toView(p.c); if (c[2] < -0.45) continue;
      const k = 0.25 + 0.75 * Math.max(0, c[0] * L[0] + c[1] * L[1] + c[2] * L[2]);
      ctx.fillStyle = `rgb(${Math.round(12 + 50 * k)},${Math.round(28 + 48 * k)},${Math.round(22 + 44 * k)})`;
      ctx.beginPath();
      p.outline.forEach((v, i) => { const P = scr(toView(v)); if (i) ctx.lineTo(P[0], P[1]); else ctx.moveTo(P[0], P[1]); });
      ctx.closePath(); ctx.fill();
    }
    const s = ctx.createRadialGradient(hx, hy, 0, hx, hy, r * 0.62);
    s.addColorStop(0, 'rgba(255,255,255,0.55)'); s.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = s; ctx.fillRect(cx - r, cy - r, 2 * r, 2 * r);
    const rim = ctx.createRadialGradient(cx - L[0] * r * 0.18, cy + L[1] * r * 0.18, r * 0.5, cx, cy, r * 1.02);
    rim.addColorStop(0, 'rgba(5,28,18,0)'); rim.addColorStop(1, 'rgba(5,28,18,0.45)');
    ctx.fillStyle = rim; ctx.fillRect(cx - r, cy - r, 2 * r, 2 * r);
    ctx.restore();
    ctx.strokeStyle = 'rgba(10,30,22,0.7)'; ctx.lineWidth = Math.max(1, r * 0.022);
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
  }
  function groundShadow(ctx, x, y, rx, ry, alpha) {
    if (!(rx > 0.5)) return;
    ctx.save(); ctx.translate(x, y); ctx.scale(1, Math.max(0.05, ry / rx));
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
    g.addColorStop(0, `rgba(0,16,9,${alpha})`); g.addColorStop(0.6, `rgba(0,16,9,${alpha * 0.55})`); g.addColorStop(1, 'rgba(0,16,9,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, rx, 0, Math.PI * 2); ctx.fill(); ctx.restore();
  }
  const REST_AXIS = V.unit([0.3, -0.55, 0.78]), REST_ANG = 0.9;   // orientación del balón en reposo

  // ------------------------------------------------------------------ escena del campo
  class PitchScene {
    constructor(canvas) {
      this.cv = canvas; this.view = 'behind'; this.fl = null; this.meta = {};
      this.goalDist = 20; this.showWall = true;
      this.t = null;            // instante de la animación (s desde el golpeo); null = trayectoria completa
      this.raf = 0; this.rate = 0.5; this.onEnd = null;
      this.hero = true;         // vista del lanzador, sin trayectoria, mientras se prepara el chute
      this.blend = 1;           // 0 = vista del lanzador, 1 = perspectiva elevada
    }
    setContext(goalDist, showWall) { this.goalDist = goalDist; this.showWall = showWall; this.findCut(); this.draw(); }
    setHero(on) { on = !!on; if (on === this.hero) return; this.hero = on; if (on) { this.stop(); this.t = null; this.blend = 1; } this.draw(); }
    // Dónde termina el dibujo: en la red si el balón entra en la portería, en la barrera si da en ella.
    findCut() {
      this.cut = null; this.camS = null;
      const fl = this.fl; if (!fl) return;
      const D = this.goalDist, m = fl.main;
      let x = Infinity;
      if (this.showWall && D >= WALL_X + 2) { const q = SB.flightAtX(m, WALL_X); if (q && Math.abs(q.y) < 1.2 && q.z < 1.72) x = WALL_X - 0.1; }
      if (!isFinite(x)) { const g = SB.flightAtX(m, D); if (g && Math.abs(g.y) < GOAL_W / 2 - RB && g.z < GOAL_H - RB) x = D + 0.9; }
      if (isFinite(x)) { const q = SB.flightAtX(m, x); if (q) this.cut = q; }
    }
    setView(v) { this.view = v; this.draw(); }
    caption() { const D = this.goalDist; return this.showWall && D >= WALL_X + 2 ? `Falta a ${es(D, 0)} m, con barrera` : `Portería a ${es(D, 0)} m`; }
    // fl: resultado de SB.kickFlight; meta: { recordedS, hitS (segundo impacto sin afinar), fitted }
    setFlight(fl, meta) { this.stop(); this.fl = fl; this.meta = meta || {}; this.t = null; this.blend = 1; this.findCut(); this.draw(); }
    endTime() { const m = this.fl.main; return Math.min(this.cut ? this.cut.t : m.T[m.T.length - 1], 6); }
    cutX() { return this.cut ? this.cut.x : Infinity; }
    stop() { if (this.raf) { cancelAnimationFrame(this.raf); this.raf = 0; } }
    // Animación del vuelo; en perspectiva arranca desde la vista del lanzador y la cámara se aleja mientras vuela.
    play() {
      this.stop();
      if (!this.fl) return;
      if (reducedMotion() || typeof requestAnimationFrame !== 'function') { this.t = null; this.blend = 1; this.draw(); return; }
      // entre 1,8 y 3,2 s de animación: los chutes cortos se ven a cámara lenta
      const end = this.endTime(), rate = end / Math.max(1.8, Math.min(3.2, end / this.rate)), pov = this.view === 'behind' && !this.hero;
      this.playRate = rate;
      let last = null; this.t = 0; this.blend = pov ? 0 : 1;
      const step = (ts) => {
        if (last == null) last = ts;
        this.t += (ts - last) / 1000 * rate; last = ts;
        if (pov) this.blend = smooth(0.1 * end, 0.72 * end, this.t);
        if (this.t >= end) { this.t = null; this.blend = 1; this.raf = 0; this.draw(); if (this.onEnd) this.onEnd(); return; }
        this.draw();
        this.raf = requestAnimationFrame(step);
      };
      this.raf = requestAnimationFrame(step);
    }
    // Instante fijado desde fuera (vídeo): t < 0 deja el balón en el punto de golpeo.
    setTime(t) { this.stop(); this.t = t; this.blend = 1; this.draw(); }
    draw() {
      const f = fit(this.cv); if (!f) return;
      if (this.hero || this.view === 'behind') this.drawBehind(f.ctx, f.w, f.h);
      else if (this.view === 'side') this.drawSide(f.ctx, f.w, f.h);
      else this.drawTop(f.ctx, f.w, f.h);
    }
    ballNow() {
      if (this.hero || !this.fl) return { x: 0, y: 0, z: RB, t: 0 };
      if (this.t == null) {
        if (this.cut) return { ...this.cut, rest: true };
        const m = this.fl.main, n = m.T.length - 1; return { x: m.X[n], y: m.Y[n], z: m.Z[n], t: m.T[n], rest: true };
      }
      if (this.t <= 0) return { x: 0, y: 0, z: RB, t: 0 };
      return SB.flightAtT(this.fl.main, Math.min(this.t, this.endTime()));
    }
    // Tramo medido (línea continua) y proyectado (discontinua): índices de corte de la trayectoria principal.
    cutIndex(tr, tCut) { let i = 0; while (i < tr.T.length - 1 && tr.T[i] < tCut) i++; return i; }

    // ---------- cámaras: la del lanzador (detrás del balón, a la altura de las rodillas) y la elevada
    camSpec(kind, w, h) {
      const D = this.goalDist;
      if (kind === 'pov') {
        // el balón, justo por encima del cartel de estado (heroBottom: lo que tapa ese cartel por abajo)
        const avail = h - (this.hero ? (this.heroBottom || 0.3 * h) : 0);
        const f = Math.max(0.6 * h, Math.min(1.05 * h, 2.3 * w, 1.3 * avail));
        const yBall = Math.min(0.615 * h, avail - 0.081 * f - 8);
        return { pos: [-1.3, 0, 0.5], look: [D, 0, 0.5], f, cy: Math.max(0.12 * h, yBall - 0.3 * f) };
      }
      const key = w + 'x' + h + '/' + D;
      if (this.camS == null || this.camKey !== key) { this.camKey = key; this.camS = 1; this.camS = this.fitCamera(w, h); }
      return this.fitSpec(w, h, this.camS);
    }
    fitSpec(w, h, s) {   // s = 1: encuadre normal; mayor: más lejos y más alta
      const D = this.goalDist, l0 = [D * 0.5, 0.6, 0.3];
      const look = [l0[0], l0[1], l0[2] + (s - 1) * 2.4];
      const pos = V.add(look, V.mul(V.sub([-7.8, -4.6, 5.4], l0), s));
      return { pos, look, f: (h / 2) / Math.tan(21 * Math.PI / 180), cy: h / 2 };
    }
    build(sp, w) {
      const fwd = V.unit(V.sub(sp.look, sp.pos)), right = V.unit(V.cross(fwd, [0, 0, 1])), up = V.cross(right, fwd);
      return { pos: sp.pos, fwd, right, up, f: sp.f, cx: w / 2, cy: sp.cy };
    }
    camera(w, h) {
      if (this.hero) return this.build(this.camSpec('pov', w, h), w);
      const fs = this.camSpec('fit', w, h);
      if (this.blend >= 1) return this.build(fs, w);
      const pv = this.camSpec('pov', w, h), b = this.blend;
      return this.build({ pos: lerp3(pv.pos, fs.pos, b), look: lerp3(pv.look, fs.look, b), f: lerp(pv.f, fs.f, b), cy: lerp(pv.cy, fs.cy, b) }, w);
    }
    // la cámara elevada se aleja lo justo para que quepa toda la trayectoria
    fitCamera(w, h) {
      const fl = this.fl; if (!fl) return 1;
      const m = fl.main, end = this.endTime(), pts = [];
      for (let i = 0; i < m.T.length; i += 4) { if (m.T[i] > end) break; pts.push([m.X[i], m.Y[i], m.Z[i]]); }
      for (let s = 1; s < 2.75; s += 0.125) {
        const cam = this.build(this.fitSpec(w, h, s), w);
        if (pts.every((p) => { const P = this.proj(cam, p); return !P || (P[1] > 26 && P[0] > 10 && P[0] < w - 10); })) return s;
      }
      return 2.75;
    }
    proj(cam, p) {
      const d = V.sub(p, cam.pos), z = V.dot(d, cam.fwd);
      if (z < 0.3) return null;
      return [cam.cx + cam.f * V.dot(d, cam.right) / z, cam.cy - cam.f * V.dot(d, cam.up) / z, z];
    }
    seg(ctx, cam, a, b) { // segmento 3D recortado contra el plano cercano
      const near = 0.3, za = V.dot(V.sub(a, cam.pos), cam.fwd), zb = V.dot(V.sub(b, cam.pos), cam.fwd);
      if (za < near && zb < near) return;
      let p = a, q = b;
      if (za < near) p = V.add(a, V.mul(V.sub(b, a), (near + 0.01 - za) / (zb - za)));
      if (zb < near) q = V.add(b, V.mul(V.sub(a, b), (near + 0.01 - zb) / (za - zb)));
      const P = this.proj(cam, p), Q = this.proj(cam, q);
      if (!P || !Q) return;
      ctx.moveTo(P[0], P[1]); ctx.lineTo(Q[0], Q[1]);
    }
    fillPoly(ctx, cam, pts) {
      const near = 0.4, cs = pts.map((p) => { const d = V.sub(p, cam.pos); return [V.dot(d, cam.right), V.dot(d, cam.up), V.dot(d, cam.fwd)]; });
      const out = [];
      for (let i = 0; i < cs.length; i++) {
        const a = cs[i], b = cs[(i + 1) % cs.length], ina = a[2] >= near, inb = b[2] >= near;
        if (ina) out.push(a);
        if (ina !== inb) { const f = (near - a[2]) / (b[2] - a[2]); out.push([a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1]), near]); }
      }
      if (out.length < 3) return;
      ctx.beginPath();
      out.forEach((c, i) => { const sx = cam.cx + cam.f * c[0] / c[2], sy = cam.cy - cam.f * c[1] / c[2]; if (i) ctx.lineTo(sx, sy); else ctx.moveTo(sx, sy); });
      ctx.closePath(); ctx.fill();
    }
    poly(ctx, cam, pts, close) {
      for (let i = 0; i + 1 < pts.length; i++) this.seg(ctx, cam, pts[i], pts[i + 1]);
      if (close && pts.length > 2) this.seg(ctx, cam, pts[pts.length - 1], pts[0]);
    }
    groundLine(ctx, cam, a, b, wd, alpha) {   // línea pintada en el césped, con su anchura real
      const dx = b[0] - a[0], dy = b[1] - a[1], n = Math.hypot(dx, dy) || 1, ox = -dy / n * wd / 2, oy = dx / n * wd / 2;
      if (alpha != null) {   // muy cerca de la cámara se desvanece
        const depth = V.dot(V.sub([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, 0], cam.pos), cam.fwd);
        const k = alpha * smooth(1.4, 5, depth); if (k < 0.02) return;
        ctx.fillStyle = `rgba(244,247,241,${k.toFixed(3)})`;
      }
      this.fillPoly(ctx, cam, [[a[0] + ox, a[1] + oy, 0], [b[0] + ox, b[1] + oy, 0], [b[0] - ox, b[1] - oy, 0], [a[0] - ox, a[1] - oy, 0]]);
    }
    pitchLines(D) { // marcas reglamentarias del fondo, sobre z = 0; cada elemento es una polilínea
      const L = [];
      L.push([[D, -45, 0], [D, 45, 0]]);
      for (const [dx, hw] of [[16.5, 20.16], [5.5, 9.16]]) L.push([[D, -hw, 0], [D - dx, -hw, 0], [D - dx, hw, 0], [D, hw, 0]]);
      const a0 = Math.acos(5.5 / 9.15), arc = [];
      for (let i = 0; i <= 24; i++) { const a = -a0 + 2 * a0 * i / 24; arc.push([D - 11 - 9.15 * Math.cos(a), 9.15 * Math.sin(a), 0]); }
      L.push(arc);
      return L;
    }
    ballView(cam) {   // orientación del balón: reposo y, en vuelo, girando sobre su eje real (a ritmo visible)
      const L = this.fl && this.fl.main && this.fl.main.launch;
      let ax = null, ang = 0;
      if (!this.hero && L && !L.lowSpin && this.t != null && this.t > 0) {
        const w = [L.rifle || 0, L.top || 0, L.side || 0], n = Math.hypot(w[0], w[1], w[2]);
        if (n > 60) { ax = w.map((x) => x / n); ang = 2 * Math.PI * Math.min(1.6, n / 400) * this.t / (this.playRate || this.rate); }
      }
      return (v) => {
        let q = V.rot(v, REST_AXIS, REST_ANG);
        if (ax) q = V.rot(q, ax, ang);
        return [V.dot(q, cam.right), V.dot(q, cam.up), -V.dot(q, cam.fwd)];
      };
    }

    // ---------- vista desde detrás: la del lanzador al preparar el chute, la perspectiva elevada con el resultado
    drawBehind(ctx, w, h) {
      const D = this.goalDist, cam = this.camera(w, h), fl = this.fl, hero = this.hero;
      const hz = this.proj(cam, [4000, 0, 0]);
      const hy = hz ? Math.max(0, Math.min(h, hz[1])) : h * 0.3;
      // cielo y césped
      const sky = ctx.createLinearGradient(0, 0, 0, Math.max(1, hy));
      sky.addColorStop(0, '#031A10'); sky.addColorStop(1, '#0F422E');
      ctx.fillStyle = sky; ctx.fillRect(0, 0, w, hy + 1);
      ctx.fillStyle = C.g2; ctx.fillRect(0, hy, w, h - hy);
      const W = 5.5;
      ctx.fillStyle = C.g1;
      for (let k = -4; k < 14; k += 2) {       // franjas de siega, alineadas con la línea de gol
        const x1 = D - k * W, x0 = x1 - W;
        this.fillPoly(ctx, cam, [[x0, -70, 0], [x1, -70, 0], [x1, 70, 0], [x0, 70, 0]]);
      }
      const haze = ctx.createLinearGradient(0, hy, 0, h);   // aire: más claro a lo lejos
      haze.addColorStop(0, 'rgba(206,236,216,0.20)'); haze.addColorStop(0.3, 'rgba(206,236,216,0.04)'); haze.addColorStop(1, 'rgba(0,22,12,0.12)');
      ctx.fillStyle = haze; ctx.fillRect(0, hy, w, h - hy);
      // grada al fondo
      { const x0 = D + 13, x1 = D + 27, Y = 70;
        ctx.fillStyle = '#0B2C1F'; this.fillPoly(ctx, cam, [[x0, -Y, 0], [x0, Y, 0], [x0, Y, 1.1], [x0, -Y, 1.1]]);
        ctx.fillStyle = '#072318'; this.fillPoly(ctx, cam, [[x0, -Y, 1.1], [x0, Y, 1.1], [x1, Y, 10], [x1, -Y, 10]]);
        ctx.strokeStyle = 'rgba(244,247,241,0.07)'; ctx.lineWidth = 1; ctx.beginPath();
        for (let i = 1; i < 14; i++) { const t = i / 14; this.seg(ctx, cam, [x0 + (x1 - x0) * t, -Y, 1.1 + 8.9 * t], [x0 + (x1 - x0) * t, Y, 1.1 + 8.9 * t]); }
        ctx.stroke();
        ctx.strokeStyle = 'rgba(244,247,241,0.25)'; ctx.beginPath(); this.seg(ctx, cam, [x0, -Y, 1.1], [x0, Y, 1.1]); ctx.stroke(); }
      // líneas del campo, con su anchura real (12 cm)
      for (const pl of this.pitchLines(D)) for (let i = 0; i + 1 < pl.length; i++) this.groundLine(ctx, cam, pl[i], pl[i + 1], 0.12, 0.9);
      ctx.fillStyle = 'rgba(244,247,241,0.9)';
      { const ring = []; for (let i = 0; i < 16; i++) { const a = 2 * Math.PI * i / 16; ring.push([D - 11 + 0.16 * Math.cos(a), 0.16 * Math.sin(a), 0]); } this.fillPoly(ctx, cam, ring); }
      // portería: sombra, red y marco
      const hw = GOAL_W / 2;
      ctx.fillStyle = 'rgba(0,18,10,0.22)'; this.fillPoly(ctx, cam, [[D, -hw, 0], [D, hw, 0], [D + 2, hw, 0], [D + 2, -hw, 0]]);
      ctx.fillStyle = 'rgba(244,247,241,0.06)'; this.fillPoly(ctx, cam, [[D + 0.9, -hw, GOAL_H], [D + 0.9, hw, GOAL_H], [D + 2, hw, 0], [D + 2, -hw, 0]]);
      ctx.strokeStyle = 'rgba(244,247,241,0.3)'; ctx.lineWidth = 1; ctx.beginPath();
      for (let i = 0; i <= 10; i++) { const y = -hw + GOAL_W * i / 10; this.seg(ctx, cam, [D + 0.9, y, GOAL_H], [D + 2, y, 0]); this.seg(ctx, cam, [D, y, GOAL_H], [D + 0.9, y, GOAL_H]); }
      for (const z of [0, 0.6, 1.2, 1.8]) this.seg(ctx, cam, [D + 2 - z * 0.45, -hw, z], [D + 2 - z * 0.45, hw, z]);
      for (const y of [-hw, hw]) { this.seg(ctx, cam, [D, y, GOAL_H], [D + 0.9, y, GOAL_H]); this.seg(ctx, cam, [D + 0.9, y, GOAL_H], [D + 2, y, 0]); this.seg(ctx, cam, [D, y, 0], [D + 2, y, 0]); }
      ctx.stroke();
      const gz = this.proj(cam, [D, 0, 1.2]), postW = gz ? Math.max(2.2, Math.min(7, cam.f * 0.12 / gz[2])) : 2.4;
      const drawFrame = () => {
        ctx.setLineDash([]); ctx.lineCap = 'butt';
        ctx.strokeStyle = '#C9D3CD'; ctx.lineWidth = postW; ctx.beginPath();
        this.poly(ctx, cam, [[D, -hw, 0], [D, -hw, GOAL_H], [D, hw, GOAL_H], [D, hw, 0]], false); ctx.stroke();
        ctx.strokeStyle = C.chalk; ctx.lineWidth = postW * 0.6; ctx.beginPath();
        this.poly(ctx, cam, [[D, -hw + 0.02, 0], [D, -hw + 0.02, GOAL_H + 0.02], [D, hw + 0.02, GOAL_H + 0.02], [D, hw + 0.02, 0]], false); ctx.stroke();
        ctx.lineCap = 'round';
      };

      const main = fl && !hero ? fl.main : null;
      const tNow = this.t, anim = tNow != null;
      const cutX = this.cutX();
      const tEnd = anim ? Math.max(0, tNow) : Infinity;
      const tCut = this.meta.recordedS == null ? Infinity : this.meta.recordedS;
      // trazo con anchura en perspectiva (una cinta de unos centímetros); discontinuo según la distancia recorrida
      const track = (tr, from, to, o) => {
        let dist = 0, prev = null, open = false, curW = -1;
        const flush = () => { if (open) { ctx.stroke(); open = false; } };
        ctx.strokeStyle = o.color; ctx.setLineDash([]);
        for (let i = 0; i < tr.T.length; i += 2) {
          const t = tr.T[i], x = tr.X[i];
          if (t > o.tEnd || x > o.xMax) break;
          const p = [x, tr.Y[i], o.ground ? 0.004 : tr.Z[i]];
          if (prev) {
            dist += Math.hypot(p[0] - prev[0], p[1] - prev[1], p[2] - prev[2]);
            const xm = (p[0] + prev[0]) / 2;
            const inPart = !o.part || (o.part === 'medido' ? t <= tCut + 1e-9 : t >= tCut - 0.004);
            const onDash = !o.dash || Math.floor(dist / o.dash) % 2 === 0;
            const A = inPart && onDash && xm >= from && xm < to ? this.proj(cam, prev) : null, B = A ? this.proj(cam, p) : null;
            if (A && B) {
              // tramos seguidos con el mismo grosor (a medio píxel) van en un solo trazo
              const lw = Math.round(2 * Math.max(o.minW, Math.min(o.maxW, cam.f * o.width / ((A[2] + B[2]) / 2)))) / 2;
              if (!open || lw !== curW) { flush(); ctx.lineWidth = curW = lw; ctx.beginPath(); ctx.moveTo(A[0], A[1]); open = true; }
              ctx.lineTo(B[0], B[1]);
            } else flush();
          }
          prev = p;
        }
        flush();
      };
      const drawPath = (from, to) => {
        if (!main) return;
        track(main, from, to, { color: C.trace, width: 0.06, minW: 2.6, maxW: 9, part: 'medido', tEnd, xMax: cutX });
        track(main, from, to, { color: C.trace, width: 0.045, minW: 2, maxW: 7, part: 'proyectado', dash: 0.55, tEnd, xMax: cutX });
      };
      const drawBall = (b) => {
        const P = this.proj(cam, [b.x, b.y, b.z]), S = this.proj(cam, [b.x, b.y, 0]);
        if (!P) return;
        const k = 1 + 1.1 * smooth(3, 14, P[2]);            // de lejos, algo más grande para que se vea
        const r = Math.max(2.6, cam.f * RB * k / P[2]);
        if (S) groundShadow(ctx, S[0], S[1], r * 1.25, r * 0.42, b.z < 0.5 ? 0.55 : 0.32);
        if (r >= 5) drawBall3D(ctx, P[0], P[1], r, this.ballView(cam), this.lightFor(cam));
        else { ctx.fillStyle = C.ball; ctx.beginPath(); ctx.arc(P[0], P[1], r, 0, Math.PI * 2); ctx.fill(); ctx.strokeStyle = C.ink; ctx.lineWidth = 1; ctx.stroke(); }
      };
      const drawWall = () => {
        if (!this.showWall || D < WALL_X + 2) return;
        ctx.fillStyle = 'rgba(244,247,241,0.75)'; this.groundLine(ctx, cam, [WALL_X, -1.7, 0], [WALL_X, 1.7, 0], 0.06);
        for (const y of WALL_YS) {
          const B = this.proj(cam, [WALL_X, y, 0]); if (!B) continue;
          const s = cam.f / B[2]; groundShadow(ctx, B[0], B[1], 0.36 * s, 0.13 * s + 1, 0.5);
        }
        for (const y of WALL_YS) {
          const B = this.proj(cam, [WALL_X, y, 0]), T = this.proj(cam, [WALL_X, y, 1.58]), H = this.proj(cam, [WALL_X, y, 1.69]);
          if (!B || !T || !H) continue;
          const s = cam.f / B[2], bw = 0.46 * s;
          const x0 = B[0] - bw / 2, y0 = T[1], hh = B[1] - T[1], rr = Math.min(bw * 0.3, 8);
          const gr = ctx.createLinearGradient(x0, 0, x0 + bw, 0);
          gr.addColorStop(0, '#6A9AF4'); gr.addColorStop(0.42, C.wall); gr.addColorStop(1, '#1D469E');
          ctx.fillStyle = gr; ctx.beginPath();
          ctx.moveTo(x0, y0 + hh); ctx.lineTo(x0, y0 + rr); ctx.quadraticCurveTo(x0, y0, x0 + rr, y0);
          ctx.lineTo(x0 + bw - rr, y0); ctx.quadraticCurveTo(x0 + bw, y0, x0 + bw, y0 + rr); ctx.lineTo(x0 + bw, y0 + hh); ctx.closePath(); ctx.fill();
          const hr = 0.115 * s, hg = ctx.createRadialGradient(H[0] - hr * 0.35, H[1] - hr * 0.35, hr * 0.1, H[0], H[1], hr);
          hg.addColorStop(0, '#D7E4FC'); hg.addColorStop(1, '#6F94D8');
          ctx.fillStyle = hg; ctx.beginPath(); ctx.arc(H[0], H[1], hr, 0, Math.PI * 2); ctx.fill();
        }
      };
      const b = this.ballNow();
      const land = main && main.land && !anim && main.land.x <= cutX ? main.land : null;
      const drawLand = () => {
        const ring = [];
        for (let i = 0; i <= 20; i++) { const a = 2 * Math.PI * i / 20; ring.push([land.x + 0.45 * Math.cos(a), land.y + 0.45 * Math.sin(a), 0]); }
        ctx.strokeStyle = C.trace; ctx.lineWidth = 1.6; ctx.beginPath(); this.poly(ctx, cam, ring, false); ctx.stroke();
      };
      // el mismo chute sin efecto
      if (fl && !hero && !anim) track(fl.noSpin, -Infinity, Infinity, { color: 'rgba(244,247,241,0.55)', width: 0.02, minW: 1.3, maxW: 3, dash: 0.35, tEnd: Infinity, xMax: Infinity });
      // sombra de la trayectoria en el suelo
      if (main) track(main, -Infinity, Infinity, { color: 'rgba(3,20,13,0.42)', width: 0.05, minW: 1.6, maxW: 7, ground: true, tEnd, xMax: cutX });
      // de lejos a cerca: detrás de la portería, el marco, hasta la barrera, la barrera y lo de delante
      drawPath(D, Infinity);
      if (land && land.x >= D) drawLand();
      if (b.x >= D) drawBall(b);
      drawFrame();
      drawPath(WALL_X, D);
      if (land && land.x < D) drawLand();
      if (b.x >= WALL_X && b.x < D) drawBall(b);
      if (!hero && this.blend >= 1) { const ring = []; for (let i = 0; i <= 18; i++) { const a = 2 * Math.PI * i / 18; ring.push([0.3 * Math.cos(a), 0.3 * Math.sin(a), 0]); }
        ctx.strokeStyle = 'rgba(244,247,241,0.75)'; ctx.lineWidth = 1.2; ctx.beginPath(); this.poly(ctx, cam, ring, false); ctx.stroke(); }
      drawWall();
      drawPath(-Infinity, WALL_X);
      if (b.x < WALL_X) drawBall(b);
      // viñeta
      const vg = ctx.createRadialGradient(w / 2, h * 0.55, Math.min(w, h) * 0.38, w / 2, h * 0.55, Math.max(w, h) * 0.85);
      vg.addColorStop(0, 'rgba(2,14,9,0)'); vg.addColorStop(1, 'rgba(2,14,9,0.4)');
      ctx.fillStyle = vg; ctx.fillRect(0, 0, w, h);
      if (!hero && !this.captionOff) this.text(ctx, this.caption(), 10, 17, 'left', C.chalkDim, 11);
    }
    lightFor(cam) {   // luz del mundo (arriba, detrás y a la izquierda del lanzador) en coordenadas de la cámara
      const Lw = V.unit([-0.55, 0.45, 0.7]);
      return V.unit([V.dot(Lw, cam.right), V.dot(Lw, cam.up), -V.dot(Lw, cam.fwd)]);
    }

    // ---------- utilidades de las vistas planas
    reach() {
      const fl = this.fl; if (!fl) return 0;
      const m = fl.main; return m.land ? m.land.x : m.X[m.X.length - 1];
    }
    text(ctx, s, x, y, align, color, size) {
      ctx.font = (size || 12) + 'px ' + FONT; ctx.textAlign = align || 'center'; ctx.fillStyle = color || C.chalk; ctx.fillText(s, x, y);
    }

    // ---------- vista lateral (perfil de alturas)
    drawSide(ctx, w, h) {
      const D = this.goalDist, fl = this.fl, main = fl ? fl.main : null;
      const xmin = -1.5, xmax = Math.max(D + 3.5, Math.min(this.reach(), 70) + 2.5);
      let zTop = 3.2;
      if (fl) for (const tr of [fl.main, fl.noSpin].concat(fl.alts)) zTop = Math.max(zTop, tr.apex.z + 0.5);
      zTop = Math.min(zTop, 14);
      const padL = 12, padR = 12, padT = 24, padB = 30;
      const sc = (w - padL - padR) / (xmax - xmin);
      const vex = Math.max(1, Math.min(3, Math.floor(2 * (h - padT - padB) / (zTop * sc)) / 2));   // ampliación vertical
      const gy = h - padB, X = (x) => padL + (x - xmin) * sc, Z = (z) => gy - z * sc * vex;
      ctx.fillStyle = C.sky; ctx.fillRect(0, 0, w, gy);
      ctx.fillStyle = C.g1; ctx.fillRect(0, gy, w, h - gy);
      ctx.strokeStyle = C.chalk; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(w, gy); ctx.stroke();
      // referencias de altura
      ctx.strokeStyle = 'rgba(244,247,241,0.12)'; ctx.lineWidth = 1;
      for (let z = 1; z <= zTop; z++) { ctx.beginPath(); ctx.moveTo(0, Z(z)); ctx.lineTo(w, Z(z)); ctx.stroke(); }
      this.text(ctx, '1 m', 4, Z(1) - 3, 'left', C.chalkDim, 10);
      if (zTop >= 3) this.text(ctx, '3 m', 4, Z(3) - 3, 'left', C.chalkDim, 10);
      // distancias
      const taken = [];
      const label = (x, s, strong) => { if (taken.some((t) => Math.abs(t - X(x)) < 30)) return; taken.push(X(x)); this.text(ctx, s, X(x), gy + 18, 'center', strong ? C.chalk : C.chalkDim, strong ? 12 : 11); };
      if (this.showWall && D >= WALL_X + 2) {
        ctx.fillStyle = C.wall; ctx.fillRect(X(WALL_X) - 3, Z(1.58), 6, Z(0) - Z(1.58));
        ctx.fillStyle = C.wallHead; ctx.beginPath(); ctx.arc(X(WALL_X), Z(1.69), 3.4, 0, Math.PI * 2); ctx.fill();
        label(WALL_X, 'barrera', true);
      }
      ctx.strokeStyle = C.chalk; ctx.lineWidth = 2.4; ctx.beginPath(); ctx.moveTo(X(D), Z(0)); ctx.lineTo(X(D), Z(GOAL_H)); ctx.lineTo(X(D + 0.9), Z(GOAL_H)); ctx.stroke();
      ctx.strokeStyle = 'rgba(244,247,241,0.35)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(X(D + 0.9), Z(GOAL_H)); ctx.lineTo(X(D + 2), Z(0)); ctx.stroke();
      label(D, es(D, 0) + ' m', true);
      for (let x = 5; x < xmax - 1; x += 5) {
        ctx.strokeStyle = C.chalkDim; ctx.beginPath(); ctx.moveTo(X(x), gy); ctx.lineTo(X(x), gy + 4); ctx.stroke();
        label(x, String(x));
      }
      if (vex > 1) this.text(ctx, 'altura ampliada ×' + es(vex, vex % 1 ? 1 : 0), w - 8, 14, 'right', C.chalkDim, 11);
      if (!this.captionOff) this.text(ctx, this.caption(), 8, 14, 'left', C.chalkDim, 11);
      if (!fl) { this.ballSide(ctx, X(0), Z(RB)); return; }
      const anim = this.t != null;
      if (!anim) {
        // margen por el ángulo de salida: las dos variantes extremas, en fino
        let loT = null, hiT = null;
        for (const tr of fl.alts) { if (!loT || tr.apex.z < loT.apex.z) loT = tr; if (!hiT || tr.apex.z > hiT.apex.z) hiT = tr; }
        if (loT && hiT && hiT.apex.z - loT.apex.z > 0.3) {
          ctx.strokeStyle = C.traceDim; ctx.lineWidth = 1.3;
          for (const tr of [loT, hiT]) {
            ctx.beginPath();
            for (let i = 0; i < tr.T.length; i++) { if (tr.X[i] > xmax) break; if (i) ctx.lineTo(X(tr.X[i]), Z(tr.Z[i])); else ctx.moveTo(X(tr.X[i]), Z(tr.Z[i])); }
            ctx.stroke();
          }
        }
        // sin efecto
        const g = fl.noSpin; ctx.strokeStyle = C.chalkDim; ctx.lineWidth = 1.5; ctx.setLineDash([3, 5]); ctx.beginPath();
        for (let i = 0; i < g.T.length; i++) { if (g.X[i] > xmax) break; if (i) ctx.lineTo(X(g.X[i]), Z(g.Z[i])); else ctx.moveTo(X(g.X[i]), Z(g.Z[i])); }
        ctx.stroke(); ctx.setLineDash([]);
      }
      const tCut = this.meta.recordedS == null ? Infinity : this.meta.recordedS, tEnd = anim ? Math.max(0, this.t) : Infinity;
      for (const part of ['medido', 'proyectado']) {
        ctx.strokeStyle = C.trace; ctx.lineWidth = part === 'medido' ? 3 : 2.2; ctx.setLineDash(part === 'medido' ? [] : [5, 5]); ctx.beginPath();
        let started = false;
        for (let i = 0; i < main.T.length; i++) {
          const t = main.T[i]; if (t > tEnd || main.X[i] > xmax || main.X[i] > this.cutX()) break;
          if (!(part === 'medido' ? t <= tCut + 1e-9 : t >= tCut - 0.004)) { started = false; continue; }
          if (!started) { ctx.moveTo(X(main.X[i]), Z(main.Z[i])); started = true; } else ctx.lineTo(X(main.X[i]), Z(main.Z[i]));
        }
        ctx.stroke();
      }
      ctx.setLineDash([]);
      if (!anim) {
        const ap = main.apex;
        if (ap.x < xmax && ap.x <= this.cutX()) { ctx.fillStyle = C.trace; ctx.beginPath(); ctx.arc(X(ap.x), Z(ap.z), 3, 0, Math.PI * 2); ctx.fill(); this.text(ctx, es(ap.z) + ' m', X(ap.x), Z(ap.z) - 8, 'center', C.chalk, 12); }
        if (main.land && main.land.x < xmax && main.land.x <= this.cutX()) { ctx.strokeStyle = C.trace; ctx.lineWidth = 1.6; ctx.beginPath(); ctx.ellipse(X(main.land.x), gy, 6, 2.4, 0, 0, Math.PI * 2); ctx.stroke(); }
        if (this.meta.hitS != null) { const q = SB.flightAtT(main, this.meta.hitS); if (q.x < xmax && q.x <= this.cutX()) { ctx.strokeStyle = C.chalk; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(X(q.x), Z(q.z), 5, 0, Math.PI * 2); ctx.stroke(); } }
      }
      const b = this.ballNow();
      ctx.strokeStyle = C.chalkDim; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.arc(X(0), Z(RB), 4.2, 0, Math.PI * 2); ctx.stroke();
      if (b.x <= xmax) this.ballSide(ctx, X(b.x), Z(b.z));
    }
    ballSide(ctx, x, y) { ctx.fillStyle = C.ball; ctx.beginPath(); ctx.arc(x, y, 4.2, 0, Math.PI * 2); ctx.fill(); ctx.strokeStyle = C.ink; ctx.lineWidth = 1; ctx.stroke(); }

    // ---------- vista desde arriba
    drawTop(ctx, w, h) {
      const D = this.goalDist, fl = this.fl, main = fl ? fl.main : null;
      const xmin = -2, xmax = Math.max(D + 4, Math.min(this.reach(), 70) + 2.5);
      const sc = w / (xmax - xmin), cy = h / 2;
      const X = (x) => (x - xmin) * sc, Y = (y) => cy - y * sc;
      ctx.fillStyle = C.g2; ctx.fillRect(0, 0, w, h);
      for (let k = -2; k < 16; k += 2) { const x1 = D - k * 5.5, x0 = x1 - 5.5; ctx.fillStyle = C.g1; ctx.fillRect(X(x0), 0, 5.5 * sc, h); }
      ctx.strokeStyle = 'rgba(244,247,241,0.88)'; ctx.lineWidth = 1.5; ctx.beginPath();
      for (const pl of this.pitchLines(D)) { pl.forEach((p, i) => { if (i) ctx.lineTo(X(p[0]), Y(p[1])); else ctx.moveTo(X(p[0]), Y(p[1])); }); }
      ctx.stroke();
      const hw = GOAL_W / 2;
      ctx.strokeStyle = 'rgba(244,247,241,0.35)'; ctx.lineWidth = 1; ctx.strokeRect(X(D), Y(hw), 2 * sc, GOAL_W * sc);
      ctx.fillStyle = C.chalk; for (const y of [-hw, hw]) { ctx.beginPath(); ctx.arc(X(D), Y(y), 3, 0, Math.PI * 2); ctx.fill(); }
      if (this.showWall && D >= WALL_X + 2) { ctx.strokeStyle = C.wall; ctx.lineWidth = 6; ctx.lineCap = 'butt'; ctx.beginPath(); ctx.moveTo(X(WALL_X), Y(-1.16)); ctx.lineTo(X(WALL_X), Y(1.16)); ctx.stroke(); ctx.lineCap = 'round'; }
      if (!this.captionOff) { const cap = this.caption(); ctx.font = '11px ' + FONT; const tw = ctx.measureText(cap).width;
        ctx.fillStyle = 'rgba(6,40,27,0.78)'; ctx.fillRect(0, 0, tw + 16, 22); this.text(ctx, cap, 8, 15, 'left', 'rgba(244,247,241,0.72)', 11); }
      // línea de salida (sin efecto no se desvía)
      ctx.strokeStyle = C.chalkDim; ctx.lineWidth = 1.5; ctx.setLineDash([3, 5]); ctx.beginPath(); ctx.moveTo(X(0), Y(0)); ctx.lineTo(X(xmax), Y(0)); ctx.stroke(); ctx.setLineDash([]);
      if (!fl) { this.ballSide(ctx, X(0), Y(0)); return; }
      const anim = this.t != null, tCut = this.meta.recordedS == null ? Infinity : this.meta.recordedS, tEnd = anim ? Math.max(0, this.t) : Infinity;
      for (const part of ['medido', 'proyectado']) {
        ctx.strokeStyle = C.trace; ctx.lineWidth = part === 'medido' ? 3 : 2.2; ctx.setLineDash(part === 'medido' ? [] : [5, 5]); ctx.beginPath();
        let started = false;
        for (let i = 0; i < main.T.length; i++) {
          const t = main.T[i]; if (t > tEnd || main.X[i] > xmax || main.X[i] > this.cutX()) break;
          if (!(part === 'medido' ? t <= tCut + 1e-9 : t >= tCut - 0.004)) { started = false; continue; }
          if (!started) { ctx.moveTo(X(main.X[i]), Y(main.Y[i])); started = true; } else ctx.lineTo(X(main.X[i]), Y(main.Y[i]));
        }
        ctx.stroke();
      }
      ctx.setLineDash([]);
      if (!anim) {
        if (main.land && main.land.x < xmax && main.land.x <= this.cutX()) { ctx.strokeStyle = C.trace; ctx.lineWidth = 1.6; ctx.beginPath(); ctx.arc(X(main.land.x), Y(main.land.y), 5, 0, Math.PI * 2); ctx.stroke(); }
        const q = SB.flightAtX(main, D);
        if (q && Math.abs(q.y) > 0.25) { // desvío al llegar a la portería
          ctx.strokeStyle = C.chalk; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(X(D) - 7, Y(0)); ctx.lineTo(X(D) - 7, Y(q.y)); ctx.stroke();
          this.text(ctx, es(Math.abs(q.y)) + ' m', X(D) - 12, q.y > 0 ? Y(0) + 16 : Y(0) - 8, 'right', C.chalk, 12);
        }
      }
      const b = this.ballNow();
      ctx.strokeStyle = C.chalkDim; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.arc(X(0), Y(0), 4.2, 0, Math.PI * 2); ctx.stroke();
      if (b.x <= xmax) this.ballSide(ctx, X(b.x), Y(b.y));
    }
  }

  // ------------------------------------------------------------------ balón girando (visto desde detrás)
  class SpinBall {
    constructor(canvas) { this.cv = canvas; this.axis = null; this.rps = 0; this.angle = 0; this.raf = 0; this.last = null; }
    // axis: vector unitario en el mundo (regla de la mano derecha) o null; rpm real; slow: cuántas veces más lento
    set(axis, rpm, slow) {
      this.axis = axis; this.rps = axis ? (rpm / 60) / (slow || 20) : 0; this.angle = 0; this.last = null;
      this.stop(); this.draw();
      if (axis && this.rps > 0.004 && !reducedMotion() && typeof requestAnimationFrame === 'function') {
        const step = (ts) => {
          if (!this.cv.isConnected || this.cv.offsetParent === null) { this.raf = 0; return; }   // oculto: se para
          if (this.last != null) this.angle += 2 * Math.PI * this.rps * Math.min(0.1, (ts - this.last) / 1000);
          this.last = ts; this.draw(); this.raf = requestAnimationFrame(step);
        };
        this.raf = requestAnimationFrame(step);
      }
    }
    stop() { if (this.raf) { cancelAnimationFrame(this.raf); this.raf = 0; } }
    draw() {
      const f = fit(this.cv); if (!f) return;
      const { ctx, w, h } = f, cx = w / 2, cy = h * 0.46, R = Math.min(w, h) * 0.32;
      const a = this.axis;
      groundShadow(ctx, cx, cy + R * 1.18, R * 0.95, R * 0.17, 0.5);
      // en pantalla: x = −y del mundo, arriba = z, hacia quien mira = −x
      const toView = (v) => { const q = a ? V.rot(v, a, this.angle) : v; return [-q[1], q[2], -q[0]]; };
      const ex = a ? -a[1] : 0, ey = a ? a[2] : 0, ez = a ? -a[0] : 0, side = Math.hypot(ex, ey) > 0.25, L = R * 1.4;
      if (a && side) { ctx.strokeStyle = 'rgba(244,247,241,0.85)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(cx - ex * L, cy + ey * L); ctx.lineTo(cx + ex * L, cy - ey * L); ctx.stroke(); }
      drawBall3D(ctx, cx, cy, R, toView);
      if (a && side) {   // la parte del eje que sale hacia quien mira, por delante del balón
        const s = ez >= 0 ? 1 : -1;
        ctx.strokeStyle = C.chalk; ctx.lineWidth = 2.6; ctx.beginPath(); ctx.moveTo(cx + s * ex * R * 0.98, cy - s * ey * R * 0.98); ctx.lineTo(cx + s * ex * L, cy - s * ey * L); ctx.stroke();
        ctx.fillStyle = C.chalk; ctx.beginPath(); ctx.arc(cx + s * ex * L, cy - s * ey * L, 3.2, 0, Math.PI * 2); ctx.fill();
      }
      if (a && !side) { ctx.strokeStyle = C.trace; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.arc(cx, cy, 6, 0, Math.PI * 2); ctx.stroke(); }
    }
  }

  // ------------------------------------------------------------------ punto de golpeo (visto desde detrás)
  const STRIKE_AXIS = V.unit([0.2, 0.7, 0.5]), STRIKE_ANG = 0.5;
  function drawStrike(canvas, sp) {
    const f = fit(canvas); if (!f) return;
    const { ctx, w, h } = f, cx = w / 2, cy = h * 0.46, R = Math.min(w, h) * 0.32;
    groundShadow(ctx, cx, cy + R * 1.18, R * 0.95, R * 0.17, 0.5);
    drawBall3D(ctx, cx, cy, R, (v) => { const q = V.rot(v, STRIKE_AXIS, STRIKE_ANG); return [-q[1], q[2], -q[0]]; });
    ctx.strokeStyle = 'rgba(10,30,22,0.55)'; ctx.lineWidth = 1.2; ctx.setLineDash([3, 4]);
    ctx.beginPath(); ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy); ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R); ctx.stroke(); ctx.setLineDash([]);
    if (!sp) return;
    let dx = sp.right / RB, dy = sp.up / RB; const n = Math.hypot(dx, dy);
    if (n > 0.86) { dx *= 0.86 / n; dy *= 0.86 / n; }
    const px = cx + dx * R, py = cy - dy * R;
    ctx.strokeStyle = 'rgba(10,30,22,0.55)'; ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(px, py, 14, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = C.trace; ctx.lineWidth = 2.2; ctx.stroke();
    ctx.fillStyle = C.trace; ctx.beginPath(); ctx.arc(px, py, 7.5, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = C.ink; ctx.lineWidth = 1.5; ctx.stroke();
  }

  root.SBScene = { PitchScene, SpinBall, drawStrike, drawBall3D, fit, colors: C, es };
})(typeof self !== 'undefined' ? self : this);
