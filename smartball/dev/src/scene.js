/* scene.js — dibujo en canvas: el campo con la trayectoria (tres vistas), el balón girando y el punto de golpeo.
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
  const reducedMotion = () => !!(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const es = (x, d) => (x == null || !isFinite(x) ? '—' : x.toFixed(d == null ? 1 : d).replace('.', ','));

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

  // ------------------------------------------------------------------ escena del campo
  class PitchScene {
    constructor(canvas) {
      this.cv = canvas; this.view = 'behind'; this.fl = null; this.meta = {};
      this.goalDist = 20; this.showWall = true;
      this.t = null;            // instante de la animación (s desde el golpeo); null = trayectoria completa
      this.raf = 0; this.rate = 0.5; this.onEnd = null;
    }
    setContext(goalDist, showWall) { this.goalDist = goalDist; this.showWall = showWall; this.findCut(); this.draw(); }
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
    setFlight(fl, meta) { this.stop(); this.fl = fl; this.meta = meta || {}; this.t = null; this.findCut(); this.draw(); }
    endTime() { const m = this.fl.main; return Math.min(this.cut ? this.cut.t : m.T[m.T.length - 1], 6); }
    cutX() { return this.cut ? this.cut.x : Infinity; }
    stop() { if (this.raf) { cancelAnimationFrame(this.raf); this.raf = 0; } }
    play() {
      this.stop();
      if (!this.fl) return;
      if (reducedMotion() || typeof requestAnimationFrame !== 'function') { this.t = null; this.draw(); return; }
      const end = this.endTime(), rate = Math.max(this.rate, end / 3.2);   // a cámara lenta, pero sin eternizarse
      let last = null; this.t = 0;
      const step = (ts) => {
        if (last == null) last = ts;
        this.t += (ts - last) / 1000 * rate; last = ts;
        if (this.t >= end) { this.t = null; this.raf = 0; this.draw(); if (this.onEnd) this.onEnd(); return; }
        this.draw();
        this.raf = requestAnimationFrame(step);
      };
      this.raf = requestAnimationFrame(step);
    }
    // Instante fijado desde fuera (vídeo): t < 0 deja el balón en el punto de golpeo.
    setTime(t) { this.stop(); this.t = t; this.draw(); }
    draw() {
      const f = fit(this.cv); if (!f) return;
      if (this.view === 'side') this.drawSide(f.ctx, f.w, f.h);
      else if (this.view === 'top') this.drawTop(f.ctx, f.w, f.h);
      else this.drawBehind(f.ctx, f.w, f.h);
    }
    ballNow() {
      if (!this.fl) return { x: 0, y: 0, z: RB, t: 0 };
      if (this.t == null) {
        if (this.cut) return { ...this.cut, rest: true };
        const m = this.fl.main, n = m.T.length - 1; return { x: m.X[n], y: m.Y[n], z: m.Z[n], t: m.T[n], rest: true };
      }
      if (this.t <= 0) return { x: 0, y: 0, z: RB, t: 0 };
      return SB.flightAtT(this.fl.main, Math.min(this.t, this.endTime()));
    }
    // Tramo medido (línea continua) y proyectado (discontinua): índices de corte de la trayectoria principal.
    cutIndex(tr, tCut) { let i = 0; while (i < tr.T.length - 1 && tr.T[i] < tCut) i++; return i; }

    // ---------- vista desde detrás (perspectiva)
    camera(w, h) {
      const key = w + 'x' + h + '/' + this.goalDist;
      if (this.camS == null || this.camKey !== key) { this.camKey = key; this.camS = this.fitCamera(w, h); }
      return this.makeCamera(w, h, this.camS);
    }
    makeCamera(w, h, s) {   // s = 1: encuadre normal; mayor: más lejos y más alta
      const D = this.goalDist, l0 = [D * 0.5, 0.6, 0.3];
      const look = [l0[0], l0[1], l0[2] + (s - 1) * 2.4];
      const pos = V.add(look, V.mul(V.sub([-7.8, -4.6, 5.4], l0), s));
      const fwd = V.unit(V.sub(look, pos)), right = V.unit(V.cross(fwd, [0, 0, 1])), up = V.cross(right, fwd);
      const fov = 42 * Math.PI / 180;
      return { pos, fwd, right, up, f: (h / 2) / Math.tan(fov / 2), cx: w / 2, cy: h / 2 };
    }
    fitCamera(w, h) {
      const fl = this.fl; if (!fl) return 1;
      const m = fl.main, end = this.endTime(), pts = [];
      for (let i = 0; i < m.T.length; i += 4) { if (m.T[i] > end) break; pts.push([m.X[i], m.Y[i], m.Z[i]]); }
      for (let s = 1; s < 2.75; s += 0.125) {
        const cam = this.makeCamera(w, h, s);
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
    pitchLines(D) { // marcas reglamentarias del fondo, sobre z = 0; cada elemento es una polilínea
      const L = [];
      L.push([[D, -45, 0], [D, 45, 0]]);
      for (const [dx, hw] of [[16.5, 20.16], [5.5, 9.16]]) L.push([[D, -hw, 0], [D - dx, -hw, 0], [D - dx, hw, 0], [D, hw, 0]]);
      const a0 = Math.acos(5.5 / 9.15), arc = [];
      for (let i = 0; i <= 24; i++) { const a = -a0 + 2 * a0 * i / 24; arc.push([D - 11 - 9.15 * Math.cos(a), 9.15 * Math.sin(a), 0]); }
      L.push(arc);
      const spot = [];
      for (let i = 0; i <= 12; i++) { const a = 2 * Math.PI * i / 12; spot.push([D - 11 + 0.16 * Math.cos(a), 0.16 * Math.sin(a), 0]); }
      L.push(spot);
      return L;
    }
    drawBehind(ctx, w, h) {
      const D = this.goalDist, cam = this.camera(w, h), fl = this.fl;
      // cielo y césped
      const hz = this.proj(cam, [5000, 0, 0]);
      const hy = hz ? hz[1] : h * 0.3;
      ctx.fillStyle = C.sky; ctx.fillRect(0, 0, w, hy + 1);
      ctx.fillStyle = C.g2; ctx.fillRect(0, hy, w, h - hy);
      const W = 5.5;
      ctx.fillStyle = C.g1;
      for (let k = -4; k < 12; k += 2) {       // franjas de siega, alineadas con la línea de gol
        const x1 = D - k * W, x0 = x1 - W;
        this.fillPoly(ctx, cam, [[x0, -70, 0], [x1, -70, 0], [x1, 70, 0], [x0, 70, 0]]);
      }
      ctx.fillStyle = C.sky; ctx.fillRect(0, 0, w, hy);   // por encima del horizonte no hay césped
      // líneas
      ctx.strokeStyle = 'rgba(244,247,241,0.88)'; ctx.lineWidth = 1.5;
      ctx.beginPath(); for (const pl of this.pitchLines(D)) this.poly(ctx, cam, pl, false); ctx.stroke();
      // portería
      const hw = GOAL_W / 2;
      ctx.strokeStyle = 'rgba(244,247,241,0.3)'; ctx.lineWidth = 1; ctx.beginPath();
      for (let i = 0; i <= 6; i++) { const y = -hw + GOAL_W * i / 6; this.seg(ctx, cam, [D + 0.9, y, GOAL_H], [D + 2, y, 0]); this.seg(ctx, cam, [D, y, GOAL_H], [D + 0.9, y, GOAL_H]); }
      for (const z of [0, 0.8, 1.6]) this.seg(ctx, cam, [D + 2 - z * 0.45, -hw, z], [D + 2 - z * 0.45, hw, z]);
      for (const y of [-hw, hw]) { this.seg(ctx, cam, [D, y, GOAL_H], [D + 0.9, y, GOAL_H]); this.seg(ctx, cam, [D + 0.9, y, GOAL_H], [D + 2, y, 0]); this.seg(ctx, cam, [D, y, 0], [D + 2, y, 0]); }
      ctx.stroke();
      const drawFrame = () => {
        ctx.strokeStyle = C.chalk; ctx.lineWidth = 2.4; ctx.setLineDash([]); ctx.beginPath();
        this.poly(ctx, cam, [[D, -hw, 0], [D, -hw, GOAL_H], [D, hw, GOAL_H], [D, hw, 0]], false); ctx.stroke();
      };

      const main = fl ? fl.main : null;
      const tNow = this.t, anim = tNow != null;
      const cutX = this.cutX();
      const drawPath = (from, to) => { // tramo de la trayectoria con x en [from, to)
        if (!main) return;
        const tCut = this.meta.recordedS == null ? Infinity : this.meta.recordedS;
        const tEnd = anim ? Math.max(0, tNow) : Infinity;
        // sombra en el suelo
        ctx.strokeStyle = C.shadow; ctx.lineWidth = 2; ctx.setLineDash([]); ctx.beginPath();
        let started = false;
        for (let i = 0; i < main.T.length; i++) {
          if (main.T[i] > tEnd || main.X[i] > cutX) break;
          const x = main.X[i]; if (x < from || x >= to) { started = false; continue; }
          const P = this.proj(cam, [x, main.Y[i], 0]); if (!P) { started = false; continue; }
          if (!started) { ctx.moveTo(P[0], P[1]); started = true; } else ctx.lineTo(P[0], P[1]);
        }
        ctx.stroke();
        for (const part of ['medido', 'proyectado']) {
          ctx.strokeStyle = C.trace; ctx.lineWidth = part === 'medido' ? 3 : 2.2;
          ctx.setLineDash(part === 'medido' ? [] : [5, 5]); ctx.beginPath(); started = false;
          for (let i = 0; i < main.T.length; i++) {
            const t = main.T[i]; if (t > tEnd || main.X[i] > cutX) break;
            const inPart = part === 'medido' ? t <= tCut + 1e-9 : t >= tCut - 0.004;
            const x = main.X[i];
            if (!inPart || x < from || x >= to) { started = false; continue; }
            const P = this.proj(cam, [x, main.Y[i], main.Z[i]]); if (!P) { started = false; continue; }
            if (!started) { ctx.moveTo(P[0], P[1]); started = true; } else ctx.lineTo(P[0], P[1]);
          }
          ctx.stroke();
        }
        ctx.setLineDash([]);
      };
      const drawGhost = () => {  // el mismo chute sin efecto
        if (!fl || anim) return;
        const g = fl.noSpin;
        ctx.strokeStyle = C.chalkDim; ctx.lineWidth = 1.5; ctx.setLineDash([3, 5]); ctx.beginPath();
        let started = false;
        for (let i = 0; i < g.T.length; i += 2) {
          const P = this.proj(cam, [g.X[i], g.Y[i], g.Z[i]]); if (!P) { started = false; continue; }
          if (!started) { ctx.moveTo(P[0], P[1]); started = true; } else ctx.lineTo(P[0], P[1]);
        }
        ctx.stroke(); ctx.setLineDash([]);
      };
      const drawBall = (b) => {
        const P = this.proj(cam, [b.x, b.y, b.z]), S = this.proj(cam, [b.x, b.y, 0]);
        if (!P) return;
        const r = Math.max(2.6, cam.f * RB * 2.1 / P[2]);
        if (S) { ctx.fillStyle = C.shadow; ctx.beginPath(); ctx.ellipse(S[0], S[1], r * 1.05, r * 0.38, 0, 0, Math.PI * 2); ctx.fill(); }
        ctx.fillStyle = C.ball; ctx.beginPath(); ctx.arc(P[0], P[1], r, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = C.ink; ctx.lineWidth = 1; ctx.stroke();
      };
      const drawWall = () => {
        if (!this.showWall || D < WALL_X + 2) return;
        ctx.strokeStyle = 'rgba(244,247,241,0.75)'; ctx.lineWidth = 1.2; ctx.beginPath();
        this.seg(ctx, cam, [WALL_X, -1.7, 0], [WALL_X, 1.7, 0]); ctx.stroke();
        for (const y of [-0.93, -0.31, 0.31, 0.93]) {
          const B = this.proj(cam, [WALL_X, y, 0]), T = this.proj(cam, [WALL_X, y, 1.58]), H = this.proj(cam, [WALL_X, y, 1.69]);
          if (!B || !T || !H) continue;
          const s = cam.f / B[2], bw = 0.46 * s;
          ctx.fillStyle = C.wall; ctx.beginPath();
          const x0 = B[0] - bw / 2, y0 = T[1], hh = B[1] - T[1], rr = Math.min(bw * 0.3, 6);
          ctx.moveTo(x0, y0 + hh); ctx.lineTo(x0, y0 + rr); ctx.quadraticCurveTo(x0, y0, x0 + rr, y0);
          ctx.lineTo(x0 + bw - rr, y0); ctx.quadraticCurveTo(x0 + bw, y0, x0 + bw, y0 + rr); ctx.lineTo(x0 + bw, y0 + hh); ctx.closePath(); ctx.fill();
          ctx.fillStyle = C.wallHead; ctx.beginPath(); ctx.arc(H[0], H[1], 0.115 * s, 0, Math.PI * 2); ctx.fill();
        }
      };
      this.text(ctx, this.caption(), 10, 17, 'left', C.chalkDim, 11);
      const b = this.ballNow();
      const land = main && main.land && !anim && main.land.x <= cutX ? main.land : null;
      const drawLand = () => { // marca del bote
        const ring = [];
        for (let i = 0; i <= 20; i++) { const a = 2 * Math.PI * i / 20; ring.push([land.x + 0.45 * Math.cos(a), land.y + 0.45 * Math.sin(a), 0]); }
        ctx.strokeStyle = C.trace; ctx.lineWidth = 1.6; ctx.beginPath(); this.poly(ctx, cam, ring, false); ctx.stroke();
      };
      drawGhost();
      // de lejos a cerca: lo que queda detrás de la portería, el marco, hasta la barrera, la barrera y lo de delante
      drawPath(D, Infinity);
      if (land && land.x >= D) drawLand();
      if (b.x >= D) drawBall(b);
      drawFrame();
      drawPath(WALL_X, D);
      if (land && land.x < D) drawLand();
      if (b.x >= WALL_X && b.x < D) drawBall(b);
      // punto de golpeo
      { const ring = []; for (let i = 0; i <= 16; i++) { const a = 2 * Math.PI * i / 16; ring.push([0.3 * Math.cos(a), 0.3 * Math.sin(a), 0]); }
        ctx.strokeStyle = 'rgba(244,247,241,0.8)'; ctx.lineWidth = 1.2; ctx.beginPath(); this.poly(ctx, cam, ring, false); ctx.stroke(); }
      drawWall();
      drawPath(-Infinity, WALL_X);
      if (b.x < WALL_X) drawBall(b);
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
      this.text(ctx, this.caption(), 8, 14, 'left', C.chalkDim, 11);
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
      { const cap = this.caption(); ctx.font = '11px ' + FONT; const tw = ctx.measureText(cap).width;
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
  const PATCHES = (() => {
    const ph = (1 + Math.sqrt(5)) / 2, cs = [];
    for (const a of [-1, 1]) for (const b of [-1, 1]) { cs.push([0, a, b * ph]); cs.push([a, b * ph, 0]); cs.push([a * ph, 0, b]); }
    return cs.map((c0) => {
      const c = V.unit(c0), u = V.perp(c), v = V.cross(c, u), rho = 0.37, pts = [];
      for (let j = 0; j < 5; j++) { const a = 2 * Math.PI * j / 5; pts.push(V.add(V.mul(c, Math.cos(rho)), V.mul(V.add(V.mul(u, Math.cos(a)), V.mul(v, Math.sin(a))), Math.sin(rho)))); }
      return { c, pts };
    });
  })();
  class SpinBall {
    constructor(canvas) { this.cv = canvas; this.axis = null; this.rps = 0; this.angle = 0; this.raf = 0; this.last = null; }
    // axis: vector unitario en el mundo (regla de la mano derecha) o null; rpm real; slow: cuántas veces más lento
    set(axis, rpm, slow) {
      this.axis = axis; this.rps = axis ? (rpm / 60) / (slow || 20) : 0; this.angle = 0; this.last = null;
      this.stop(); this.draw();
      if (axis && this.rps > 0.004 && !reducedMotion() && typeof requestAnimationFrame === 'function') {
        const step = (ts) => {
          if (!this.cv.isConnected) { this.raf = 0; return; }
          if (this.last != null) this.angle += 2 * Math.PI * this.rps * Math.min(0.1, (ts - this.last) / 1000);
          this.last = ts; this.draw(); this.raf = requestAnimationFrame(step);
        };
        this.raf = requestAnimationFrame(step);
      }
    }
    stop() { if (this.raf) { cancelAnimationFrame(this.raf); this.raf = 0; } }
    draw() {
      const f = fit(this.cv); if (!f) return;
      const { ctx, w, h } = f, cx = w / 2, cy = h / 2, R = Math.min(w, h) * 0.34;
      const a = this.axis;
      // eje (por detrás del balón): en pantalla x = −y del mundo, arriba = z
      if (a) {
        const ax = -a[1], ay = -a[2], len = Math.hypot(ax, ay);
        ctx.strokeStyle = C.chalk; ctx.lineWidth = 2;
        if (len > 0.3) {
          const ux = ax / len, uy = ay / len, L = R * 1.36;
          ctx.beginPath(); ctx.moveTo(cx - ux * L, cy - uy * L); ctx.lineTo(cx + ux * L, cy + uy * L); ctx.stroke();
        }
      }
      ctx.save();
      ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fillStyle = C.ball; ctx.fill(); ctx.clip();
      ctx.fillStyle = C.ink;
      for (const p of PATCHES) {
        const c = a ? V.rot(p.c, a, this.angle) : p.c;
        if (c[0] > 0.3) continue;                       // cara oculta (x > 0 queda lejos del observador)
        ctx.beginPath();
        p.pts.forEach((q0, i) => { const q = a ? V.rot(q0, a, this.angle) : q0; const sx = cx - q[1] * R, sy = cy - q[2] * R; if (i) ctx.lineTo(sx, sy); else ctx.moveTo(sx, sy); });
        ctx.closePath(); ctx.fill();
      }
      ctx.restore();
      ctx.strokeStyle = C.ink; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
      if (a && Math.hypot(a[1], a[2]) <= 0.3) { // eje hacia el observador
        ctx.strokeStyle = C.trace; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.arc(cx, cy, 6, 0, Math.PI * 2); ctx.stroke();
      }
    }
  }

  // ------------------------------------------------------------------ punto de golpeo (visto desde detrás)
  function drawStrike(canvas, sp) {
    const f = fit(canvas); if (!f) return;
    const { ctx, w, h } = f, cx = w / 2, cy = h / 2, R = Math.min(w, h) * 0.34;
    ctx.fillStyle = 'rgba(244,247,241,0.08)'; ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = C.chalk; ctx.lineWidth = 2; ctx.stroke();
    ctx.strokeStyle = 'rgba(244,247,241,0.35)'; ctx.lineWidth = 1; ctx.setLineDash([2, 4]);
    ctx.beginPath(); ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy); ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R); ctx.stroke(); ctx.setLineDash([]);
    if (!sp) return;
    let dx = sp.right / RB, dy = sp.up / RB; const n = Math.hypot(dx, dy);
    if (n > 0.86) { dx *= 0.86 / n; dy *= 0.86 / n; }
    const px = cx + dx * R, py = cy - dy * R;
    ctx.fillStyle = C.trace; ctx.beginPath(); ctx.arc(px, py, 7.5, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = C.ink; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.strokeStyle = C.traceDim; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(px, py, 13, 0, Math.PI * 2); ctx.stroke();
  }

  root.SBScene = { PitchScene, SpinBall, drawStrike, colors: C, es };
})(typeof self !== 'undefined' ? self : this);
