"""
Modelo semiempírico de un híbrido enchufable medido en dos monedas — versión 3 (28-sep-2026):
  · puntos de capacidad de la batería (envejecimiento en reposo y en uso), y
  · euros de energía (electricidad de casa, del trabajo o pública, y gasolina).

Novedad de la versión 3: la PROFUNDIDAD DE DESCARGA (DoD) y la VENTANA ÚTIL de la batería son variables explícitas
del término de uso, y el modelo puede calcularse con varias leyes de dependencia de la DoD (las que sostienen los
ensayos publicados), con varias clases de celda (vida en ciclos completos) y con un margen superior oculto.

Caso central: BYD Atto 2 DM-i Boost (batería Blade de ferrofosfato, 18,0 kWh nominales; el modo eléctrico usa la
batería del 100 % al 25 % del indicador: ventana del 75 %). Contrastes: Atto 2 DM-i Active (7,8 kWh) y Seal U DM-i
Comfort (26,6 kWh). Bloque de níquel: Toyota C-HR Plug-in Hybrid 220 (reposo y, como hipótesis declarada, uso).

Química LFP (celda Sony/Murata US26650FTC1, 3 Ah), la misma de «A qué porcentaje cargar una batería LFP»:
  Naumann, Schimpe, Keil, Hesse, Jossen (2018), J. Energy Storage 17, 153-169 (reposo):
    Q_cal = k_ref · exp(−Ea/R·(1/T − 1/298,15)) · k_SOC · sqrt(t[s])
    k_ref = 1,2571e-5 s^-0,5 ; Ea = 17.126 J/mol ; k_SOC = 2,8575·(SOC−0,5)^3 + 0,60225
  Naumann, Spingler, Jossen (2020), J. Power Sources 451, 227666 (uso):
    Q_cyc[%] = k_C · k_DOD · sqrt(FEC) ; k_C = 0,0630·C + 0,0971 ; k_DOD = 4,0253·(DOD−0,6)^3 + 1,0923
  Parámetros verificados en SimSES (TUM).

LEYES DE LA PROFUNDIDAD DE DESCARGA (término de uso, por unidad de energía = por ciclo completo equivalente):
  «naumann»  la cúbica medida por Naumann 2020 en la celda LFP (central): a DOD 0,70 desgasta por kWh un 19 % menos
             que a DOD 1,0; casi plana entre 0,4 y 0,8; cae con fuerza por debajo de 0,3.
  «plana»    sin efecto de la DoD por kWh (Wang et al. 2011, A123 26650, DOD 10-90 %; Peterson et al. 2010): todo
             ciclo desgasta por kWh como uno completo. (Los microciclos < 10 % conservan la cúbica: hipótesis aparte.)
  «omar»     ley de potencia que une los dos puntos de Omar et al. 2014 (LFP): 3.221 ciclos al 80 % de DoD frente a
             34.957 al 20 % → energía hasta el fin de vida ∝ DOD^-0,72 → k_DOD = 1,3499·DOD^0,36.
  «inversa»  energía hasta el fin de vida ∝ 1/DOD (Ecker et al. 2014 en NMC: «1/ΔDOD relation»; Schmalstieg 2014,
             β lineal en ΔDOD con intercepto pequeño) → k_DOD = 1,3499·sqrt(DOD). Cota superior del efecto.
  Todas coinciden en DOD = 1 (k_DOD = 1,3499): la clase de celda se define con el ciclo completo.

CLASES DE CELDA (vida en ciclos completos equivalentes hasta perder el 20 %, a 25 °C, DOD 100 %, 0,5 C):
  «naumann»   la celda del modelo: 13.270 FEC (celda de vida muy larga).
  «blade5000» 5.000 ciclos, lectura conservadora de la cifra que da BYD para la Blade («más de 5.000 ciclos de carga y
              descarga», BYD Europe, 15-1-2026; criterio de fin de vida no publicado): término de uso × 1,63.
  «sandia»    2.500 FEC, extremo inferior de las celdas LFP comerciales de Preger et al. 2020 (× 2,30).
  n80 numérico: cualquier otra clase.

Química de níquel (celda Sanyo UR18650E, NMC/grafito), Schmalstieg, Käbitz, Ecker, Sauer (2014), J. Power Sources 257:
  reposo Q_cal = (7,543·V − 23,75)·1e6 · exp(−6976/T) · t[días]^0,75 ; V = tensión en vacío (Ecker 2014, tabla 2)
  uso    Q_cyc = β · sqrt(Q_Ah), β = 7,348e-3·(V_media − 3,667)^2 + 7,6e-4 + 4,081e-3·ΔDOD ; Q_Ah = FEC · 2 · 2,05 Ah
  La celda es de eléctrico puro: aplicada tal cual a un enchufable da pérdidas de uso del orden del 40 % a diez años.
  Por eso el uso de níquel se calcula con una ESCALA de clase de celda: «usabc» = la celda que cumple justo el objetivo
  USABC/DOE para baterías de enchufable (5.000 ciclos profundos de una ventana del 70 % hasta el 80 %: 3.500 FEC),
  que equivale a 0,455 × la β de Sanyo. Es una hipótesis declarada, no una medición de las celdas de Toyota.

Ventana y margen superior: `suelo` es el nivel del indicador al que termina el modo eléctrico (0,25 en BYD); `top` es el
estado de carga REAL de la celda cuando el indicador marca 100 % (1,0 por defecto: sin margen superior; 0,95 = el
fabricante esconde un 5 % arriba, como GM en el Volt). La capacidad `kwh` es siempre la de la celda completa.

Lo demás es como en la versión 2: reparto de cada trayecto en kilómetros eléctricos y con gasolina, microciclos del
modo híbrido (hipótesis: un tercio de la energía de tracción pasa por la batería en ciclos del 3 % a 1 C), tasa C con
la batería de cada coche, carga en el trabajo, SOC objetivo del modo híbrido, tarifa de tres periodos (2.0TD) y
gasolina, año a año con la autonomía eléctrica que queda. Acumulación con estrés variable: «tiempo virtual», paso horario.
"""
import math
import numpy as np

R_GAS = 8.314
K_REF = 1.2571e-5
EA = 17126.0
K_DOD_1 = 4.0253 * 0.4 ** 3 + 1.0923  # 1,3499: valor de la cúbica de Naumann en DOD = 1


# ---------------------------------------------------------------- LFP (Naumann): reposo
def k_soc_naumann(soc):
    return 2.8575 * (soc - 0.5) ** 3 + 0.60225


def k_soc(soc, variante="naumann"):
    k = k_soc_naumann(soc)
    if variante == "alta" and soc > 0.7:
        k50 = k_soc_naumann(0.5)
        k70 = k_soc_naumann(0.7)
        k = k70 + (soc - 0.7) / 0.3 * (2.2 * k50 - k70)
    return k


def k_cal(soc, T_C, variante="naumann"):
    T = T_C + 273.15
    return K_REF * math.exp(-EA / R_GAS * (1.0 / T - 1.0 / 298.15)) * k_soc(soc, variante)  # por s^0,5


# ---------------------------------------------------------------- LFP: uso, con la ley de la DoD elegible
def k_c(c_rate):
    return 0.0630 * c_rate + 0.0971


def k_dod_naumann(dod):
    return 4.0253 * (dod - 0.6) ** 3 + 1.0923


def k_dod(dod, ley="naumann"):
    dod = max(1e-6, min(1.0, dod))
    if ley == "naumann":
        return k_dod_naumann(dod)
    if ley == "plana":
        return K_DOD_1 if dod >= 0.10 else k_dod_naumann(dod)
    if ley == "omar":
        return K_DOD_1 * dod ** 0.36
    if ley == "inversa":
        return K_DOD_1 * math.sqrt(dod)
    raise ValueError(ley)


LEYES = ("naumann", "plana", "omar", "inversa")


def k_cyc(c_rate, dod, ley="naumann"):
    return k_c(c_rate) * k_dod(dod, ley) / 100.0  # fracción por sqrt(FEC)


def fec_hasta(perdida=0.20, c_rate=0.5, dod=1.0, ley="naumann"):
    """Ciclos completos equivalentes hasta una pérdida dada (solo uso), en la celda del modelo."""
    return (perdida / k_cyc(c_rate, dod, ley)) ** 2


N80_NAUMANN = fec_hasta()  # ≈ 13.270 FEC a 0,5 C y DOD 1
CELDAS = {"naumann": N80_NAUMANN, "blade5000": 5000.0, "sandia": 2500.0}


def escala_uso(celda="naumann"):
    """Factor que multiplica el término de uso para una clase de celda (FEC hasta el 80 % a DOD 100 %, 0,5 C, 25 °C)."""
    n80 = CELDAS[celda] if isinstance(celda, str) else float(celda)
    return math.sqrt(N80_NAUMANN / n80)


# ---------------------------------------------------------------- NMC (Schmalstieg)
SOC_PTS = np.array([0, 10, 20, 30, 50, 60, 70, 80, 85, 90, 95, 100]) / 100
V_PTS = np.array([3.331, 3.494, 3.578, 3.626, 3.699, 3.782, 3.869, 3.964, 4.018, 4.072, 4.117, 4.162])
AH_CELDA = 2.05


def ocv(soc):
    return float(np.interp(soc, SOC_PTS, V_PTS))


def alpha_nmc(soc, T_C):
    T = T_C + 273.15
    return (7.543 * ocv(soc) - 23.75) * 1e6 * math.exp(-6976.0 / T)  # fracción por día^0,75


def beta_nmc(v_avg, ddod):
    return 7.348e-3 * (v_avg - 3.667) ** 2 + 7.6e-4 + 4.081e-3 * ddod  # fracción por sqrt(Ah)


def escala_ni_usabc(ventana=0.70, ciclos=5000.0, perdida=0.20, soc_medio=0.5):
    """Escala de la β de Sanyo para una celda que cumpla justo el objetivo USABC de enchufable."""
    fec = ciclos * ventana
    b = beta_nmc(ocv(soc_medio), ventana)
    return perdida / (b * math.sqrt(fec * 2 * AH_CELDA))


ESCALA_NI_USABC = escala_ni_usabc()  # ≈ 0,455


# ---------------------------------------------------------------- Climas (AEMET 1981-2010; Murcia 1984-2010)
CLIMAS = {
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
    "25 °C constante": [25.0] * 12,
}
DIAS_MES = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]


def temperatura_horaria(clima, offset=0.0):
    temps = CLIMAS[clima]
    return np.concatenate([np.full(24 * d, t + offset) for t, d in zip(temps, DIAS_MES)])  # 8760


# ---------------------------------------------------------------- Coches
# kwh: capacidad de la celda completa (nominal); suelo: nivel del indicador al que termina el modo eléctrico; top: SOC real
# de la celda cuando el indicador marca 100 %; cons_ev: kWh/km reales a la salida de la batería; cons_hev: l/km reales con
# la batería en el suelo; p_ca: potencia máxima en alterna (kW).
COCHES = {
    "atto2_boost": dict(nombre="BYD Atto 2 DM-i Boost", kwh=18.0, suelo=0.25, top=1.0, cons_ev=0.18, cons_hev=0.055, p_ca=6.6, quimica="LFP"),
    "atto2_active": dict(nombre="BYD Atto 2 DM-i Active", kwh=7.8, suelo=0.25, top=1.0, cons_ev=0.175, cons_hev=0.055, p_ca=3.3, quimica="LFP"),
    "sealu_comfort": dict(nombre="BYD Seal U DM-i Comfort", kwh=26.6, suelo=0.25, top=1.0, cons_ev=0.20, cons_hev=0.065, p_ca=11.0, quimica="LFP"),
    "sealu_boost": dict(nombre="BYD Seal U DM-i Boost", kwh=18.3, suelo=0.25, top=1.0, cons_ev=0.20, cons_hev=0.065, p_ca=11.0, quimica="LFP"),
}

# Tarifa de tres periodos (peaje 2.0TD): laborables, valle 0-8 h; llano 8-10, 14-18 y 22-24 h; punta 10-14 y 18-22 h.
# Sábados, domingos y festivos, valle todo el día.
PRECIOS_3P = dict(punta=0.199, llano=0.159, valle=0.119)  # €/kWh, Enérgya VM «Fórmula Fija 3 Periodos» (Xataka, 2-9-2026)


def periodo(d, h):
    """d: 0 = lunes … 6 = domingo; h: hora 0-23."""
    if d >= 5:
        return "valle"
    if h < 8:
        return "valle"
    if (10 <= h < 14) or (18 <= h < 22):
        return "punta"
    return "llano"


def precio_hora(d, h, precios):
    if isinstance(precios, (int, float)):
        return float(precios)
    return precios[periodo(d, h)]


# ---------------------------------------------------------------- Perfil semanal (simulación horaria explícita)
def simular_perfil(coche, km_semana, potencia_kw, objetivo=1.0, programada=False, cada_n_dias=1, nunca=False,
                   suelo_ev=None, trabajo=None, semanal_100=None, inicio_fijo=None, eficiencia=0.9, h_salida=8,
                   h_regreso=18, h_enchufe=19, reparto=0.55, f_hev=1 / 3, v_media=50.0, semanas=4, capacidad_rel=1.0):
    """Devuelve un dict con el SOC horario (del INDICADOR, 0-1) de la última semana, los kilómetros eléctricos y con gasolina,
    la energía tomada de la red por hora de la semana, los tramos de carga (para el término de uso) y los ciclos completos
    equivalentes (referidos a la celda completa, `kwh`).

    objetivo: nivel del indicador al que se carga en casa (1.0 = completa).
    programada: la carga de casa se sitúa para terminar a h_salida; si no, empieza a h_enchufe.
    nunca: el coche no se enchufa (circula siempre en híbrido).
    suelo_ev: nivel al que el coche pasa de eléctrico a híbrido (por defecto el del coche, 25 %; hasta el 70 % en BYD).
    trabajo: dict(potencia=…, h_ini=9) para cargar también en el trabajo los laborables (carga inmediata al 100 %).
    semanal_100: día de la semana (0-6) cuya noche se hace una carga completa programada (si objetivo < 1).
    inicio_fijo: hora (0-23) a la que empieza la carga de casa (p. ej. 0 = medianoche).
    capacidad_rel: capacidad restante relativa (para recalcular kilómetros eléctricos con la batería envejecida).
    """
    top = coche.get("top", 1.0)
    kwh_d = coche["kwh"] * top * capacidad_rel  # kWh que representa el 100 % del indicador
    suelo = coche["suelo"] if suelo_ev is None else suelo_ev
    cons = coche["cons_ev"]
    p_casa = min(potencia_kw, coche["p_ca"]) * eficiencia / kwh_d  # fracción del indicador por hora
    n = 168 * semanas
    soc = np.zeros(n)
    s = objetivo if not nunca else suelo
    carga = None  # (objetivo, hora de inicio absoluta, potencia en fracción/h, lugar)
    km_ev = km_hev = 0.0
    fec_prof = fec_micro = 0.0
    red = np.zeros(168)
    red_trabajo = np.zeros(168)
    tramos = []  # (s_ini, s_fin, C de carga) de la última semana, en fracción del indicador

    def trayecto(km, s, ultimo):
        nonlocal km_ev, km_hev, fec_prof, fec_micro
        e = km * cons / kwh_d
        disp = max(0.0, s - suelo)
        if e <= disp + 1e-12:
            s -= e
            if ultimo:
                km_ev += km; fec_prof += e * top * capacidad_rel
        else:
            k_ev = disp * kwh_d / cons
            s -= disp
            if ultimo:
                km_ev += k_ev; km_hev += km - k_ev
                fec_prof += disp * top * capacidad_rel
                fec_micro += (km - k_ev) * cons * f_hev / coche["kwh"]
        return s

    for t in range(n):
        d = (t // 24) % 7
        h = t % 24
        ultimo = t >= n - 168
        if h == h_salida:
            if carga is not None and carga[3] == "casa":
                carga = None
            s = trayecto(km_semana[d] * reparto, s, ultimo)
        if trabajo is not None and d < 5 and h == trabajo.get("h_ini", h_salida + 1) and s < 1.0 - 1e-9:
            p_t = min(trabajo["potencia"], coche["p_ca"]) * eficiencia / kwh_d
            carga = (1.0, t, p_t, "trabajo")
            if ultimo:
                tramos.append([s, 1.0, p_t * top * capacidad_rel])
        if h == h_regreso:
            if carga is not None and carga[3] == "trabajo":
                if ultimo and tramos:
                    tramos[-1][1] = s
                carga = None
            s = trayecto(km_semana[d] * (1 - reparto), s, ultimo)
        if h == h_enchufe and not nunca:
            dia_carga = (d % cada_n_dias == 0)
            obj, prog = objetivo, programada
            if semanal_100 is not None and d == semanal_100:
                dia_carga, obj, prog = True, 1.0, True
            if dia_carga and obj > s + 1e-9:
                horas = (obj - s) / p_casa
                fin = t + (24 - h_enchufe) + h_salida
                ini = max(t, fin - horas) if prog else t
                if inicio_fijo is not None and not prog:
                    ini = t + ((inicio_fijo - h_enchufe) % 24)
                carga = (obj, ini, p_casa, "casa")
                if ultimo:
                    tramos.append([s, obj, p_casa * top * capacidad_rel])
        if carga is not None:
            obj, ini, p, lugar = carga
            if t + 1 > ini:
                paso = p * min(1.0, t + 1 - ini)
                s_new = min(obj, s + paso)
                if ultimo:
                    e_red = (s_new - s) * kwh_d / eficiencia
                    if lugar == "casa":
                        red[t % 168] += e_red
                    else:
                        red_trabajo[t % 168] += e_red
                s = s_new
                if s >= obj - 1e-9:
                    carga = None
        soc[t] = s
    return dict(soc=soc[-168:], km_ev=km_ev, km_hev=km_hev, fec_prof=fec_prof, fec_micro=fec_micro,
                red=red, red_trabajo=red_trabajo, tramos=[tuple(x) for x in tramos if x[1] > x[0] + 1e-9], top=top)


# ---------------------------------------------------------------- Envejecimiento LFP
def termino_uso(coche, perfil, ley="naumann", celda="naumann", v_media=50.0, c_micro=1.0, dod_micro=0.03):
    """k² anual del término de uso (Q_cyc² = k²·años) y estadísticas: FEC, DoD real, C efectiva."""
    top = perfil.get("top", coche.get("top", 1.0))
    c_desc = coche["cons_ev"] * v_media / coche["kwh"]
    fec_prof_ano = perfil["fec_prof"] * 365.0 / 7.0
    fec_micro_ano = perfil["fec_micro"] * 365.0 / 7.0
    den = sum(b - a for a, b, _ in perfil["tramos"])
    k2 = 0.0
    dods, cs = [], []
    for a, b, c_carga in perfil["tramos"]:
        w = (b - a) * top  # profundidad real del ciclo en la celda
        c = 0.5 * (c_carga + c_desc)
        k2 += k_cyc(c, w, ley) ** 2 * fec_prof_ano * (b - a) / den if den > 0 else 0.0
        dods.append(w); cs.append(c)
    k2 += k_cyc(c_micro, dod_micro, ley) ** 2 * fec_micro_ano
    e = escala_uso(celda)
    k2 *= e * e
    fec_ano = fec_prof_ano + fec_micro_ano
    return dict(k2_ano=k2, fec_prof_ano=fec_prof_ano, fec_micro_ano=fec_micro_ano, fec_ano=fec_ano,
                k_eff=math.sqrt(k2 / fec_ano) if fec_ano > 0 else 0.0,
                dod=float(np.average(dods, weights=dods)) if dods else 0.0,
                c_eff=float(np.average(cs, weights=dods)) if dods else c_desc, escala_uso=e)


def envejecer(coche, perfil, clima, anos=15, variante="naumann", offset_T=0.0, v_media=50.0, c_micro=1.0, dod_micro=0.03,
              parada=None, ley="naumann", celda="naumann"):
    """Pérdida año a año (fracción): total, reposo (cal) y uso (cyc), para una batería LFP.
    parada = dict(dias=…, soc=…): días seguidos de agosto con el coche parado a ese estado de carga (indicador)."""
    top = perfil.get("top", coche.get("top", 1.0))
    soc_sem = np.array(perfil["soc"]) * top  # SOC real de la celda
    T_h = temperatura_horaria(clima, offset_T)
    n_h = len(T_h)
    soc_h = np.tile(soc_sem, int(math.ceil(n_h / 168)))[:n_h].copy()
    if parada:
        h0 = 24 * sum(DIAS_MES[:7])  # 1 de agosto
        soc_h[h0:h0 + 24 * parada["dias"]] = parada["soc"] * top
    ks = np.array([k_cal(float(s_), float(T_), variante) for s_, T_ in zip(soc_h, T_h)])
    u = termino_uso(coche, perfil, ley=ley, celda=celda, v_media=v_media, c_micro=c_micro, dod_micro=dod_micro)
    res = {"anos": [], "total": [], "cal": [], "cyc": []}
    Q_cal = 0.0
    for a in range(1, anos + 1):
        for h in range(n_h):
            k = ks[h]
            t_v = (Q_cal / k) ** 2 if Q_cal > 0 else 0.0
            Q_cal = k * math.sqrt(t_v + 3600.0)
        Q_cyc = math.sqrt(u["k2_ano"] * a)
        res["anos"].append(a); res["cal"].append(Q_cal); res["cyc"].append(Q_cyc); res["total"].append(Q_cal + Q_cyc)
    sd = np.array(perfil["soc"])
    res.update(soc_medio=float(np.mean(soc_sem)), h_sem_95=float(np.sum(sd >= 0.95)), h_sem_80=float(np.sum(sd >= 0.80)),
               h_sem_suelo=float(np.sum(sd <= coche["suelo"] + 0.051)), soc_min=float(np.min(soc_sem)), soc_max=float(np.max(soc_sem)),
               **{k: v for k, v in u.items() if k != "k2_ano"})
    return res


# ---------------------------------------------------------------- Níquel (Schmalstieg): reposo y uso sobre el SOC real de la celda
def envejecer_nmc_reposo(perfil_soc_real, clima, anos=15, offset_T=0.0):
    """Solo el término de reposo de Schmalstieg (2014) para un perfil semanal de SOC real de la celda."""
    T_h = temperatura_horaria(clima, offset_T)
    n_h = len(T_h)
    soc_h = np.tile(perfil_soc_real, int(math.ceil(n_h / 168)))[:n_h]
    al = np.array([alpha_nmc(float(s_), float(T_)) for s_, T_ in zip(soc_h, T_h)])
    out = []
    Q = 0.0
    for a in range(1, anos + 1):
        for h in range(n_h):
            x = al[h]
            t_v = (Q / x) ** (1 / 0.75) if Q > 0 else 0.0
            Q = x * (t_v + 1 / 24.0) ** 0.75
        out.append(Q)
    return out


def uso_nmc(perfil, kwh_util, kwh_bruta, lo, hi, anos=15, escala=ESCALA_NI_USABC, f_micro_dod=0.03, v_micro_soc=None):
    """Término de uso de Schmalstieg con la ventana real [lo, hi] de la celda y una escala de clase de celda.
    perfil: el de simular_perfil sobre la capacidad ÚTIL (indicador 0-1). Devuelve la pérdida acumulada año a año (fracción)."""
    r = (hi - lo)
    fec_prof_ano = perfil["fec_prof"] * 365.0 / 7.0 * kwh_util / kwh_bruta  # FEC de la celda completa
    fec_micro_ano = perfil["fec_micro"] * 365.0 / 7.0 * kwh_util / kwh_bruta
    den = sum(b - a for a, b, _ in perfil["tramos"])
    b2 = 0.0
    dods, vs = [], []
    for a, b, _ in perfil["tramos"]:
        ddod = (b - a) * r
        v_avg = ocv(lo + 0.5 * (a + b) * r)
        bb = beta_nmc(v_avg, ddod)
        b2 += bb ** 2 * fec_prof_ano * (b - a) / den if den > 0 else 0.0
        dods.append(ddod); vs.append(v_avg)
    v_m = ocv(lo if v_micro_soc is None else v_micro_soc)
    b2 += beta_nmc(v_m, f_micro_dod) ** 2 * fec_micro_ano
    out = [escala * math.sqrt(b2 * 2 * AH_CELDA * a) for a in range(1, anos + 1)]
    return dict(curva=out, fec_ano=fec_prof_ano + fec_micro_ano, fec_prof_ano=fec_prof_ano,
                ddod=float(np.average(dods, weights=dods)) if dods else 0.0, v_avg=float(np.average(vs, weights=dods)) if dods else v_m,
                beta=float(np.sqrt(b2 / (fec_prof_ano + fec_micro_ano))) if (fec_prof_ano + fec_micro_ano) > 0 else 0.0)


# ---------------------------------------------------------------- Euros
def euros_semana(coche, perfil, precios=PRECIOS_3P, precio_gasolina=1.92, precio_trabajo=0.0, precio_publica=None):
    """Coste de la energía de una semana: electricidad de casa (por periodos), del trabajo y gasolina."""
    e_casa = 0.0
    for i in range(168):
        if perfil["red"][i] > 0:
            e_casa += perfil["red"][i] * precio_hora(i // 24, i % 24, precios)
    e_trab = float(np.sum(perfil["red_trabajo"])) * precio_trabajo
    litros = perfil["km_hev"] * coche["cons_hev"]
    return dict(casa=e_casa, trabajo=e_trab, gasolina=litros * precio_gasolina, litros=litros,
                kwh_casa=float(np.sum(perfil["red"])), kwh_trabajo=float(np.sum(perfil["red_trabajo"])),
                total=e_casa + e_trab + litros * precio_gasolina)


def simular(coche_id, km_semana, potencia_kw, clima="Madrid", anos=15, variante="naumann", offset_T=0.0,
            precios=PRECIOS_3P, precio_gasolina=1.92, precio_trabajo=0.0, parada=None, ley="naumann", celda="naumann", **rutina):
    """Simulación completa: envejecimiento con el perfil de batería nueva y euros año a año con la capacidad que queda."""
    coche = COCHES[coche_id] if isinstance(coche_id, str) else coche_id
    perfil = simular_perfil(coche, km_semana, potencia_kw, **rutina)
    res = envejecer(coche, perfil, clima, anos=anos, variante=variante, offset_T=offset_T, parada=parada, ley=ley, celda=celda)
    e0 = euros_semana(coche, perfil, precios, precio_gasolina, precio_trabajo)
    res["perfil"] = perfil
    res["euros_ano_nueva"] = {k: v * 365 / 7 for k, v in e0.items()}
    res["km_ev_ano_nueva"] = perfil["km_ev"] * 365 / 7
    res["km_hev_ano_nueva"] = perfil["km_hev"] * 365 / 7
    euros, km_ev, km_hev = [], [], []
    for a in range(1, anos + 1):
        perdida_media = 0.5 * ((res["total"][a - 2] if a > 1 else 0.0) + res["total"][a - 1])
        p_a = simular_perfil(coche, km_semana, potencia_kw, capacidad_rel=1.0 - perdida_media, **rutina)
        e_a = euros_semana(coche, p_a, precios, precio_gasolina, precio_trabajo)
        euros.append(e_a["total"] * 365 / 7); km_ev.append(p_a["km_ev"] * 365 / 7); km_hev.append(p_a["km_hev"] * 365 / 7)
    res["euros_ano"] = euros
    res["km_ev_ano"] = km_ev
    res["km_hev_ano"] = km_hev
    return res


def anos_hasta(res, umbral):
    t = np.array(res["total"]); a = np.array(res["anos"], dtype=float)
    if t[-1] < umbral:
        return float(a[-1] * (umbral / t[-1]) ** 2)
    i = int(np.argmax(t >= umbral))
    if i == 0:
        return float(a[0] * umbral / t[0])
    return float(a[i - 1] + (umbral - t[i - 1]) / (t[i] - t[i - 1]))


# ---------------------------------------------------------------- Ciclos frente a energía (para el gráfico del bloque de la DoD)
def ciclos_vs_energia():
    """Vida relativa (DOD 100 % = 1) en ciclos y en energía según cada ley y los puntos medidos que se citan."""
    dods = np.linspace(0.1, 1.0, 91)
    out = {"dod": dods.tolist(), "leyes": {}}
    for ley in LEYES:
        en = [(K_DOD_1 / k_dod(d, ley)) ** 2 for d in dods]  # FEC hasta el fin de vida, relativos
        out["leyes"][ley] = dict(energia=en, ciclos=[e / d for e, d in zip(en, dods)])
    # Ecker 2014 (NMC, Sanyo): EFC ∝ 1/ΔDOD; Burzyński 2019 (NMC, 3 C): ciclos 395/776/1321/2473 a 100/77/50/27 %;
    # Omar 2014 (LFP): 3.221 ciclos al 80 % y 34.957 al 20 %; Wang 2011 (LFP): sin efecto por Ah.
    out["puntos"] = dict(
        burzynski=dict(dod=[1.0, 0.77, 0.50, 0.27], ciclos=[395, 776, 1321, 2473]),
        omar=dict(dod=[0.8, 0.2], ciclos=[3221, 34957]),
    )
    return out


if __name__ == "__main__":
    km = [70] * 7
    print(f"N80 Naumann (0,5 C, DOD 1): {N80_NAUMANN:,.0f} FEC · escala blade5000 {escala_uso('blade5000'):.2f} · sandia {escala_uso('sandia'):.2f} · escala níquel USABC {ESCALA_NI_USABC:.3f}")
    for ley in LEYES:
        for celda in ("naumann", "blade5000"):
            r = simular("atto2_boost", km, 7.4, anos=10, programada=True, ley=ley, celda=celda)
            print(f"ley {ley:8s} celda {celda:9s}: 10a {r['total'][-1]*100:5.2f} = cal {r['cal'][-1]*100:5.2f} + cyc {r['cyc'][-1]*100:4.2f} | FEC/a {r['fec_ano']:.0f} DOD {r['dod']:.2f} C {r['c_eff']:.2f}")
    for nombre, kw in [("al enchufar", dict()), ("programada", dict(programada=True)), ("80 % programada", dict(objetivo=0.8, programada=True)), ("nunca", dict(nunca=True))]:
        r = simular("atto2_boost", km, 7.4, anos=10, **kw)
        e = r["euros_ano_nueva"]
        print(f"{nombre:18s} 10a {r['total'][-1]*100:5.2f} = cal {r['cal'][-1]*100:5.2f} + cyc {r['cyc'][-1]*100:4.2f} | h≥95 {r['h_sem_95']:.0f} | km EV/a {r['km_ev_ano_nueva']:.0f} HEV {r['km_hev_ano_nueva']:.0f} | €/a {e['total']:.0f} | €10a {sum(r['euros_ano']):.0f}")
    # margen superior: la misma ventana (13,5 kWh) con una celda un 5 % mayor y el 100 % del indicador en el 95 % real
    c5 = dict(COCHES["atto2_boost"], kwh=18.0 / 0.95, top=0.95)
    for nombre, kw in [("al enchufar", dict()), ("programada", dict(programada=True))]:
        r = simular(c5, km, 7.4, anos=10, **kw); r0 = simular("atto2_boost", km, 7.4, anos=10, **kw)
        print(f"top 95 % {nombre:12s}: {r['total'][-1]*100:5.2f} (cal {r['cal'][-1]*100:5.2f} cyc {r['cyc'][-1]*100:4.2f}) frente a {r0['total'][-1]*100:5.2f}")
