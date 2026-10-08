# Calculadora de carga para híbridos enchufables (AutoIngenium)

Calculadora del vídeo «Cómo cargar un híbrido enchufable: la profundidad de descarga, la reserva y las dos monedas» (AutoIngenium, septiembre de 2026). Versión 3.

Cada decisión sobre la carga de un híbrido enchufable se mide en dos monedas: los puntos de capacidad que pierde la batería y los euros que cuesta la energía (electricidad y gasolina). La calculadora simula hora a hora una semana tipo, envejece la batería quince años con un modelo semiempírico publicado y calcula los euros año a año con la autonomía eléctrica que va quedando. La profundidad de descarga de cada ciclo y la ventana útil de la batería son variables explícitas del término de uso.

- `index.html`: la calculadora completa (HTML autónomo; el cálculo se hace en el navegador, no envía datos).
- `modelo_phev.js`: el modelo en JavaScript (el mismo código que lleva `index.html`), utilizable con Node.
- `modelo_phev.py`: el modelo en Python con el que se calcularon las cifras del vídeo (`escenarios_phev.py` y los gráficos están en el paquete del vídeo).
- `validar.js` y `validacion.json`: comprobación de que el JavaScript reproduce el Python (14 casos, diferencia máxima < 1e-9).

## Modelo

- Ferrofosfato (BYD DM-i): reposo de Naumann et al. (2018), *J. Energy Storage* 17, 153–169; uso de Naumann, Spingler y Jossen (2020), *J. Power Sources* 451, 227666 (parámetros verificados en SimSES, TUM). El término de uso admite cuatro leyes de profundidad de descarga —la cúbica de Naumann (central), sin efecto por kWh (Wang 2011; Peterson 2010), la ley de potencia entre los dos puntos de Omar (2014) y la ley inversa de Ecker y Schmalstieg (2014)— y una clase de celda (ciclos completos hasta perder el 20 %: la del modelo, 13.270; 5.000, lectura conservadora de la cifra de BYD para la Blade; 2.500 y 9.000, extremos de Preger et al. 2020). El margen superior oculto se simula con «indicador al 100 % = real».
- Níquel: reposo de Schmalstieg et al. (2014), *J. Power Sources* 257, 325–334, con la tensión en vacío de Ecker et al. (2014), sobre la ventana real supuesta; uso con la β de Schmalstieg (lineal en la profundidad) escalada a una celda que cumpla justo el objetivo USABC/DOE para enchufables (5.000 ciclos de una ventana del 70 % hasta el 80 %; β × 0,46). Es una hipótesis declarada.
- Climas: temperaturas medias mensuales de AEMET (1981–2010) de quince ciudades; tarifa de tres periodos 2.0TD; gasolina y consumos editables.

## Uso

Abre `index.html` en el navegador (o publícalo con GitHub Pages: Settings → Pages → rama `main`, carpeta raíz). Para ejecutar el modelo en Node: `node -e "const M=require('./modelo_phev.js'); console.log(M.simular({kwh:18,suelo:0.25,top:1,cons_ev:0.18,cons_hev:0.055,p_ca:6.6,quimica:'LFP'},[70,70,70,70,70,70,70],7.4,{programada:true}).total[9])"`. Para validar: `node validar.js`.

## Licencia

MIT. Sin patrocinio ni relación con ningún fabricante. El resultado es una estimación con modelos publicados y no una predicción para un coche concreto.
