import neo4j from 'neo4j-driver';

const { NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD } = process.env;
if (!NEO4J_URI || !NEO4J_USER || !NEO4J_PASSWORD) {
	throw new Error('Faltan NEO4J_URI, NEO4J_USER o NEO4J_PASSWORD en las variables de entorno');
}

export const driver = neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD), {

	// Habilita usar enteros de Javascript en vez de los enteros de Neo4j
	disableLosslessIntegers: true,
});

try {
	await driver.verifyConnectivity();
	console.log('Connected to Neo4j');
} catch (error) {
	console.error('Error connecting to Neo4j:', error.code ?? error.message);
	process.exit(1);
}

// Atajo para consultas simples: devuelve las filas como objetos planos
export async function cypher(query, params = {}) {
	const { records } = await driver.executeQuery(query, params);
	return records.map((r) => r.toObject());
}