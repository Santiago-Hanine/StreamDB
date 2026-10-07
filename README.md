# StreamDB

Backend de una plataforma de streaming (TPO de Ingeniería de Datos II). Usa una API en Node.js + Express y cuatro bases de datos:

| Base      | Uso típico                         | Puerto(s)                  |
| --------- | ---------------------------------- | -------------------------- |
| Redis     | Caché / datos en memoria           | 6379                       |
| MongoDB   | Documentos (catálogo, usuarios)    | 27017                      |
| Neo4j     | Grafo (relaciones, recomendaciones)| 7474 (web), 7687 (Bolt)    |
| Cassandra | Grandes volúmenes (historial, logs)| 9042                       |

Las bases corren en Docker. La API corre directamente en tu máquina.

## Requisitos

- [Docker Desktop](https://www.docker.com/products/docker-desktop/)
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

3. **Levantar las bases de datos**

   Con Docker Desktop abierto:

   ```bash
   docker compose up -d
   ```

   La primera vez descarga las imágenes, así que puede tardar varios minutos.

4. **Esperar a que estén listas**

   ```bash
   docker compose ps
   ```

   Redis y Mongo arrancan en segundos. Neo4j tarda alrededor de un minuto y Cassandra entre 1 y 3 minutos. Cassandra está lista cuando aparece `(healthy)` en la columna de estado.

5. **Iniciar la API**

   ```bash
   npm run dev
   ```

   Se reinicia sola cada vez que guardás un cambio. Va a estar en `http://localhost:4000`, o en el `PORT` que pongas en `.env`.

## Uso diario

```bash
docker compose up -d   # levantar las bases
npm run dev            # levantar la API
```

Al terminar:

```bash
docker compose stop    # apaga las bases y conserva los datos
```

## Variables de entorno

| Variable                   | Valor por defecto                  |
| -------------------------- | ---------------------------------- |
| `PORT`                     | `4000`                             |
| `REDIS_URL`                | `redis://localhost:6379`           |
| `MONGO_URL`                | `mongodb://localhost:27017/streamdb` |
| `NEO4J_URI`                | `bolt://localhost:7687`            |
| `NEO4J_USER`               | `neo4j`                            |
| `NEO4J_PASSWORD`           | `password123`                      |
| `CASSANDRA_CONTACT_POINTS` | `127.0.0.1`                        |
| `CASSANDRA_DATACENTER`     | `datacenter1`                      |

## Acceder a cada base manualmente

| Base      | Cómo entrar                                                                 |
| --------- | --------------------------------------------------------------------------- |
| Neo4j     | Abrí http://localhost:7474 en el navegador (usuario `neo4j`, contraseña `password123`) |
| MongoDB   | `docker compose exec mongo mongosh`, o con MongoDB Compass en `mongodb://localhost:27017` |
| Redis     | `docker compose exec redis redis-cli`                                       |
| Cassandra | `docker compose exec cassandra cqlsh`                                       |

## Comandos útiles de Docker

| Comando                              | Qué hace                                              |
| ------------------------------------ | ----------------------------------------------------- |
| `docker compose ps`                  | Muestra el estado de cada base                        |
| `docker compose logs -f <servicio>`  | Muestra los logs en vivo (ej: `docker compose logs -f neo4j`) |
| `docker compose restart <servicio>`  | Reinicia una base                                     |
| `docker compose stop`                | Apaga todo y conserva los datos                       |
| `docker compose down`                | Apaga y elimina los contenedores, pero conserva los datos |
| `docker compose down -v`             | ⚠️ Apaga todo y **borra los datos**                   |

Los datos se guardan en volúmenes de Docker (`redis_data`, `mongo_data`, `neo4j_data`, `cassandra_data`), así que sobreviven a reinicios.

## Problemas comunes

**Cassandra aparece como `unhealthy` o la app no puede conectarse**
Probablemente todavía está arrancando. Mirá los logs con `docker compose logs -f cassandra` y esperá. Si sigue igual después de 5 minutos, subí la RAM de Docker Desktop.

**Neo4j no responde y en los logs aparece `stop-the-world pause`**
A Docker le falta memoria. Subí la RAM en Docker Desktop y apagá contenedores de otros proyectos con `docker ps` y `docker stop <nombre>`.

**`port is already allocated` al hacer `docker compose up`**
Otro programa está usando ese puerto, por ejemplo un Mongo o Redis instalado localmente. Apagalo, o cambiá el puerto de la izquierda en `docker-compose.yml` (por ejemplo `"27018:27017"`) y actualizá el `.env`.

**Cambié la contraseña de Neo4j y no la toma**
`NEO4J_AUTH` solo se aplica la primera vez que se crea la base. Para resetearla, borrá el volumen con `docker compose down -v`. Ojo: esto borra todos los datos.

## Estructura del proyecto

```
StreamDB/
├── docker-compose.yml   # Definición de las 4 bases de datos
├── .env.example         # Plantilla de variables de entorno
├── package.json
├── src/
│   └── app.js           # Punto de entrada de la API
└── docs/                # Enunciado del TPO
```
