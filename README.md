# ✈️ FlightSpy León

Radar de vuelos en tiempo real alrededor de León, para frikis de los aviones. Funciona como app instalable (PWA) en **Android e iPhone**, 100% gratuito.

## Qué hace

- **Mapa radar en directo** centrado en el Aeropuerto de León (LELN) con todos los aviones —civiles y militares— en la zona de **50 km a la redonda**, actualizado cada 3–30 s, con anillos de distancia (10/25/50 km) y **movimiento fluido continuo** (cada avión avanza en el mapa según su velocidad y rumbo reales entre actualizaciones).
- **Ficha completa de cada avión**: foto real (planespotters.net), ruta origen→destino y aerolínea (adsbdb.com), matrícula, modelo, altitud, velocidad, velocidad vertical, rumbo, squawk, código ICAO hex, categoría de estela, distancia a León, intensidad de señal y nº de mensajes ADS-B.
- **Detección de militares** (bandera de base de datos ADS-B) y **emergencias** (squawk 7500/7600/7700).
- **Alertas configurables** con notificación, sonido y vibración: avión militar, emergencia, o cualquier avión a menos de X km de León.
- **Estelas de trayectoria**, etiquetas de vuelo, colores por altitud (ámbar=bajo → violeta=crucero), lista ordenada por distancia con filtros.
- **Fallback automático** entre tres fuentes de datos gratuitas: adsb.lol → airplanes.live → adsb.fi. Si una cae, usa la siguiente sin que lo notes.

## Cómo publicarla (una sola vez, gratis)

La app es 100% estática (HTML/CSS/JS), no necesita servidor propio. Cualquier hosting estático gratuito con HTTPS vale:

### Opción A — GitHub Pages (recomendada)
1. Crea una cuenta en [github.com](https://github.com) si no la tienes.
2. Crea un repositorio público llamado `flightspy`.
3. Sube todos los archivos de esta carpeta (puedes arrastrarlos en la web de GitHub: *Add file → Upload files*).
4. En el repositorio: *Settings → Pages → Source: Deploy from a branch → Branch: main → Save*.
5. En 1-2 minutos tendrás la app en `https://TU_USUARIO.github.io/flightspy/`

### Opción B — Cloudflare Pages / Netlify
Crea cuenta gratuita, "New project", arrastra la carpeta. Listo.

## Cómo instalarla en los móviles

Abre la URL publicada en el móvil y:

- **Android (Chrome):** menú ⋮ → **«Instalar aplicación»** (o «Añadir a pantalla de inicio»).
- **iPhone (Safari):** botón **Compartir** → **«Añadir a pantalla de inicio»**. ⚠️ En iPhone debe hacerse desde Safari, no desde Chrome.

Queda como una app más, con su icono, a pantalla completa y sin navegador visible.

## Notificaciones: qué esperar

- Al activar las alertas en Ajustes, el navegador pedirá permiso de notificaciones.
- Las alertas funcionan **mientras la app está abierta** (también en segundo plano reciente en Android). Al no tener servidor (para que sea gratis), no puede avisarte con la app cerrada del todo.
- En iPhone las notificaciones requieren iOS 16.4+ y que la app esté **instalada en pantalla de inicio**.
- Anti-spam integrado: máximo un aviso por avión y tipo de alerta cada 15 minutos.

## Probar en local

```
python -m http.server 8123
```
y abre http://localhost:8123

## Fuentes de datos (todas gratuitas, sin API key)

| Fuente | Uso |
|---|---|
| [adsb.lol](https://adsb.lol) / [airplanes.live](https://airplanes.live) / [adsb.fi](https://adsb.fi) | Posiciones ADS-B en tiempo real (red comunitaria de receptores) |
| [adsbdb.com](https://adsbdb.com) | Rutas (origen/destino) y aerolíneas |
| [planespotters.net](https://planespotters.net) | Fotos reales de cada aeronave |
| [CARTO](https://carto.com) / OpenStreetMap | Mapa base oscuro |
