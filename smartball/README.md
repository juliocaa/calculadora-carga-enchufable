# Smart Ball

App web propia para el **adidas miCoach Smart Ball** (2014), cuya app oficial ya no está disponible.
Funciona en **Google Chrome** (Android o PC) mediante Web Bluetooth; no hay que instalar ningún APK.

## Uso
1. Carga el balón en su base (luces apagadas = cargado).
2. Abre la página en Chrome con Bluetooth y Ubicación activados y pulsa **Conectar balón** (nombre que empieza por `DB`).
3. **Preparar chute** → deja el balón quieto → silbato → chuta (≥ 1 m de altura y ≥ 10 m sin botar).
4. Los datos se descargan solos (móvil a menos de 10 m) y quedan en el historial; se pueden exportar a CSV o JSON.

## Qué mide
- **Giro (rpm)** y **inclinación del eje** respecto a la vertical: a partir de la rotación del vector de aceleración durante el vuelo.
- **Liftado / rosca / giro en bala**, **ángulo de salida** y **velocidad**: estimaciones con un modelo aerodinámico (arrastre y Magnus); conviene contrastarlas con vídeo.

## Protocolo (servicio BLE `0xAD04`)
| Característica | Uso |
|---|---|
| `AD15` | comandos: `6` reset, `3` empezar registro, `4` parar, `10 … 0x48 0x04 … 2` descargar 1096 muestras comprimidas, `11 lo hi` periodo de muestreo |
| `AD14` | notifica `1` cuando el balón está quieto y listo |
| `AD33` | % de grabación; ≥ 10 % = chute detectado |
| `AD17` | descarga: paquetes de 20 bytes (secuencia de 13 bits + 3 banderas de compresión + 3 grupos de 6 bytes) |
| `AD1F` | estado de carga (bits 0x08 cargando, 0x10 en la base, 0x20 carga parada) |
| `AD20` | periodo de muestreo (ms) · `ADFE` respuesta a comandos |

Fuentes: SDK `adidas-sensors-api` publicado para el hackathon Munich TechFest 2016
(github.com/xMarkusSpringerx/smartball-adidas) y el informe «All you need to know about the Smart Soccer Ball»
(T. Stone, N. Stone, X. Guan, S. Nelakuditi, University of South Carolina; github.com/nlstone1/ARENA_Smart_Ball).

Proyecto personal sin relación con adidas.
