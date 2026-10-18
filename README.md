# StreamDB

Backend de una plataforma de streaming (TPO de Ingeniería de Datos II). Usa una API en Node.js + Express y cinco bases de datos: cuatro NoSQL y PostgreSQL como motor relacional adicional, solo para las licencias.

| Base       | Qué guarda                                                        | Puerto(s)               |
| ---------- | ----------------------------------------------------------------- | ----------------------- |
| MongoDB    | Catálogo (fichas con temporadas y episodios), cuentas, perfiles, dispositivos, log de sagas | 27017 |
| Neo4j      | Elenco, géneros, vínculos entre contenidos y señales de consumo (`VIO`) | 7474 (web), 7687 (Bolt) |
| Redis      | Sesiones activas y cupo por cuenta, "continuar viendo"            | 6379 (RedisInsight en 5540) |
| Cassandra  | Historial de visualizaciones e historial de sesiones              | 9042                    |
| PostgreSQL | Licencias de contenido                                            | 5432                    |

Las bases corren en Docker. La API corre directamente en tu máquina. Qué dato vive en qué motor y por qué está en [docs/matriz-trazabilidad.md](docs/matriz-trazabilidad.md); los cambios del DER, en [docs/DER_cambios.md](docs/DER_cambios.md).

## Requisitos

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (en Mac también sirve [Colima](https://github.com/abiosoft/colima): `brew install colima docker docker-compose` y `colima start --cpu 4 --memory 6`)
- [Node.js](https://nodejs.org/) 20 o superior (incluye npm)

> **Importante:** Neo4j y Cassandra usan bastante memoria. En Docker Desktop andá a
> **Settings → Resources** y asigná **al menos 4 GB de RAM**. Con 2 GB las bases tardan
> muchísimo en arrancar o se quedan colgadas.

## Puesta en marcha (primera vez)

1. **Clonar el repo e instalar dependencias**

   ```bash
   git clone <url-del-repo>
   cd StreamDB
   npm install
   ```

2. **Crear el archivo de variables de entorno**

   ```bash
   cp .env.example .env
   ```

   Los valores por defecto ya coinciden con `docker-compose.yml`, así que no hace falta cambiar nada.

3. **Levantar las bases de datos y esperar a que estén listas**

   Con Docker abierto:

   ```bash
   docker compose up -d --wait
   ```

   La primera vez descarga las imágenes, así que puede tardar varios minutos. `--wait` espera a que las bases con healthcheck estén listas: Redis, Mongo y PostgreSQL arrancan en segundos, Neo4j tarda alrededor de un minuto y Cassandra entre 1 y 3 minutos.

4. **Crear esquemas, índices y restricciones**

   ```bash
   npm run setup
   ```

   Corre `setup:mongo` (colecciones con validación e índices), `setup:neo4j` (restricciones de unicidad), `setup:cassandra` (keyspace y tablas) y `setup:postgres` (tabla `licencia` con su restricción de no superposición). Se puede correr más de una vez.

5. **Cargar los datos de prueba**

   ```bash
   npm run seed
   ```

   Deja los motores con datos reproducibles (semilla fija): 500 contenidos, 1.000 cuentas, 3.000 dispositivos, 2.000 actores, 1.500 vínculos, 50.000 visualizaciones y 999 licencias. En Redis carga el "continuar viendo" de cada perfil a partir del mismo historial que Cassandra, con la regla de P4: lo que quedó a medias, o el episodio siguiente si lo terminó. Las sesiones no se cargan: nacen con P2. Borra lo que hubiera antes en los cinco motores, así que sirve también para volver a un estado limpio. Al terminar imprime los **datos fijos para demos** (ver más abajo).

6. **Iniciar la API**

   ```bash
   npm run dev
   ```

   Se reinicia sola cada vez que guardás un cambio. Va a estar en `http://localhost:4000/api/v1`, o en el `PORT` y `API_PATH` que pongas en `.env`. Al arrancar también inicia la vigilancia de sesiones de P6 (listener de expiraciones de Redis y un barrido cada 30 segundos).

## Uso diario

```bash
docker compose up -d --wait   # levantar las bases
npm run dev                   # levantar la API
```

Al terminar:

```bash
docker compose stop    # apaga las bases y conserva los datos
```

## Panel de demo

Con la API levantada, abrí **http://localhost:4000/demo**. Desde ahí se ejecuta cada problema y cada falla por separado, con los datos fijos del seed, sin armar pedidos a mano.

- **Escenarios:** por problema, el caso normal, casos borde (cupo lleno, perfil no apto, licencia vigente) y un botón por cada paso de la saga para provocar la falla ahí (`?fallarEn=`).
- **Traza:** cada consulta que hizo el pedido, en orden, con su motor, la operación y cuánto tardó. Muestra lo que corre en paralelo (P7, trazabilidad de P8), el log de la saga en Mongo y lo que hacen los procesos de fondo (el listener de expiraciones de P6).
- **Saga:** el estado de cada paso (hecho, falló, compensado) leído de la colección `sagas`.
- **Estado de los motores:** cupo y sesiones en Redis, historial en Cassandra, señales `VIO` en Neo4j, estado de las fichas en Mongo y licencias en PostgreSQL. Resalta lo que cambió con el último escenario.
- **Antes → después:** cada ejecución guarda su propia tabla con lo que cambió en cada motor. En una falla compensada queda vacía: esa es la evidencia de que todo volvió a como estaba.
- **Verificaciones:** P1 «Dar de alta y verificar» busca la serie nueva en la exploración y en los vínculos (con una falla no tiene que estar en ninguno). P8 «Retirar algo que se está viendo» comprueba que el contenido retirado sale de «continuar viendo», de la exploración y del grafo, que P3 rechaza el progreso y que el historial se conserva.
- **Copiar como Markdown:** cada ejecución se copia con sus pedidos, la saga, la traza y la tabla de cambios, para pegarla como evidencia en el informe.
- **Reiniciar demo:** cierra las sesiones de la cuenta demo, vuelve a publicar lo que retiró P8 y borra las series creadas desde el panel.

La traza no cambia la lógica de los problemas: `src/demo/traza.js` envuelve los clientes de cada motor y solo registra los pedidos que traen el encabezado `x-traza` (lo manda el panel). La API se puede seguir usando con `curl` como se indica abajo.

## Datos fijos para demos

El seed siempre genera los mismos IDs (semilla fija), así que estos sirven para probar los problemas:

| Qué | ID |
| --- | --- |
| Serie "El faro del norte" (tiene secuela, contenido del mismo universo y similar) | `af5c457a-db23-4a1d-911c-d47904dcdcf6` |
| Cuenta `demo@streamdb.test` (límite de 2 sesiones) | `07c670a9-b5a5-4261-9ac0-ca2dff52b435` |
| Perfil Titular (+18) | `5ae05b96-31fe-4a57-9c2c-9f67b1ec4aba` |
| Perfil Adolescente (+13) | `76cce91f-f88f-49d7-afa3-df0f29972c3d` |
| Perfil Niños (+7) | `b0f5f051-e793-4573-9259-9c176542bff4` |

Un dispositivo cualquiera: `docker compose exec mongo mongosh streamdb --quiet --eval 'db.dispositivos.findOne()._id'`.

## Problemas y endpoints

Todos los endpoints llevan el prefijo `/api/v1`. Las escrituras con rollback aceptan `?fallarEn=<paso>`, que provoca una falla justo antes de ese paso: la saga compensa los pasos ya hechos y responde 500 con `pasoFallido` y `compensados`. Cada operación queda registrada en la colección `sagas` de Mongo.

| Problema | Endpoint | Pasos para `fallarEn` | Código |
| --- | --- | --- | --- |
| P1 Alta de serie | `POST /contenidos/series` | `ficha`, `episodios`, `nodo`, `elenco`, `vinculos`, `publicar` | `src/problemas/p1-alta-serie.js` |
| P2 Inicio de reproducción | `POST /reproducciones` con `{ idPerfil, idDispositivo, idContenido, idEpisodio? }` | `reservar_cupo`, `registrar_inicio` | `src/problemas/p2-inicio-reproduccion-sesiones.js` |
| P3 Progreso | `POST /reproducciones/:idSesion/progreso` con `{ posicionSeg, evento? }` (`reporte`, `pausa` o `cierre`); `GET /perfiles/:idPerfil/continuar-viendo`; `GET /perfiles/:idPerfil/historial?desde=AAAA-MM&hasta=AAAA-MM` | (sin rollback) | `src/problemas/p3-progreso.js` |
| P4 Fin de episodio | `POST /reproducciones/:idSesion/fin` | `marcar_finalizado`, `continuar_viendo`, `senal_vio` | `src/problemas/p4-fin-episodio.js` |
| P5 Recomendaciones | `GET /perfiles/:idPerfil/recomendaciones?limite=10` | (consulta) | `src/problemas/p5-recomendaciones.js` |
| P6 Expiración y cierre | Expiración automática (sin endpoint); `POST /cuentas/:idCuenta/cerrar-sesiones` (cierre remoto); `DELETE /reproducciones/:idSesion` (cierre manual); `GET /cuentas/:idCuenta/sesiones` | (sin rollback) | `src/problemas/p6-expiracion-cierre-sesiones.js` |
| P7 Exploración | `GET /contenidos?genero=&idActor=&idPlataforma=&idPerfil=&limite=&pagina=` | (consulta) | `src/problemas/p7-exploracion.js` |
| P8 Retiro y trazabilidad | `POST /contenidos/:id/retiro` con `{ fecha? }`; `POST /licencias/procesar-vencimientos?fecha=AAAA-MM-DD`; `GET /contenidos/:id/trazabilidad` | `continuar_viendo`, `marcar_nodo`, `retirar_ficha`, `vencer_licencias` | `src/problemas/p8-retiro-trazabilidad.js` |

Ejemplo:

```bash
# P2: un perfil empieza a ver la serie demo
curl -X POST localhost:4000/api/v1/reproducciones -H 'content-type: application/json' \
  -d '{"idPerfil":"5ae05b96-31fe-4a57-9c2c-9f67b1ec4aba","idDispositivo":"<id>","idContenido":"af5c457a-db23-4a1d-911c-d47904dcdcf6"}'

# P4 con falla provocada en el último paso: se compensan los dos anteriores
curl -X POST 'localhost:4000/api/v1/reproducciones/<idSesion>/fin?fallarEn=senal_vio'
```

## Probar fallas

Además de `?fallarEn=`, se puede apagar un motor en medio de una operación y ver que la saga compensa:

```bash
docker compose stop neo4j     # ej.: P4 falla en senal_vio y se revierten Cassandra y Redis
docker compose start neo4j
```

Con un motor caído, cada paso falla en 5 segundos como máximo (timeouts configurados en `src/db/`), así la compensación es rápida. Para P6, una sesión expira sola a los 120 segundos sin reportes de progreso; para no esperar, `docker compose exec redis redis-cli EXPIRE vida:<idSesion> 1` simula ese tiempo (en el panel: P6 → «Forzar la expiración»).

Pruebas automáticas (con los motores levantados y el seed cargado):

- `npm run prueba:saga`: el orquestador completa una saga y, con una falla en el último paso, compensa los anteriores.
- `npm run prueba:concurrencia`: con un solo lugar libre en el cupo, 5 dispositivos piden iniciar a la vez (P2). Gana uno solo, los demás reciben 409 y el cupo nunca supera el límite. Para comparar, repite la carrera con la versión ingenua (leer el cupo y después agregar, en dos comandos), que termina con 6 sesiones sobre un límite de 2. En el panel: P2 → «Dos dispositivos por el último lugar».

## Variables de entorno

| Variable                   | Valor por defecto                  |
| -------------------------- | ---------------------------------- |
| `PORT`                     | `4000`                             |
| `API_PATH`                 | `/api/v1`                          |
| `REDIS_URL`                | `redis://localhost:6379`           |
| `MONGO_URL`                | `mongodb://localhost:27017/streamdb` |
| `NEO4J_URI`                | `bolt://localhost:7687`            |
| `NEO4J_USER`               | `neo4j`                            |
| `NEO4J_PASSWORD`           | `password123`                      |
| `CASSANDRA_CONTACT_POINTS` | `127.0.0.1`                        |
| `CASSANDRA_DATACENTER`     | `datacenter1`                      |
| `CASSANDRA_KEYSPACE`       | `streamdb`                         |
| `POSTGRES_URL`             | `postgres://streamdb:streamdb@localhost:5432/streamdb` |

## Acceder a cada base manualmente

| Base       | Cómo entrar                                                                 |
| ---------- | --------------------------------------------------------------------------- |
| Neo4j      | Abrí http://localhost:7474 en el navegador (usuario `neo4j`, contraseña `password123`) |
| MongoDB    | `docker compose exec mongo mongosh streamdb`, o con MongoDB Compass en `mongodb://localhost:27017` |
| Redis      | `docker compose exec redis redis-cli`, o RedisInsight en http://localhost:5540 |
| Cassandra  | `docker compose exec cassandra cqlsh` (keyspace `streamdb`)                 |
| PostgreSQL | `docker compose exec postgres psql -U streamdb -d streamdb`                 |

## Comandos útiles de Docker

| Comando                              | Qué hace                                              |
| ------------------------------------ | ----------------------------------------------------- |
| `docker compose ps`                  | Muestra el estado de cada base                        |
| `docker compose logs -f <servicio>`  | Muestra los logs en vivo (ej: `docker compose logs -f neo4j`) |
| `docker compose restart <servicio>`  | Reinicia una base                                     |
| `docker compose stop`                | Apaga todo y conserva los datos                       |
| `docker compose down`                | Apaga y elimina los contenedores, pero conserva los datos |
| `docker compose down -v`             | ⚠️ Apaga todo y **borra los datos**                   |

Los datos se guardan en volúmenes de Docker (`redis_data`, `mongo_data`, `neo4j_data`, `cassandra_data`, `postgres_data`), así que sobreviven a reinicios.

## Problemas comunes

**Cassandra aparece como `unhealthy` o la app no puede conectarse**
Probablemente todavía está arrancando. Mirá los logs con `docker compose logs -f cassandra` y esperá. Si sigue igual después de 5 minutos, subí la RAM de Docker Desktop.

**Neo4j no responde y en los logs aparece `stop-the-world pause`**
A Docker le falta memoria. Subí la RAM en Docker Desktop y apagá contenedores de otros proyectos con `docker ps` y `docker stop <nombre>`.

**`port is already allocated` al hacer `docker compose up`**
Otro programa está usando ese puerto, por ejemplo un Mongo, Redis o PostgreSQL instalado localmente. Apagalo, o cambiá el puerto de la izquierda en `docker-compose.yml` (por ejemplo `"27018:27017"`) y actualizá el `.env`.

**Cambié la contraseña de Neo4j y no la toma**
`NEO4J_AUTH` solo se aplica la primera vez que se crea la base. Para resetearla, borrá el volumen con `docker compose down -v`. Ojo: esto borra todos los datos.

**`no existe el keyspace "streamdb"` al iniciar la API**
Falta el paso 4: corré `npm run setup`.

**Las sesiones no expiran solas**
La API activa las notificaciones de expiración de Redis al arrancar (`CONFIG SET notify-keyspace-events Ex`). En un Redis gestionado donde `CONFIG` está bloqueado, hay que activarlas desde el proveedor; mientras tanto, el barrido de cada 30 segundos las cierra igual.

## Estructura del proyecto

```
StreamDB/
├── docker-compose.yml        # Las 5 bases de datos (+ RedisInsight)
├── .env.example              # Plantilla de variables de entorno
├── package.json
├── src/
│   ├── app.js                # Punto de entrada de la API (rutas, errores, vigilancia de sesiones)
│   ├── db/                   # Un cliente por motor (con timeouts de 5 s)
│   ├── setup/                # Esquemas, índices y restricciones de cada motor
│   ├── seed/                 # Carga de datos de prueba (datos.js genera; un script por motor)
│   ├── lib/                  # saga.js (orquestador), ids.js (UUID compartido), errores.js
│   ├── problemas/            # p1 … p8: un archivo por problema
│   ├── rutas/                # Endpoints HTTP de cada problema
│   ├── demo/                 # Panel de demo (/demo): escenarios, traza por motor, estado y reinicio
│   └── pruebas/              # Pruebas del orquestador de sagas y de concurrencia de P2
└── docs/                     # Enunciado, matriz de trazabilidad, DER v2 y sus cambios
```
