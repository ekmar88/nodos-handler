# Plan: integración con Unreal Engine 5.7+

Estado: **propuesta, sin empezar**. Rama base: `dev` (commit `b15f3d5`).
Última actualización: 2026-11-18.

## Objetivo

El backend, que ya controla Nodos, también debe:

- **escribir** en Unreal cualquier parámetro de los actores: propiedades nativas,
  variables de Blueprint expuestas, transforms, propiedades de componentes y
  llamadas a funciones y eventos de Blueprint;
- **leer** el estado de Unreal y recibir los cambios en tiempo real (SSE).

Escenario de ejecución: Unreal corre en una máquina cliente, en modo `-game`
con `-RenderOffScreen` y gestionado como un servicio. Toda la lógica vive en
el backend Node.

## Preguntas abiertas (resolver antes de empezar)

- [ ] ¿El proyecto de Unreal es **C++ o solo Blueprints**? El plugin BackendLink
      (fase 3) necesita compilar C++, con Visual Studio y el proyecto
      convertido a C++. Si no es posible, la alternativa es un actor Blueprint
      que haga de registro, con polling y sin eventos push.
- [ ] ¿Habrá **una instancia o varias** (varias máquinas de render)? El diseño
      admite varias. Si solo hay una, el segmento `:inst` de las rutas puede
      ser opcional.
- [ ] Verificar en 5.7 el **flag que activa Remote Control** en `-game`
      (posiblemente `-RCWebControlEnable`) y los puertos por defecto
      (HTTP 30010 y WebSocket 30020).

## Limitaciones de Remote Control API en `-game`

| Limitación | Consecuencia | Solución |
|------------|--------------|----------|
| El servidor de Remote Control no arranca solo | No hay API | Flag de arranque o Project Settings |
| Los labels de los actores solo existen en el editor | No se puede buscar un actor por el nombre del Outliner | Una ID estable propia (`RemoteExposedComponent` o el tag `rc:<id>`) |
| No hay un endpoint nativo para listar actores en runtime, y con World Partition entran y salen | El backend no puede descubrirlos | Un catálogo que mantiene el plugin |
| No hay eventos de cambio (salvo en Presets), y escribir la propiedad en crudo no ejecuta la lógica | Hay que hacer polling y algunos cambios no se ven en pantalla | Usar setters (`SetIntensity`, `K2_SetActorLocation`, `BlueprintSetter`) y notificaciones push del plugin |

## Arquitectura

```
┌──────────── Máquina cliente ─────────────┐        ┌──────── Backend (Node) ────────┐
│ MyProject.exe -game -RenderOffScreen     │        │                                │
│  Remote Control API (WebSocket :30020) ◄─┼────────┤ rc-socket: leer/escribir/llamar│
│  Plugin BackendLink ─────────────────────┼───────►│ link-server: catálogo, cambios,│
│   catálogo / watch / hello / heartbeat   │  WS    │   heartbeat                    │
└──────────────────────────────────────────┘        │ API REST + SSE + panel         │
                                                    └────────────────────────────────┘
```

- **Remote Control (backend → Unreal):** escritura de propiedades, llamadas a
  funciones y lecturas puntuales. Unreal ya convierte el JSON a sus tipos.
- **BackendLink (Unreal → backend):** Unreal se conecta como cliente WebSocket a
  `ws://backend:3000/unreal/link`. Así cada instancia se registra sola al
  arrancar y se reconecta si se reinicia.

### Protocolo del link (borrador)

| Mensaje | Dirección | Contenido |
|---------|-----------|-----------|
| `hello` | UE → backend | `instanceId`, versión de UE y del plugin, nivel/mapa, host y puerto de RC |
| `catalog` | UE → backend | Actores expuestos: `id`, clase, ruta de objeto, componentes, propiedades (nombre, tipo, si es editable, setter) y funciones (con su firma) |
| `catalogDelta` | UE → backend | Actores añadidos y eliminados (streaming o cambio de nivel) |
| `changed` | UE → backend | `{id, component?, property, value}` en lotes |
| `heartbeat` | Ambas | Ping/pong cada N segundos |
| `watch` / `unwatch` | Backend → UE | Ajustar qué propiedades se vigilan y a qué frecuencia |

### Identificación de actores

`URemoteExposedComponent` (sirve en C++ y en Blueprint) con:
- `Id` estable, p. ej. `sun` o `camera.main`;
- `WatchedProperties`: por defecto el transform y las variables *Instance Editable*;
- frecuencia máxima de notificación.

Alternativa sin componente: Actor Tag `rc:<id>`.

### Qué se puede controlar y cómo

| Qué | Cómo |
|-----|------|
| Propiedades nativas | RC `object/property`, o el **setter** si existe (`object/call`) |
| Variables de Blueprint | RC `object/property`; si deben disparar lógica, `BlueprintSetter` o un evento |
| Eventos y funciones de Blueprint | RC `object/call` con parámetros |
| Transform | `K2_SetActorLocation`, `K2_SetActorRotation`, `K2_SetActorTransform`, `SetActorScale3D` (con `teleport`) |
| Componentes | Ruta de objeto del componente dentro del actor |

## Estructura de carpetas objetivo

```
src/
├── app.js, create-app.js
├── core/                        logger, reconnect, errors (ApiError), event-bus
├── integrations/
│   ├── nodos/                   código actual: graph client, app client, protocol, pin-values, fb-extract
│   └── unreal/
│       ├── rc/
│       │   ├── rc-socket.js     WebSocket a :30020, RequestId → Promise, timeouts, reconexión
│       │   └── rc-api.js        getProperty, setProperty, call, describe, batch
│       ├── link/
│       │   ├── link-server.js   servidor WS en /unreal/link (upgrade del servidor HTTP)
│       │   └── link-protocol.js validación y tipos de mensajes
│       ├── instances.js         registro de instancias (id → rc + link + estado)
│       ├── catalog.js           actores/componentes/propiedades/funciones por id
│       ├── transforms.js        location/rotation/scale, merge parcial
│       └── values.js            FVector/FRotator/FLinearColor/FTransform ↔ JSON
├── bridge/                      sincronización Nodos ↔ Unreal (fase 5)
└── api/
    ├── routes/        nodos.js, unreal.js, events.js
    ├── controllers/
    └── middlewares/
unreal/Plugins/BackendLink/      se copia en <Proyecto>/Plugins/
├── BackendLink.uplugin
└── Source/BackendLink/
    ├── Public/   BackendLinkSubsystem.h, RemoteExposedComponent.h, BackendLinkSettings.h
    └── Private/  conexión WS, catálogo, diff de propiedades en tick
public/                          panel con pestañas Nodos / Unreal
test/  nodos/  unreal/  api/  helpers/fake-unreal.js
```

## API objetivo

```
GET    /api/unreal/instances
GET    /api/unreal/:inst/actors                          ?class=&tag=
GET    /api/unreal/:inst/actors/:id                      propiedades, funciones, componentes, transform
PATCH  /api/unreal/:inst/actors/:id/properties/:prop     {"value": …}  (merge parcial de structs)
PATCH  /api/unreal/:inst/actors/:id/components/:comp/properties/:prop
PUT    /api/unreal/:inst/actors/:id/transform            {"location", "rotation", "scale", "teleport"}
POST   /api/unreal/:inst/actors/:id/functions/:fn        {"params": {…}}
POST   /api/unreal/:inst/batch
GET    /api/events                                       SSE con campo source: "nodos" | "unreal"
```

Regla de escritura, igual que con Nodos: solo se responde `200` cuando Unreal
confirma el valor nuevo (con una lectura posterior o un `changed`). Si no
confirma, se responde `502` con el valor real.

## Fases

### Fase 1: reorganizar sin cambiar el comportamiento
- [ ] Mover `src/lib/*` a `src/core/` y `src/integrations/nodos/`.
- [ ] Mover controllers, routes y middlewares a `src/api/`.
- [ ] Separar `ApiError` en `core/errors.js` (re-exportarlo desde pin-values).
- [ ] Event bus común para el SSE, con campo `source`.
- [ ] Actualizar imports en los tests y en `scripts/probe-ports.js`.
- [ ] **Criterio:** los 43 tests pasan; README actualizado.

### Fase 2: cliente de Remote Control (sin plugin)
- [ ] Añadir la dependencia `ws`.
- [ ] `rc-socket.js`: correlación por RequestId, timeouts, `keepConnected`.
- [ ] `rc-api.js`: property get/set, call, describe y batch, usando rutas de
      objeto (`/Game/Maps/Main.Main:PersistentLevel.BP_Sun_C_1`).
- [ ] `values.js` / `transforms.js`: conversión y merge parcial.
- [ ] Config: `UNREAL_INSTANCES` (lista de `id=host:port`) o un `UNREAL_RC_URL` único.
- [ ] Rutas REST con `:id` igual a la ruta de objeto (URL-encoded) mientras no exista el catálogo.
- [ ] Lectura con polling opcional para el SSE.
- [ ] `test/helpers/fake-unreal.js`: servidor RC WebSocket simulado.
- [ ] **Criterio:** se pueden leer y escribir propiedades, el transform y llamar
      funciones de un actor conocido por su ruta en `-game`.

### Fase 3: plugin BackendLink y catálogo
- [ ] Plugin C++: `UBackendLinkSubsystem` (GameInstanceSubsystem) que lee
      `-BackendUrl=` y `-InstanceId=` y se conecta con el módulo `WebSockets`.
- [ ] `URemoteExposedComponent`, catálogo por reflexión (`TFieldIterator<FProperty>`
      y `UFunction` con `BlueprintCallable`).
- [ ] Vigilancia: diff en tick con frecuencia limitada y envío de `changed` en lotes.
- [ ] Backend: `link-server.js`, `instances.js` y `catalog.js`; resolver `:id`
      con el catálogo (y la ruta de objeto como fallback).
- [ ] **Criterio:** al arrancar UE aparece en `/api/unreal/instances` y sus
      actores se listan por id estable.

### Fase 4: eventos y panel
- [ ] Eventos `unreal.instance`, `unreal.catalog` y `unreal.property` en `/api/events`.
- [ ] Pestaña Unreal en `public/index.html`: instancias, actores, editor de
      propiedades y transform, y botones para las funciones.

### Fase 5: bridge Nodos ↔ Unreal
- [ ] Mapeos declarativos (JSON): pin de Nodos → propiedad de Unreal, y al revés,
      con transformación opcional (escala o remapeo de ejes).
- [ ] Protección contra bucles: origen y debounce.
- [ ] API para gestionar los mapeos.

## Despliegue en el cliente

```
MyProject.exe -game -RenderOffScreen -RCWebControlEnable ^
  -BackendUrl=ws://backend:3000/unreal/link -InstanceId=render-01 -log
```

- Como servicio, con NSSM o una tarea programada que se reinicie si cae
  (fuera del alcance del backend).
- Abrir en el firewall el puerto de RC (30020) solo hacia la IP del backend.
- El backend deberá escuchar en una IP accesible, así que `API_KEY` pasa a ser
  obligatoria. Valorar un token también para `/unreal/link`.

## Riesgos y cosas a verificar

- El nombre exacto de los flags y la configuración de Remote Control en 5.7 en
  builds empaquetadas (Development frente a Shipping: comprobar que el plugin
  está incluido).
- Las rutas de objeto cambian entre sesiones con World Partition y actores
  spawneados. Por eso el catálogo es la fuente de verdad.
- Seguridad de RC: no tiene autenticación fuerte; mantenerlo en una red privada.
- Coste del diff en tick si hay muchos actores vigilados: limitar la frecuencia
  y la lista de propiedades.
- Datos de alta frecuencia (tracking, cámaras): valorar Live Link u OSC en
  lugar de RC.
- La imagen renderizada (Pixel Streaming o NDI) queda fuera de este plan.
