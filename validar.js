// Compara el modelo JavaScript con los resultados del Python (out/validacion.json)
const M = require("./modelo_phev.js");
const fs = require("fs");
const casos = JSON.parse(fs.readFileSync("validacion.json", "utf8"));
let maxd = 0;
for (const c of casos) {
  const r = M.simular(c.coche, c.km, c.P, c.opts);
  const js = { total10: r.total[9], cal10: r.cal[9], cyc10: r.cyc[9], eur1: r.euros_ano_nueva.total, eur10: r.euros_ano.slice(0, 10).reduce((a, b) => a + b, 0), fec: r.fec_ano, dod: r.dod };
  for (const k in js) { const d = Math.abs(js[k] - c.py[k]); if (d > maxd) maxd = d; if (d > 1e-9 * Math.max(1, Math.abs(c.py[k]))) console.log("DIF", c.nombre, k, js[k], c.py[k]); }
  console.log(c.nombre.padEnd(34), "10a", (js.total10 * 100).toFixed(3), "cyc", (js.cyc10 * 100).toFixed(3), "€/a", js.eur1.toFixed(1), "DoD", js.dod.toFixed(3));
}
console.log("diferencia máxima", maxd);
