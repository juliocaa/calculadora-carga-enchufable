# Código fuente de la app Smart Ball

La página publicada es `../index.html`, un único archivo que se genera a partir de `src/`:

| Archivo | Qué hace |
|---|---|
| `src/sbcore.js` | Protocolo del balón, descompresión de los datos, análisis del chute (giro, eje, velocidad, dirección) y trayectoria. También funciona en Node. |
| `src/scene.js` | Dibujo del campo con la trayectoria (tres vistas), el balón girando y el punto de golpeo. |
| `src/video.js` | Cámara: grabación de cada chute, sincronización por el sonido del golpeo y almacén de vídeos. |
| `src/app.js` | Conexión Bluetooth, flujo del chute, interfaz, historial. |
| `src/index.template.html` | Marcado y estilos; `build.py` inserta en él los cuatro scripts. |

## Generar la página

    python3 build.py

Si cambia el código, hay que subir la versión en `src/app.js` y el nombre de la caché en `../sw.js`
para que los móviles descarguen la nueva.

## Pruebas

    node test/test_core.js          # análisis y trayectoria con chutes simulados
    npm install jsdom               # una vez
    node test/ui_test.js            # la app entera con un balón falso (Bluetooth simulado)
    node test/stress_variant.js 20 vanishAtKick   # repite un caso límite del balón falso
    node test/stress_demo.js 30     # 30 chutes de demostración seguidos

Las cifras de precisión que dan las pruebas salen de un simulador propio, no de chutes reales.
