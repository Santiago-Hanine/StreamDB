// Identificador compartido entre todos los motores (Mongo, Neo4j, Redis, Cassandra y PostgreSQL).
// Se genera en la capa de aplicación ANTES de escribir, así el mismo valor viaja a cada motor
// y reintentar un paso no crea duplicados.
import { randomUUID } from 'node:crypto';

// UUID en minúsculas, el formato que devuelven randomUUID(), Cassandra y PostgreSQL
export const UUID_PATTERN = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

const uuidRegex = new RegExp(UUID_PATTERN);

export const nuevoId = () => randomUUID();

export const esId = (valor) => typeof valor === 'string' && uuidRegex.test(valor);
