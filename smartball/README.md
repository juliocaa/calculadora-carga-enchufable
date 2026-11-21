# Smart Ball

App web propia para el **adidas miCoach Smart Ball** (2014), cuya app oficial ya no está disponible.
Funciona en **Google Chrome** (Android o PC) mediante Web Bluetooth; no hay que instalar ningún APK.

## Uso
1. Carga el balón en su base (luces apagadas = cargado).
2. Abre la página en Chrome con Bluetooth y Ubicación activados y pulsa **Conectar balón** (nombre que empieza por `DB`).
3. Coloca el balón con el logo hacia arriba y las flechas apuntando al objetivo.
4. **Preparar chute** → deja el balón quieto → silbato → chuta (≥ 1 m de altura y ≥ 10 m sin botar).
5. Los datos se descargan solos (móvil a menos de 10 m) y quedan en el historial; se pueden exportar a CSV o JSON.

## Qué enseña (versión 2)
- **Trayectoria** animada sobre el campo en tres vistas (perspectiva, lateral y desde arriba), con el mismo chute sin efecto como referencia.
- **Giro (rpm)**, eje de giro con un balón que rota como lo hizo el real, reparto en **liftado / rosca / bala** y **punto de golpeo**.
- **Si fuera una falta**: portería a 16, 20, 25 o 30 m y barrera a 9,15 m; altura a la que pasa por cada una.
- **Vídeo** de cada chute con la cámara del móvil: guarda solo unos segundos alrededor del golpeo, se ve a cámara lenta y fotograma a fotograma, y sirve para **medir el ángulo de salida** con dos toques.
- **Primer bote**: si entra en el segundo que graba el balón, ajusta la trayectoria a ese bote.

## Qué es medido y qué es estimado
- Medido por el sensor: **rpm** e **inclinación del eje** respecto a la vertical.
- Calculado con un modelo aerodinámico (arrastre y Magnus): velocidad, reparto liftado/rosca/bala, punto de golpeo y trayectoria.
- Lo menos seguro con el balón solo es el **ángulo de salida**; lo fijan el primer bote o el vídeo lateral.

## Protocolo (servicio BLE `0xAD04`)
| Característica | Uso |
|---|---|
| `AD15` | comandos: `6` reset, `3` empezar registro, `4` parar, `10 … 0x48 0x04 … 2` descargar 1096 muestras comprimidas, `11 lo hi` periodo de muestreo |
| `AD14` | notifica `1` cuando el balón está quieto y listo |
| `AD33` | % de grabación; ≥ 10 % = chute detectado |
| `AD17` | descarga: paquetes de 20 bytes (secuencia de 13 bits + 3 banderas de compresión + 3 grupos de 6 bytes) |
| `AD1F` | estado de carga (bits 0x08 cargando, 0x10 en la base, 0x20 carga parada) |
| `AD20` | periodo de muestreo (ms); `ADFE` respuesta a comandos |

Fuentes: SDK `adidas-sensors-api` publicado para el hackathon Munich TechFest 2016
(github.com/xMarkusSpringerx/smartball-adidas) y el informe «All you need to know about the Smart Soccer Ball»
(T. Stone, N. Stone, X. Guan, S. Nelakuditi, University of South Carolina; github.com/nlstone1/ARENA_Smart_Ball).

Tipografías: Anton y Atkinson Hyperlegible, con licencia SIL Open Font License 1.1.

Proyecto personal sin relación con adidas.
