import 'dotenv/config';
import { driver, cypher } from '../db/neo4j.js';

const esquema = [
	// id compartido entre motores (también crea el índice)
	'CREATE CONSTRAINT contenido_id IF NOT EXISTS FOR (c:Contenido) REQUIRE c.id IS UNIQUE',
	'CREATE CONSTRAINT actor_id IF NOT EXISTS FOR (a:Actor) REQUIRE a.id IS UNIQUE',
	'CREATE CONSTRAINT perfil_id IF NOT EXISTS FOR (p:Perfil) REQUIRE p.id IS UNIQUE',
	// Los géneros se identifican por nombre, como en Mongo
	'CREATE CONSTRAINT genero_nombre IF NOT EXISTS FOR (g:Genero) REQUIRE g.nombre IS UNIQUE',
	// Una VIO por visualización: hace idempotente P4
	'CREATE CONSTRAINT vio_visualizacion IF NOT EXISTS FOR ()-[v:VIO]-() REQUIRE v.idVisualizacion IS UNIQUE',
	'CREATE INDEX contenido_estado IF NOT EXISTS FOR (c:Contenido) ON (c.estado)',
];

try {
	for (const sentencia of esquema) await cypher(sentencia);
	await cypher('CALL db.awaitIndexes(60)');

	const restricciones = await cypher('SHOW CONSTRAINTS YIELD name, type RETURN name, type ORDER BY name');
	for (const r of restricciones) console.log(`✓ restricción ${r.name} (${r.type})`);
	console.log('✓ índice contenido_estado');
} finally {
	await driver.close();
}