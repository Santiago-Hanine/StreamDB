import 'dotenv/config';
import { pool, sql } from '../db/postgres.js';

// Las licencias van en PostgreSQL porque la base tiene que impedir dos licencias superpuestas
// en la misma región (EXCLUDE), y ningún NoSQL de la cursada lo garantiza sin código propio.
const esquema = [
	'CREATE EXTENSION IF NOT EXISTS btree_gist', // para combinar = con && en el EXCLUDE

	`CREATE TABLE IF NOT EXISTS licencia (
       id_licencia   UUID PRIMARY KEY,
       id_contenido  UUID NOT NULL,          -- mismo ID que en Mongo, Neo4j, Redis y Cassandra
       id_plataforma UUID NOT NULL,
       region        CHAR(2) NOT NULL,       -- código de país ISO, ej. 'AR'
       vigencia      DATERANGE NOT NULL,     -- [desde, hasta)
       estado        TEXT NOT NULL DEFAULT 'vigente'
                     CHECK (estado IN ('vigente', 'vencida', 'rescindida')),
       -- un contenido no puede tener dos licencias superpuestas en la misma región
       CONSTRAINT licencia_sin_superposicion
         EXCLUDE USING gist (id_contenido WITH =, region WITH =, vigencia WITH &&)
         WHERE (estado <> 'rescindida')
     )`,

	// P8: "licencias vigentes que ya vencieron a una fecha" y "licencias de un contenido"
	'CREATE INDEX IF NOT EXISTS licencia_estado_fin ON licencia (estado, upper(vigencia))',
	'CREATE INDEX IF NOT EXISTS licencia_contenido ON licencia (id_contenido)',
];

try {
	for (const sentencia of esquema) await sql(sentencia);
	const restricciones = await sql(
		`SELECT conname FROM pg_constraint WHERE conrelid = 'licencia'::regclass ORDER BY conname`,
	);
	console.log('✓ tabla licencia');
	for (const r of restricciones) console.log(`✓ restricción ${r.conname}`);
} finally {
	await pool.end();
}
