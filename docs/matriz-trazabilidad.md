# StreamDB — Matriz de trazabilidad

7 de octubre de 2026 · Santiago Hanine

StreamDB reparte el dominio en cinco motores: cuatro NoSQL (MongoDB, Neo4j, Redis y Cassandra) y PostgreSQL como motor relacional adicional, solo para las licencias de contenido. Cada dato tiene un único motor dueño; si aparece en otro, es una copia deliberada con un responsable de sincronizarla.

## Criterios

- **Patrón de acceso:** cómo se lee y se escribe (por clave, recorrido de grafo, rango temporal, filtros combinados).
- **Volumen y frecuencia:** cuántos registros y cada cuánto se escriben.
- **Consistencia requerida:** fuerte (contratos, cupos de sesión) o eventual (señales para recomendaciones).
- **Identificador compartido:** todo objeto de negocio usa el mismo ID (UUID generado en la capa de aplicación) en todos los motores. Eso permite la trazabilidad del problema 8 y la idempotencia de las sagas.

## Arquitectura

![Arquitectura: capa de aplicación y cinco motores](arquitectura.png)

La capa de aplicación es la única que habla con los motores y coordina las escrituras que cruzan más de uno. PostgreSQL aparece con borde punteado porque es el motor relacional opcional.

## Matriz entidad/proceso → motor

Los volúmenes son los que generará el script de carga; el historial es la entidad de mayor volumen que exige el enunciado (50.000 o más registros).

| Entidad / proceso | Cómo se lee | Cómo se escribe | Volumen | Frecuencia | Consistencia | Motor |
| --- | --- | --- | --- | --- | --- | --- |
| Cuenta + Perfiles | Por `idCuenta`, con sus perfiles embebidos | Alta de cuenta, edición de perfil | 1.000 cuentas, 2.500 perfiles | L media, E baja | Fuerte (email único) | **MongoDB** |
| Dispositivo | Por `idDispositivo` | Registro al primer uso | 3.000 | L media, E baja | Fuerte | **MongoDB** |
| Contenido + Temporadas + Episodios | Ficha completa por `idContenido`; filtros combinados por género, actor y plataforma (P7) | Alta por el administrador (P1), retiro (P8) | 500 contenidos, 5.000 episodios | L muy alta, E baja | Fuerte para `estado` | **MongoDB** |
| PlataformaOrigen, Genero | Embebidos en la ficha y como filtros | Carga inicial | 10 plataformas, 20 géneros | L alta, E muy baja | Fuerte | **MongoDB** |
| Actor + Actuacion | Elenco de un contenido; contenidos de un actor | P1 | 2.000 actores, 6.000 actuaciones | L alta, E baja | Fuerte | **Neo4j** |
| Vínculos entre contenidos (secuela, precuela, mismo universo, similar) | Recorridos de 1 a 3 saltos | P1 | 1.500 relaciones | L alta, E baja | Fuerte | **Neo4j** |
| Señal de consumo (`VIO`) | Recomendaciones del perfil (P5); las veces y la última vista se calculan con `count()` y `max()` | Una relación por visualización terminada, identificada por `idVisualizacion` (P4) | ~20.000 aristas | L media, E media | Eventual | **Neo4j** |
| Sesión activa + cupo por cuenta | Contar sesiones de una cuenta | Abrir (P2), expirar y cerrar (P6) | Cientos simultáneas | L y E muy altas | Fuerte y atómica | **Redis** |
| Continuar viendo | Un puntero por perfil y contenido | Cada pocos segundos (P3), avance de episodio (P4) | 10.000 punteros | E muy alta | Último valor gana | **Redis** (con AOF) |
| Historial de visualizaciones | Por perfil y período; por contenido (P8) | Una fila por visualización: se crea en P2 y se actualiza por su clave exacta (upsert) en P3 y P4 | 50.000 o más | E muy alta, L media | Eventual | **Cassandra** |
| Licencia de contenido | Vigentes por contenido y región; vencidas a una fecha | Alta y renovación, pocas veces | 1.000 | L y E bajas | Fuerte, sin superposición | **PostgreSQL** |
| Log de sagas | Por `idSaga`; pendientes al reiniciar | Un cambio por paso | Uno por operación | E media | Fuerte (documento atómico) | **MongoDB** |

## Modelo relacional: Licencias (PostgreSQL)

La entidad nueva `Licencia` registra el permiso para mostrar un contenido en una región durante un período. Vive en PostgreSQL porque la base debe impedir que un contenido tenga dos licencias superpuestas en la misma región, y ningún motor NoSQL de la cursada lo garantiza sin código propio.

**Cambio en el DER:** se agrega `Licencia`, relacionada 1:N con `Contenido` (un contenido tiene muchas licencias) y 1:N con `PlataformaOrigen` (la plataforma la otorga). El retiro del problema 8 pasa a dispararse cuando vence una licencia.

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE licencia (
  id_licencia   UUID PRIMARY KEY,
  id_contenido  UUID NOT NULL,          -- mismo ID que en Mongo, Neo4j y Cassandra
  id_plataforma UUID NOT NULL,
  region        CHAR(2) NOT NULL,       -- código de país ISO, ej. 'AR'
  vigencia      DATERANGE NOT NULL,     -- [desde, hasta)
  estado        TEXT NOT NULL DEFAULT 'vigente'
                CHECK (estado IN ('vigente', 'vencida', 'rescindida')),
  -- un contenido no puede tener dos licencias superpuestas en la misma región
  EXCLUDE USING gist (id_contenido WITH =, region WITH =, vigencia WITH &&)
    WHERE (estado <> 'rescindida')
);

CREATE INDEX licencia_vencimiento ON licencia (upper(vigencia)) WHERE estado = 'vigente';
```

`id_contenido` no tiene clave foránea porque el contenido vive en MongoDB; la capa de aplicación verifica que exista antes de insertar.

**Ejemplo de datos**

| id_licencia | id_contenido | region | vigencia | estado |
| --- | --- | --- | --- | --- |
| `lic-001` | `c-7f3a` (Breaking Bad) | AR | [2025-01-01, 2028-01-01) | vigente |
| `lic-002` | `c-7f3a` (Breaking Bad) | ES | [2024-06-01, 2026-06-01) | vencida |
| `lic-003` | `c-91bd` (Dark) | AR | [2023-03-01, 2026-10-01) | vigente |

**Ejemplo de rechazo:** insertar una licencia de `c-7f3a` en AR para `[2027-01-01, 2029-01-01)` falla con `conflicting key value violates exclusion constraint`, porque se superpone con `lic-001`.

**Consulta que dispara el retiro (P8):** `lic-003` venció el 2026-10-01 y no tiene renovación, así que Dark se retira en AR.

```sql
SELECT id_licencia, id_contenido, region
FROM licencia
WHERE estado = 'vigente' AND upper(vigencia) <= CURRENT_DATE;
```

## Matriz de trazabilidad de identificadores

Cada fila es un identificador compartido y muestra cómo aparece en cada motor. Una celda vacía significa que ese motor no conoce el objeto. `idContenido` es el único que aparece en los cinco motores, y es el que usa la consulta de trazabilidad del problema 8.

| ID | MongoDB | Neo4j | Redis | Cassandra | PostgreSQL |
| --- | --- | --- | --- | --- | --- |
| `idContenido` | `contenidos._id` | `(:Contenido {id})` | En el valor de `cv:{idPerfil}:{idContenido}` y en el set `viendo:{idContenido}` | Columna de `historial_por_perfil`; clave de partición de `historial_por_contenido` | `licencia.id_contenido` |
| `idEpisodio` | `contenidos.temporadas[].episodios[].id` | | En el valor de `cv:{idPerfil}:{idContenido}` (en películas, el `idContenido`) | Columna común de ambas tablas de historial (nula en películas) | |
| `idPerfil` | `cuentas.perfiles[].id` | `(:Perfil {id})` | Parte de la clave `cv:{idPerfil}:…`; campo de `sesion:{idSesion}` | Clave de partición de `historial_por_perfil` | |
| `idCuenta` | `cuentas._id` | | Clave de `cupo:{idCuenta}` (ZSET de sesiones activas) | | |
| `idSesion` | | | `sesion:{idSesion}` (HASH con TTL) | Columna de ambas tablas de historial | |
| `idVisualizacion` | En `sagas.datos` (para compensar P2 y P4) | Propiedad de `[:VIO {idVisualizacion}]`, con restricción de unicidad | Campo de `sesion:{idSesion}`, junto con la fecha de inicio | Columna de clustering de ambas tablas de historial | |
| `idDispositivo` | `dispositivos._id` | | Campo de `sesion:{idSesion}` | | |
| `idActor` | En `contenidos.elenco[].idActor` (copia para P7) | `(:Actor {id})` | | | |
| `idLicencia` | En `contenidos.retiro.idLicencia` (motivo del retiro) | | | | `licencia.id_licencia` |
| `idSaga` | `sagas._id` | En `retiradoPor` del nodo, durante P8 | | | |

Todos los IDs son UUID generados en la capa de aplicación antes de escribir. Como el ID ya existe cuando se reintenta un paso, las escrituras son idempotentes: `upsert` en Mongo, `MERGE` en Neo4j, `SET` en Redis, `INSERT` sobre la misma clave en Cassandra y `ON CONFLICT DO NOTHING` en PostgreSQL.

## Matriz problema → motores

Los ocho problemas usan al menos dos motores. En las escrituras, el orden va de lo menos visible a lo más visible: el paso que "publica" el cambio para el usuario es siempre el último, así una falla nunca deja algo visible a medias.

| Problema | Tipo | Motores | Orden de lecturas y escrituras | Compensación si falla | ID que los une |
| --- | --- | --- | --- | --- | --- |
| P1 Alta de serie | Escritura + rollback | Mongo, Neo4j | 1. Mongo: ficha con `estado: borrador` → 2. Neo4j: nodo, elenco, géneros y vínculos → 3. Mongo: `estado: publicado` | Borrar nodo y relaciones en Neo4j; borrar el borrador en Mongo | `idContenido` |
| P2 Inicio de reproducción | Escritura + rollback | Redis, Mongo, Cassandra | 1. Mongo: leer `limiteSesiones` → 2. Redis: script Lua que verifica y reserva el cupo atómicamente; se generan `idVisualizacion` y la fecha de inicio **una sola vez** y se guardan en `sesion:{id}` con el perfil y el contenido → 3. Cassandra: registrar el inicio (fila nueva de la visualización) | Quitar la sesión del cupo en Redis (`ZREM`) y borrar `sesion:{id}` | `idSesion`, `idCuenta`, `idVisualizacion` |
| P3 Progreso | Escritura | Redis, Cassandra | 1. Redis: `cv:{perfil}:{contenido}` con la unidad y el segundo exacto (cada reporte) → 2. Cassandra: **upsert de la fila de la visualización en curso**, con la misma clave `(id_perfil, mes, fecha, id_visualizacion)`, actualizando `posicion_seg` y `fecha_fin`. Se hace cada N reportes **y al pausar o cerrar**. `idVisualizacion` y la fecha de inicio salen de `sesion:{id}` | No aplica: es un upsert de valor absoluto, repetirlo deja el mismo resultado. Si falla Cassandra, el siguiente checkpoint lo corrige | `idVisualizacion` (junto con `idPerfil` y el id de unidad) |
| P4 Fin de episodio | Escritura + rollback | Cassandra, Redis, Neo4j | 1. Cassandra: `finalizado = true` sobre la fila de la visualización (misma clave) → 2. Redis: `cv` apunta al episodio siguiente → 3. Neo4j: `MERGE (p)-[r:VIO {idVisualizacion: $id}]->(c) ON CREATE SET r.fecha = $fecha` | Borrar la relación `VIO` por su `idVisualizacion`; restaurar el `cv` anterior (guardado en el log de la saga); `finalizado = false` por la misma clave. Todas idempotentes | `idVisualizacion`, `idPerfil`, `idEpisodio` |
| P5 Recomendaciones | Consulta | Neo4j, Mongo, Redis | 1. Neo4j: recorrido desde los `VIO` recientes, excluyendo lo visto → 2. Mongo: fichas publicadas y aptas para la edad del perfil | No aplica | `idPerfil`, `idContenido` |
| P6 Expiración y cierre | Escritura | Redis, Cassandra | Expiración: TTL de `sesion:{id}` + limpieza del cupo por `ultimaActividad`. Cierre remoto: vaciar `cupo:{cuenta}` y borrar sus sesiones → registrar el cierre en Cassandra | No aplica (es idempotente) | `idCuenta`, `idSesion` |
| P7 Exploración | Consulta | Mongo, Redis, Neo4j | 1. Mongo: filtros combinados y cantidad de episodios → 2. Redis: progreso del perfil → 3. Neo4j: contenidos vinculados | No aplica | `idContenido`, `idPerfil` |
| P8 Retiro y trazabilidad | Escritura + rollback | PostgreSQL, Mongo, Neo4j, Redis, Cassandra | 1. Postgres: detectar la licencia vencida → 2. Redis: guardar y borrar los `cv` del contenido → 3. Neo4j: marcar el nodo como retirado → 4. Mongo: `estado: retirado` → 5. Postgres: licencia `vencida`. Cassandra no se toca: el historial se conserva | Restaurar los `cv` guardados; desmarcar el nodo; volver a `publicado` | `idContenido`, `idLicencia` |

## Ejemplo completo: *Dark* en los cinco motores

La serie *Dark* (`c-91bd`) y el perfil "Sofi" (`p-12ab`, de la cuenta `a-55e0`), que está viendo el episodio 2 de la temporada 1. Los IDs están abreviados para que se lean; en el sistema son UUID completos.

**MongoDB: ficha del contenido** (colección `contenidos`)

```json
{
  "_id": "c-91bd",
  "titulo": "Dark",
  "tipo": "serie",
  "estado": "publicado",
  "anioEstreno": 2017,
  "clasificacionEdad": 16,
  "plataforma": { "id": "pl-04", "nombre": "Netflix", "paisOrigen": "DE" },
  "generos": ["Ciencia ficción", "Misterio"],
  "elenco": [{ "idActor": "ac-301", "nombre": "Louis Hofmann", "personaje": "Jonas Kahnwald" }],
  "temporadas": [
    { "numero": 1, "episodios": [
      { "id": "e-91bd-1-1", "numero": 1, "titulo": "Secretos", "duracionSeg": 3060 },
      { "id": "e-91bd-1-2", "numero": 2, "titulo": "Mentiras", "duracionSeg": 2640 }
    ] }
  ]
}
```

**MongoDB: cuenta con perfiles** (colección `cuentas`)

```json
{
  "_id": "a-55e0",
  "email": "titular@ejemplo.com",
  "estado": "activa",
  "limiteSesiones": 2,
  "perfiles": [{ "id": "p-12ab", "nombre": "Sofi", "idioma": "es", "clasificacionEdad": 18 }]
}
```

**Neo4j: elenco, géneros, vínculos y señales de consumo**

```cypher
(:Contenido {id: 'c-91bd', titulo: 'Dark', clasificacionEdad: 16})
(:Actor {id: 'ac-301', nombre: 'Louis Hofmann'})-[:ACTUA_EN {personaje: 'Jonas Kahnwald'}]->(:Contenido {id: 'c-91bd'})
(:Contenido {id: 'c-91bd'})-[:DE_GENERO]->(:Genero {nombre: 'Ciencia ficción'})
(:Contenido {id: 'c-1899'})-[:RELACIONADO {tipo: 'mismo_universo'}]->(:Contenido {id: 'c-91bd'})
(:Perfil {id: 'p-12ab'})-[:VIO {idVisualizacion: 'v-0a17', fecha: datetime('2026-09-28T22:10Z')}]->(:Contenido {id: 'c-44f1'})
(:Perfil {id: 'p-12ab'})-[:VIO {idVisualizacion: 'v-3e92', fecha: datetime('2026-10-02T21:30Z')}]->(:Contenido {id: 'c-44f1'})
```

Hay una relación `VIO` por visualización terminada, y la cantidad de veces no se guarda: se calcula al consultar. Así, reintentar el paso de P4 o su compensación no suma ni resta de más.

```cypher
// unicidad de la señal (Neo4j 5.26 Community la soporta; también crea el índice que usa la compensación)
CREATE CONSTRAINT vio_visualizacion IF NOT EXISTS FOR ()-[r:VIO]-() REQUIRE r.idVisualizacion IS UNIQUE;

// P4, acción y compensación (las dos idempotentes)
MERGE (p)-[r:VIO {idVisualizacion: $id}]->(c) ON CREATE SET r.fecha = $fecha
MATCH ()-[r:VIO {idVisualizacion: $id}]->() DELETE r

// veces y última vista, calculadas (en una serie, count(DISTINCT c) cuenta el contenido una sola vez)
MATCH (:Perfil {id: $perfil})-[v:VIO]->(c) RETURN c, count(v) AS veces, max(v.fecha) AS ultima
```

**Redis: sesión, cupo y "continuar viendo"**

```text
ZSET  cupo:a-55e0          { s-7781 : 1791417600 }            # score = última actividad (epoch)
HASH  sesion:s-7781        idPerfil=p-12ab idDispositivo=d-3310 idContenido=c-91bd idEpisodio=e-91bd-1-2
                           idVisualizacion=v-5d20 fechaInicio=2026-10-07T21:40Z               TTL 120 s
HASH  cv:p-12ab:c-91bd     idEpisodio=e-91bd-1-2 segundo=1325 actualizado=2026-10-07T21:52Z
SET   viendo:c-91bd        { p-12ab }                          # perfiles mirando ahora (P8)
```

**Cassandra: historial de visualizaciones** (dos tablas, una por consulta)

```sql
CREATE TABLE historial_por_perfil (
  id_perfil uuid, mes text, fecha timestamp, id_visualizacion uuid,
  id_contenido uuid, id_episodio uuid,      -- id_episodio: nulo en películas
  id_sesion uuid, fecha_fin timestamp, posicion_seg int, finalizado boolean,
  PRIMARY KEY ((id_perfil, mes), fecha, id_visualizacion)
) WITH CLUSTERING ORDER BY (fecha DESC, id_visualizacion ASC);

CREATE TABLE historial_por_contenido (
  id_contenido uuid, fecha timestamp, id_visualizacion uuid,
  id_perfil uuid, id_episodio uuid, id_sesion uuid,
  fecha_fin timestamp, posicion_seg int, finalizado boolean,
  PRIMARY KEY ((id_contenido), fecha, id_visualizacion)
) WITH CLUSTERING ORDER BY (fecha DESC, id_visualizacion ASC);
```

Reglas de la clave:

- `fecha` es el **momento en que empezó la visualización** y no cambia mientras dura; `mes` se calcula a partir de ella. Una visualización que cruza el cambio de mes queda en la partición del mes en que empezó.
- **P2** crea la fila; **P3** (cada checkpoint) y **P4** (`finalizado`) hacen upsert sobre la misma clave exacta. Reintentar cualquier paso no duplica filas.
- Cada escritura va a las dos tablas en un `BATCH` *logged*: si una se aplica, Cassandra garantiza que la otra también.
- Con `id_visualizacion` en la clave, `id_episodio` es una columna común y puede ser nula en películas.
- Si Redis se pierde, "continuar viendo" se reconstruye leyendo la última fila de `(id_perfil, mes actual)` con `LIMIT 1` (y si el mes está vacío, el anterior).
- `historial_por_contenido` particiona solo por contenido. Con 50.000 filas no es un problema; particionar por `(id_contenido, mes)` queda como mejora opcional para títulos muy vistos.

Se probó en Cassandra 4.1 (keyspace descartable): tres checkpoints y dos `finalizado = true` sobre una visualización que empieza el 31/10 y termina el 1/11 dejan una sola fila, en la partición de octubre.

| id_perfil | mes | fecha | id_visualizacion | id_contenido | id_episodio | fecha_fin | posicion_seg | finalizado |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| p-12ab | 2026-10 | 2026-10-07 21:40 | v-5d20 | c-91bd | e-91bd-1-2 | 2026-10-07 22:02 | 1325 | false |
| p-12ab | 2026-10 | 2026-10-07 21:02 | v-41c8 | c-91bd | e-91bd-1-1 | 2026-10-07 21:53 | 3060 | true |

**PostgreSQL: licencia**

| id_licencia | id_contenido | region | vigencia | estado |
| --- | --- | --- | --- | --- |
| lic-003 | c-91bd | AR | [2023-03-01, 2026-10-01) | vigente |

## Consulta de trazabilidad (P8)

Con un solo `idContenido`, la función `trazabilidad(idContenido)` consulta los cinco motores en paralelo y une los resultados. Cada dato se lee de su motor dueño, no de una copia, como exige la sección 6 del enunciado.

| Dato pedido | Motor | Lectura |
| --- | --- | --- |
| Ficha | MongoDB | `contenidos.findOne({ _id })` |
| Vínculos | Neo4j | `MATCH (c:Contenido {id: $id})-[r:RELACIONADO]-(o) RETURN o.id, o.titulo, r.tipo` |
| Perfiles mirando ahora | Redis | `SCARD viendo:{idContenido}` |
| Historial de visualizaciones | Cassandra | `SELECT * FROM historial_por_contenido WHERE id_contenido = ?` |
| Licencias | PostgreSQL | `SELECT * FROM licencia WHERE id_contenido = $1` |

Resultado para `c-91bd`:

```json
{
  "idContenido": "c-91bd",
  "ficha": { "titulo": "Dark", "tipo": "serie", "estado": "publicado", "episodios": 26 },
  "vinculos": [{ "id": "c-1899", "titulo": "1899", "tipo": "mismo_universo" }],
  "viendoAhora": 1,
  "historial": { "total": 412, "ultimas": [{ "idPerfil": "p-12ab", "episodio": "e-91bd-1-2", "fecha": "2026-10-07T21:40Z" }] },
  "licencias": [{ "id": "lic-003", "region": "AR", "hasta": "2026-10-01", "estado": "vigente" }]
}
```

Los números de este JSON son ilustrativos.

## Desnormalizaciones y responsable de sincronizarlas

| Dato duplicado | Dueño | Copia en | Para qué | Quién lo sincroniza |
| --- | --- | --- | --- | --- |
| Elenco (nombre y personaje) | Neo4j | Mongo `contenidos.elenco` | Mostrar y filtrar por actor en P7 sin cruzar motores | Saga P1 (se escribe en ambos en el mismo alta) |
| `clasificacionEdad` y `estado` del contenido | Mongo | Propiedades del nodo `:Contenido` en Neo4j | Filtrar recomendaciones dentro del recorrido (P5) | Sagas P1 y P8 |
| Géneros | Mongo (nombres en la ficha) | Nodos `:Genero` en Neo4j | Recorridos "mismo género" | Saga P1 |
| Perfiles mirando un contenido | Redis `sesion:{id}` | Redis `viendo:{idContenido}` | Contar en O(1) en P8 | Mismo script Lua de P2 y P6 |
| Historial | Cassandra `historial_por_perfil` | Cassandra `historial_por_contenido` | Consultar por contenido (P8) | Un `BATCH` *logged* en cada escritura (inicio en P2, checkpoints en P3, fin en P4), con la misma clave en las dos tablas |

## Historial de cambios

| Fecha | Cambio | Motivo |
| --- | --- | --- |
| 2026-10-12 | **A1.** Historial en Cassandra: se agrega `id_visualizacion` a la clave y `fecha` pasa a ser la fecha de inicio, fija | Sin un id, cada checkpoint creaba una fila nueva y P4 no podía identificar la fila a marcar; una visualización que cruzaba de mes cambiaba de partición |
| 2026-10-12 | **A2.** Señal `VIO` en Neo4j: una relación por visualización, identificada por `idVisualizacion`; el contador `veces` se calcula con `count()` | Un contador incrementado no es idempotente: reintentar el paso o la compensación de P4 sumaba o restaba de más |
| 2026-10-12 | **A3.** P3 se redacta como upsert de la fila de la visualización en curso, también al pausar o cerrar | "Evento de progreso" se podía leer como una fila nueva por checkpoint; sin el checkpoint al cerrar se perdían los últimos segundos |
