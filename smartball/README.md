# Smart Ball

App web propia para el **adidas miCoach Smart Ball** (2014), cuya app oficial ya no está disponible.
Funciona en **Google Chrome** (Android o PC) mediante Web Bluetooth. En Android, Chrome la instala como una app más
(menú ⋮ → **Instalar aplicación**): icono propio, pantalla completa y funcionamiento sin cobertura.

## Uso
1. Carga el balón en su base (luces apagadas = cargado).
2. Abre la página en Chrome con Bluetooth y Ubicación activados y pulsa **Conectar balón** (nombre que empieza por `DB`).
3. Coloca el balón con el logo hacia arriba y las flechas apuntando al objetivo.
4. **Preparar chute** → deja el balón quieto → silbato → chuta (≥ 1 m de altura y ≥ 10 m sin botar).
5. Los datos se descargan solos (móvil a menos de 10 m) y quedan en el historial; se pueden exportar a CSV o JSON.

## Novedades de la versión 3.1
- **Comparar con la app original**: con el modo comparación activado (Ajustes), «Descargar chute del balón» lee el último chute que guarda el balón sin preparar otro, por ejemplo el que acaba de medir la app oficial, y junto al resultado se escriben su velocidad y su giro. Con unos 20 chutes así se ajustan las fórmulas de esta app a las suyas.
- **Chute sin giro** con los mismos criterios que la app oficial (hasta 60 rpm desde 72 km/h, 120 rpm desde 90 km/h o 150 rpm desde 108 km/h) y dos notas de 0 a 5 estrellas: velocidad y poco giro.
- **Muerte súbita** en los retos de dos jugadores que acaban empatados.
- **Chute válido**: de 29 a 144 km/h y hasta 900 rpm. Fuera de esos límites se marca como no válido, no cuenta para récords, evolución ni retos, y en un reto se repite.

## Qué enseña (versión 3)
- **Pantalla Chute**: mientras se prepara el chute, el campo ocupa toda la pantalla, visto desde detrás del balón; al llegar los datos, la trayectoria se anima y la cámara se aleja hasta la perspectiva. También vista lateral y desde arriba.
- **Resultado** con los números grandes siempre a la vista y el detalle en pestañas: Vuelo, Giro y golpeo (balón en 3D girando sobre el eje medido y punto de golpeo), Falta (portería a 16, 20, 25 o 30 m y barrera a 9,15 m) y Vídeo.
- **Pie de golpeo** (se elige al preparar el chute y se puede corregir después); con el pie y la rosca indica si fue típico del interior o del exterior.
- **Comparación con el chute anterior** en velocidad y giro.
- **Historial** con récords y la evolución por semanas de la velocidad, el giro o el liftado (cada chute, media y mejor de la semana), filtrable por pie, con tabla.
- **Retos** de uno o dos jugadores por turnos: velocidad dentro de un rango, el más rápido, el de más giro o el más liftado, con marcador.
- **Vídeo** de cada chute con la cámara del móvil: cámara lenta, fotograma a fotograma, medida del ángulo de salida con dos toques y la trayectoria calculada dibujada encima.
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
