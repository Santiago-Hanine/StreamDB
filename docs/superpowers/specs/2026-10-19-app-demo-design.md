# App de demo "StreamDB" (vista usuario + admin)

## Intención

En unos días hay que presentar el TPO y mostrar **cómo interactúan las bases NoSQL** (y PostgreSQL) para resolver los ejercicios P1–P8. El panel actual (`/demo`) funciona, pero se ve como una tarea: un formulario por problema con escenarios. Se quiere algo más práctico y distinto: **una app de streaming que se usa como un usuario real**, donde cada clic ejecuta un ejercicio y, al costado, se ve qué hizo cada motor.

Éxito: durante la presentación, el que expone navega la app como usuario o como admin, y el profesor entiende qué base intervino en cada acción y por qué, sin leer JSON ni formularios.

## Objetivos

- Una página nueva, distinta del panel, con aspecto de app de streaming (oscura, carátulas, filas).
- Al entrar, elegir **usuario** o **admin**.
- Usuario: elegir **cuenta**, después **perfil** ("¿Quién está mirando?") y **dispositivo**. Se puede cambiar de perfil y de dispositivo en cualquier momento desde la barra superior.
- Cada acción del usuario dispara un ejercicio real contra la API existente:

  | Acción en la app | Ejercicio |
  |---|---|
  | ▶ Reproducir / Continuar | P2 inicio de reproducción y cupo |
  | La barra avanza mientras "mira", pausar, salir | P3 progreso y continuar viendo |
  | Terminar el episodio → pasa al siguiente | P4 fin de episodio |
  | Fila "Porque viste…" | P5 recomendaciones |
  | Cambiar a otro dispositivo y quedarse sin lugar; "Cerrar sesión en todos lados"; sesión que expira | P2 y P6 sesiones |
  | Explorar con filtros por género, actor y plataforma | P7 exploración |
  | Mi actividad (historial) | P3 historial (Cassandra) |

- Admin: consola con pestañas **Catálogo** (alta de serie, P1), **Licencias** (retirar un contenido y procesar vencimientos a una fecha; trazabilidad, P8), **Sesiones activas** (ver y cerrar, P6) y **Fallas** (elegir el paso en el que falla el próximo pedido, para mostrar el rollback de la saga).
- **Columna lateral "Qué pasó con tu último clic"**, visible en usuario y en admin: se encienden los motores que intervinieron (con sus colores), una frase simple por motor ("Redis reservó el lugar 1 de 2") y, desplegable, la operación exacta que corrió. Si hubo saga, muestra los pasos y la compensación.
- Las secciones de la pantalla llevan una etiqueta con el motor que las alimenta ("Continuar viendo · Redis", "Porque viste… · Neo4j").
- La pantalla de inicio muestra si los cinco motores están conectados.
- Un botón "Reiniciar demo" (en admin) que deja los datos como al principio.

## No objetivos

- Login real o contraseñas: elegir la cuenta alcanza.
- Reproducción de video real: el "player" es simulado (barra que avanza).
- Reemplazar el panel actual: `/demo` queda tal cual como respaldo técnico.
- Cambiar la lógica de los problemas en `src/problemas/`.

## Anti-objetivos (sería un fracaso aunque funcione)

- Que vuelva a parecer un formulario o una lista de escenarios P1…P8.
- Que la columna de motores muestre JSON crudo como contenido principal: primero la frase simple, el detalle es opcional.
- Que algo se rompa en vivo por depender de datos que el seed no garantiza.

## Restricciones

- La sirve Express, igual que el panel: nunca se abre como `file://`.
- Usa la API existente (`/api/v1/...`) y la traza existente (`src/demo/traza.js`, encabezado `x-traza`, `/demo/api/trazas/:id`).
- Datos: los fijos del seed (cuenta `demo@streamdb.test` con sus tres perfiles, serie "El faro del norte") más otras cuentas del seed.
- Cassandra sin `ALLOW FILTERING`: toda lectura nueva usa la partition key completa.
- Ver sesiones y su expiración en tiempo real: la sesión expira a los 120 s sin reportes (P6).

## Decidido en la conversación

- Dirección visual A ("app de streaming de verdad") con columna lateral de motores.
- Pantalla de inicio con dos entradas: usuario y admin.
- Flujo de usuario: cuenta → perfil → dispositivo; los tres se pueden cambiar después.
- El admin incluye P1, P8, sesiones y simulación de fallas.

## Decisiones mías (revisables)

- **Ubicación y tecnología:** HTML + JavaScript sin frameworks ni build, como el panel actual, en `src/demo/app.html` (puede partirse en `app.css`/`app.js` servidos estáticos), servida en **`/app`**. Las rutas auxiliares nuevas van en `src/demo/rutas.js` bajo `/demo/api/...`.
- **Cuentas:** la cuenta demo primero, más 3 o 4 cuentas activas del seed con distinta cantidad de perfiles y pantallas, y un buscador por email.
- **Dispositivos:** el seed no los asocia a cuentas; se muestra una lista fija de 4 o 5 dispositivos variados (TV, móvil, web, consola), elegidos de la colección `dispositivos` de forma determinística.
- **Player simulado:** el tiempo corre acelerado (por ejemplo, 1 s real = 30 s de episodio) y se manda un reporte de progreso (P3) cada pocos segundos; hay un botón "Saltar al final" para llegar a P4 sin esperar.
- **Carátulas:** sin imágenes externas; degradados de color generados a partir del ID del contenido, con el título encima.
- **Inicio de usuario:** el "destacado" es lo primero de "Continuar viendo" o, si no hay, "El faro del norte"; después las filas Continuar viendo (Redis), Porque viste… (Neo4j) y algunas por género (Mongo, vía P7).
- **Fallas:** se eligen en Admin → Fallas y se aplican al **próximo** pedido que tenga ese paso (`?fallarEn=`), también si se hace desde la vista usuario. Queda un aviso visible mientras haya una falla "armada".
- **Alta de serie (P1):** formulario corto precargado (título, géneros, plataforma, un par de actores y episodios), con el título prefijado `Demo P1 · ` para que "Reiniciar demo" la borre como hoy.
- **Licencias (P8):** lista buscable de contenidos con sus licencias y estado; arriba, destacados "El faro del norte" (licencia vigente) y uno con todas sus licencias vencidas (el `vencido` que ya calcula `datosDemo()`). Después de retirar, el usuario deja de verlo en el catálogo y en "Continuar viendo".
- **Mostrar P6 sin esperar 2 minutos:** en Sesiones activas, cada sesión tiene "Forzar expiración" (ruta existente `/demo/api/expirar/:idSesion`).

## A cargo de quien lo construya

- Diseño visual fino (tipografía, espaciados, animación de los motores al encenderse).
- Las frases simples por motor: se derivan de la traza por motor y operación, como hace `relato()` / `usoMotores()` del panel actual.
- Qué rutas auxiliares nuevas hacen falta (listado de cuentas para elegir, dispositivos, estado de conexión de los motores) y su forma exacta.
- Comportamiento en celular: no es prioridad, la demo se proyecta.
