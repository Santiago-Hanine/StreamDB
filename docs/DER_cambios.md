# StreamDB — Evolución del DER (v1 → v2)

Este documento explica **qué cambió** entre el DER de partida (Etapa 1) y el DER actualizado
([DER_StreamDB_v2.drawio](DER_StreamDB_v2.drawio)), **por qué**, y qué recomendaciones del
enunciado se adoptaron. Es la base de la sección 2 del informe técnico ("Evolución del DER").
La distribución de cada entidad en los motores está en [matriz-trazabilidad.md](matriz-trazabilidad.md).

Cómo leer el diagrama v2 (notación de Chen): en amarillo está lo **nuevo**, con borde naranja grueso
lo **modificado**, y en azul/verde lo que quedó **igual**. En una esquina del diagrama hay una
leyenda con lo eliminado.

---

## 1. Resumen de cambios

| # | Cambio | Tipo | Origen |
|---|---|---|---|
| 1 | Se agregan **Temporada** y **Episodio** | Entidades nuevas | Recomendación 1 del enunciado |
| 2 | `HistorialReproduccion` se reemplaza por **Visualizacion** (una fila por evento, con posición y `finalizado`) | Entidad reemplazada | Recomendación 3 |
| 3 | Se elimina la relación **Controla** (Cuenta–SesionActiva) | Relación eliminada | Recomendación 2 |
| 4 | Se agrega `tipoRelacion` a **Relaciona** (+ valor `mismo_universo`) | Atributo de relación | Recomendación 4 |
| 5 | Se agrega `Contenido.estado` | Atributo nuevo | Lo exigen P1 y P8 |
| 6 | Se agrega la entidad **Licencia** (PostgreSQL) | Entidad nueva | Lo exige P8 (retiro por fin de licencia) |
| 7 | SesionActiva pasa a **reproducir un Contenido** (relación Reproduce, 0..1) | Relación nueva | Lo exigen P6 y P8 |
| 8 | SesionActiva suma `fechaFin` y `motivoCierre` | Atributos nuevos | Lo exige P6 |
| 9 | `clasificacionEdad` pasa a tener un **dominio numérico ordenado** | Regla / dominio | Lo exige P5 |
| 10 | **Dispositivo** pasa a pertenecer a una Cuenta (relación Vincula) | Relación nueva | Propuesta propia |
| 11 | `Contenido.duracion` queda solo para películas; en series la duración es de cada `Episodio` | Atributo acotado | Consecuencia del cambio 1 |
| 12 | La relación recursiva se guarda en **un solo sentido** (`secuela`) | Regla | Propuesta propia |
| 13 | Se corrige el typo `progesoSegundos` → `posicionSegundos` | Corrección | Propuesta propia |

---

## 2. Detalle y justificación de cada cambio

### 2.1 Temporada y Episodio (recomendación 1 — adoptada)

**Qué cambió.** Nuevas entidades `Temporada` (`idTemporada`, `numero`, `titulo`) y `Episodio`
(`idEpisodio`, `numero`, `titulo`, `duracion`). Relaciones `Contenido 1:N Temporada` (Organiza) y
`Temporada 1:N Episodio` (Contiene).

**Por qué.** En el DER de partida el historial apuntaba a `Contenido`, y `Contenido.duracion` era un
único valor. Eso no sirve para una serie: el progreso se guarda **por episodio** y la duración de una
serie no es un número. Sin Episodio tampoco se pueden resolver:
- **P1** (el alta de una serie incluye temporadas y episodios),
- **P4** (al terminar un episodio, "continuar viendo" pasa al *siguiente*),
- **P7** (mostrar cantidad de episodios por resultado).

**Decisión de diseño: la película es su propia unidad reproducible (sin episodio implícito).** Temporada
y Episodio existen **solo para series**. La "unidad reproducible" (la que se mira, de la que se guarda
progreso y a la que apunta "continuar viendo") es **un episodio, o la película misma**. Reglas:
- `Contenido.duracion` se usa solo en películas; en series la duración es la de cada Episodio.
- `Visualizacion` apunta **siempre a un Contenido** y, si es serie, además a un Episodio (relación 0..1).
- En los motores que necesitan un único id de unidad (Redis `cv`, columna `id_episodio` de Cassandra, que
  no admite nulos en la clave), **para una película el id de unidad es su `idContenido`**. La capa de
  aplicación lo resuelve en un solo lugar (`resolverUnidad(id)`).

Por qué esta y no un episodio "técnico" por película: no obliga a inventar datos ni a cambiar el esquema
de Mongo ya implementado (la película guarda `duracionSeg` en el contenido), y es lo que describe el plan
del grupo. Alternativa descartada: crear 1 temporada + 1 episodio implícitos por película; simplifica el
historial pero fuerza datos artificiales y igual requiere casos especiales (cantidad de episodios en P7,
"episodio siguiente" en P4).

### 2.2 HistorialReproduccion → Visualizacion (recomendación 3 — adoptada)

**Qué cambió.** Se elimina `HistorialReproduccion` y la relación `Registra` (Historial–Contenido). Se
crea `Visualizacion`, **una fila por evento de visualización**:

| Atributo | Descripción |
|---|---|
| `idVisualizacion` (PK) | Identificador único del evento; es el que viaja entre motores |
| `fechaInicio`, `fechaFin` | Cuándo empezó y terminó la visualización |
| `posicionSegundos` | Último punto alcanzado en esa visualización |
| `finalizado` | Si se vio completa |
| (relaciones) | Perfil (Genera), Contenido (Registra, siempre), Episodio (Corresponde a, solo series), SesionActiva (Origina) |

**Por qué.** El enunciado pide declarar si el historial guarda una fila por par perfil–contenido o una
por visualización, con su clave única. Se elige **una fila por visualización** (la clave es
`idVisualizacion`). Es el mayor volumen del sistema (+50k filas), solo se agrega, y de ahí salen
P3 (historial por perfil y período), P5 (señal de recomendación) y P8 (trazabilidad).

**Por qué no hay una entidad Progreso separada.** El plan original (docx) separaba además un `Progreso`
(una fila por perfil y episodio). Se descartó porque:
- "Continuar viendo" (P3) necesita solo el **último punto de cada perfil**, y eso es estado derivado y de
  altísima frecuencia de escritura: vive en **Redis** (`cv:{perfil}:{contenido}`), no es una entidad del
  dominio.
- La copia durable ya existe: `posicionSegundos` y `finalizado` de la última Visualizacion del perfil.
  Si Redis se pierde, "continuar viendo" se reconstruye leyendo el último registro del perfil.
- Menos entidades, un paso menos en las sagas (P3, P4) y una tabla menos en Cassandra.

Lo que se pierde: retomar un episodio *anterior* en su posición exacta (por ejemplo, volver al 2 estando
en el 5). El enunciado no lo exige.

**Reglas que dependen de este cambio** (para que las sagas sean idempotentes):
1. **Un checkpoint no crea filas nuevas.** `fechaInicio` queda fija durante toda la visualización (ya
   está en `sesion:{id}`), y cada checkpoint de P3 hace upsert de la misma fila con la posición nueva.
   Si `fecha` cambiara en cada checkpoint, el historial se llenaría de filas por episodio.
2. **`idVisualizacion` se genera al iniciar la reproducción** y se guarda en la sesión; P4 y P8 lo usan
   para compensar y trazar. Como la Visualizacion en curso (con `fechaFin` vacía) vincula a la sesión con
   la unidad que está viendo, la sesión no necesita guardar el episodio.
3. **La señal de recomendación (`VIO` en Neo4j) se identifica con `idVisualizacion`** (o equivalente
   estable), no con un contador `veces`: un contador incrementado no es idempotente (un reintento
   cuenta de más) ni se puede compensar de forma segura.

### 2.3 Eliminar la relación Controla (recomendación 2 — adoptada)

**Qué cambió.** Se saca la relación `Cuenta 1:N SesionActiva`. La cuenta de una sesión se deduce con
`SesionActiva → Perfil → Cuenta`.

**Por qué.** Era una referencia redundante: guardar `idCuenta` e `idPerfil` permite inconsistencias
(un perfil de la cuenta A en una sesión "de" la cuenta B). El perfil siempre se elige antes de iniciar la
reproducción, así que no hay un caso que justifique mantenerla.

**Aclaración para el informe.** En Redis el cupo se controla por **cuenta** (`cupo:{idCuenta}`), así que
en esa capa se usa el `idCuenta` igualmente. Es una desnormalización deliberada: el dato se deriva del
perfil al abrir la sesión y la capa de aplicación (P2) es la responsable de mantenerlo coherente.

### 2.4 `tipoRelacion` en la relación recursiva (recomendación 4 — adoptada)

**Qué cambió.** El rombo `Relaciona` (Contenido–Contenido, N:N) tiene ahora el atributo `tipoRelacion`
con valores `secuela`, `precuela`, `similar` y `mismo_universo`.

**Por qué.** Aparecía solo en el modelo relacional y no en el DER. `mismo_universo` lo piden
explícitamente P1 ("secuela de, del mismo universo") y alimenta P5.

### 2.5 `Contenido.estado` (propuesta — exigida por P1 y P8)

**Qué cambió.** Nuevo atributo `estado` ∈ {`borrador`, `publicado`, `retirado`}.

**Por qué.** Es lo que hace posible el manejo de fallas:
- **P1:** la serie se inserta como `borrador`, se escribe todo lo demás y **recién al final** pasa a
  `publicado`. Si algo falla, nunca queda visible una serie incompleta.
- **P8:** el retiro es un cambio de estado a `retirado` (el contenido y su historial se conservan).
- **P5/P7:** exploración y recomendaciones filtran por `publicado`.

### 2.6 Licencia (propuesta del grupo — exigida por P8)

**Qué cambió.** Nueva entidad `Licencia` (`idLicencia`, `region`, `fechaDesde`, `fechaHasta`, `estado`
∈ {`vigente`, `vencida`, `rescindida`}), con dos relaciones 1:N: `Contenido – Cubre – Licencia` y
`PlataformaOrigen – Concede – Licencia`.

**Por qué.** P8 retira un contenido "por fin de licencia", pero el DER de partida no modelaba licencias:
el disparador del retiro no existía. Con Licencia, el retiro se dispara cuando vence la licencia.
Además hay una regla de negocio que conviene que la garantice la base: **un contenido no puede tener dos
licencias superpuestas en la misma región**. Eso justifica el motor relacional adicional (PostgreSQL,
con restricción `EXCLUDE ... USING gist` sobre el rango de fechas), que el enunciado permite solo para un
proceso que lo justifique. En el DER el período se modela como dos atributos atómicos
(`fechaDesde`, `fechaHasta`); en PostgreSQL se materializa como `DATERANGE`.

### 2.7 SesionActiva reproduce un Contenido (propuesta — exigida por P6 y P8)

**Qué cambió.** Nueva relación `Reproduce` (`SesionActiva N : 0..1 Contenido`).

**Por qué.** P8 pide "cuántos perfiles lo están viendo ahora" y P6/P3 trabajan por sesión: sin saber qué
contenido está reproduciendo cada sesión, esa consulta no se puede responder. Es `0..1` porque una sesión
puede estar abierta sin estar reproduciendo nada. Se relaciona con el Contenido (no con el Episodio) porque
alcanza para "viendo ahora" y evita una referencia redundante: el episodio en curso se obtiene de la
Visualizacion abierta de esa sesión.

### 2.8 `fechaFin` y `motivoCierre` en SesionActiva (propuesta — exigida por P6)

**Qué cambió.** Dos atributos nuevos. `motivoCierre` ∈ {`manual`, `expirada`, `cierre_remoto`}.

**Por qué.** `estado` (activa / cerrada / expirada) dice *en qué quedó* la sesión pero no *cuándo* ni
*por qué*. P6 distingue la expiración automática del cierre remoto por el titular, y el registro
histórico de sesiones (en Cassandra) necesita esa información para ser trazable.

### 2.9 Dominio ordenado de `clasificacionEdad` (propuesta — exigida por P5)

**Qué cambió.** Se define el dominio y la regla de comparación (no cambia el nombre del atributo):

- Dominio numérico ordenado: `0` (ATP) < `7` < `13` < `16` < `18` (es el que ya valida el esquema de Mongo).
- `Contenido.clasificacionEdad` = edad mínima recomendada del contenido.
- `Perfil.clasificacionEdad` = máxima clasificación que el perfil puede ver.
- Regla: un contenido es apto para un perfil si `contenido.clasificacionEdad ≤ perfil.clasificacionEdad`.

**Por qué.** P5 excluye "lo que no corresponde a la clasificación por edad del perfil". Con un texto
libre esa comparación no se puede hacer en una consulta (ni en Neo4j ni en un índice de Mongo); con un
dominio numérico ordenado sí.

### 2.10 Dispositivo pertenece a una Cuenta (propuesta propia — opcional)

**Qué cambió.** Nueva relación `Vincula` (`Cuenta 1 : N Dispositivo`).

**Por qué.** En el DER de partida Dispositivo no se relacionaba con nada salvo con las sesiones, pero
tiene `fechaRegistro`, lo que presupone que está "registrado" en algún lado. Con el vínculo queda claro
a quién pertenece, y habilita un cierre remoto "por dispositivo" además de "por cuenta" (P6). Es el único
cambio del que se puede prescindir sin romper ningún problema.

### 2.11 `duracion` queda solo para películas en Contenido (consecuencia de 2.1)

La duración de una serie no es un valor único: es la de cada Episodio (la total se calcula sumando). En
una película es la del propio contenido.

### 2.12 La recursiva se guarda en un solo sentido (propuesta propia)

`secuela` y `precuela` son inversas: guardar las dos es redundante y expone a inconsistencias (A secuela
de B pero B no precuela de A). Regla: **se almacena solo `secuela`** (origen = el anterior, destino = el
que continúa) y `precuela` se obtiene recorriendo la relación al revés. `similar` y `mismo_universo`
son simétricas y se consultan sin dirección en Neo4j.

### 2.13 Typo corregido

El diagrama de partida decía `progesoSegundos`; en v2 el atributo vive en Visualizacion como
`posicionSegundos` (nombre más preciso: es la posición alcanzada, no un acumulado).

---

## 3. Qué recomendaciones del enunciado se adoptaron

| Recomendación (sección 13 del enunciado) | Decisión |
|---|---|
| 1. Series con temporadas y episodios | **Adoptada** (2.1) |
| 2. Eliminar `idCuenta` redundante de SesionActiva | **Adoptada**, con la salvedad del cupo por cuenta en Redis (2.3) |
| 3. Historial: fila por perfil–contenido o por visualización | **Adoptada: una fila por visualización** (2.2) |
| 4. `tipoRelacion` también en el DER | **Adoptada** (2.4) |

No se descartó ninguna.

---

## 4. Modelo final por entidad

| Entidad | PK | Referencias | Atributos |
|---|---|---|---|
| Cuenta | `idCuenta` | — | email (único), fechaAlta, estado, limiteSesiones |
| Perfil | `idPerfil` | idCuenta | nombre, idioma, clasificacionEdad, fechaCreacion |
| Dispositivo | `idDispositivo` | idCuenta | tipo, modelo, sistemaOperativo, fechaRegistro |
| SesionActiva | `idSesion` | idPerfil, idDispositivo, idContenido (0..1) | fechaInicio, ultimaActividad, fechaFin, estado, motivoCierre |
| PlataformaOrigen | `idPlataforma` | — | nombre, paisOrigen |
| Contenido | `idContenido` | idPlataforma | titulo, descripcion, tipo, anioEstreno, clasificacionEdad, **estado**, duracion (solo películas) |
| Licencia | `idLicencia` | idContenido, idPlataforma | region, fechaDesde, fechaHasta, estado |
| Temporada | `idTemporada` | idContenido | numero, titulo |
| Episodio | `idEpisodio` | idTemporada | numero, titulo, duracion |
| Actor | `idActor` | — | nombre, apellido, fechaNacimiento |
| Genero | `idGenero` | — | nombre, descripcion |
| Actuacion | `idActuacion` | idActor, idContenido | personaje, tipoParticipacion |
| Visualizacion | `idVisualizacion` | idPerfil, idContenido, idEpisodio (0..1, solo series), idSesion | fechaInicio, fechaFin, posicionSegundos, finalizado |
| CONTENIDO_GENERO (N:M) | `(idContenido, idGenero)` | | |
| CONTENIDO_RELACIONADO (N:M) | `(idContenidoOrigen, idContenidoDestino)` | | tipoRelacion |

### Cardinalidades

| Relación | Cardinalidad |
|---|---|
| Cuenta – Posee – Perfil | 1 : N |
| Cuenta – Vincula – Dispositivo | 1 : N |
| Perfil – Inicia – SesionActiva | 1 : N |
| Dispositivo – Utiliza – SesionActiva | 1 : N |
| SesionActiva – Reproduce – Contenido | N : 0..1 |
| Perfil – Genera – Visualizacion | 1 : N |
| SesionActiva – Origina – Visualizacion | 1 : N |
| Visualizacion – Registra – Contenido | N : 1 |
| Visualizacion – Corresponde a – Episodio | N : 0..1 (solo series) |
| PlataformaOrigen – Provee – Contenido | 1 : N |
| PlataformaOrigen – Concede – Licencia | 1 : N |
| Contenido – Cubre – Licencia | 1 : N |
| Contenido – Organiza – Temporada | 1 : N |
| Temporada – Contiene – Episodio | 1 : N |
| Contenido – Clasifica – Genero | N : M |
| Contenido – Relaciona – Contenido | N : N (recursiva, con `tipoRelacion`) |
| Contenido – Incluye – Actuacion | 1 : N |
| Actor – Participa – Actuacion | 1 : N |

---

## 5. Desnormalizaciones deliberadas que introduce el cambio de DER

El enunciado exige declarar qué dato se duplica, dónde vive y quién lo mantiene sincronizado.

| Dato duplicado | Dónde vive | Quién lo mantiene |
|---|---|---|
| `idCuenta` de una sesión (derivable del perfil) | Clave de cupo en Redis (`cupo:{idCuenta}`) | App, al abrir la sesión (P2) |
| `clasificacionEdad` y `estado` del contenido | Mongo (fuente) y nodo del contenido en Neo4j | Saga de P1 y P8 (se escriben en ambos pasos) |
| Cantidad de episodios, nombres de género/actor/plataforma | Documento de Contenido en Mongo (fuente en Neo4j para elenco y géneros) | Saga de P1 |
| Estado del contenido vs. estado de su licencia | Mongo (`estado`) y PostgreSQL (`licencia.estado`) | Saga de P8 (el retiro actualiza ambos) |
| Último punto de reproducción de un perfil | Redis (`cv`, en vivo) y última Visualizacion en Cassandra (durable) | P3 (checkpoint) y P4 (saga) |

## 6. Fuera del DER

El `operationId` y el log de sagas (`saga_log` en Mongo) son infraestructura de consistencia, no del
dominio, y por eso no están en el DER. Se documentan en la sección 6 del informe.

## 7. Decisiones abiertas y ajustes pendientes en la matriz

Este DER y `matriz-trazabilidad.md` / el código tienen que quedar alineados. Hoy hay diferencias:

- **D1 — Película sin episodio implícito. RESUELTA (2026-10-08).** El esquema de Mongo guarda `duracionSeg`
  en la película y `temporadas` solo en series; el DER se alineó con eso (ver 2.1). Queda por aplicar en
  el código/matriz: para películas, `id_episodio` (Cassandra) y el `idEpisodio` del hash `cv` (Redis)
  valen el `idContenido`; resolverlo en un único helper.
- **A1 — Historial en Cassandra.** Agregar `id_visualizacion` a `historial_por_perfil` y
  `historial_por_contenido`, y definir que `fecha` es el inicio fijo de la visualización (regla 1 de 2.2).
- **A2 — Señal `VIO` de P4.** Reemplazar `VIO {fecha, veces}` por una relación idempotente (regla 3 de 2.2).
- **A3 — P3.** En la matriz dice "evento de progreso cada N reportes"; debe decir upsert sobre la misma
  fila de Visualizacion.
- **A4 — Licencia** ya está en la matriz; solo falta reflejar `Cubre` y `Concede` como relaciones (ya
  están en este DER).

## 8. Cómo editar el diagrama

`DER_StreamDB_v2.drawio` se abre en [diagrams.net](https://app.diagrams.net) (Archivo → Abrir desde
dispositivo) o con la extensión *Draw.io Integration* de VS Code. Para el entregable en PDF:
Archivo → Exportar como → PDF (con la opción "Ajustar a una página").
