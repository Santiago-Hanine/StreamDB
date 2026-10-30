import 'dotenv/config';
import cassandra from 'cassandra-driver';

// No usa src/db/cassandra.js porque ese se conecta al keyspace, que todavía no existe
const { CASSANDRA_CONTACT_POINTS, CASSANDRA_DATACENTER, CASSANDRA_KEYSPACE: KEYSPACE = 'streamdb' } = process.env;
const cliente = new cassandra.Client({
	contactPoints: CASSANDRA_CONTACT_POINTS.split(','),
	localDataCenter: CASSANDRA_DATACENTER,
});

// Una fila por visualización: P2 la crea y P3 y P4 la actualizan por la misma clave.
// Dos tablas con los mismos datos, una por consulta.
const esquema = [
	// Un solo nodo: replication_factor 1 (en un cluster, NetworkTopologyStrategy con 3 réplicas)
	`CREATE KEYSPACE IF NOT EXISTS ${KEYSPACE}
       WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1}`,

	// Historial de un perfil por período (P3): partición por perfil y mes, lo más nuevo primero
	`CREATE TABLE IF NOT EXISTS ${KEYSPACE}.historial_por_perfil (
         id_perfil uuid, mes text, fecha timestamp, id_visualizacion uuid,
         id_contenido uuid, id_episodio uuid,      -- id_episodio: nulo en películas
         id_sesion uuid, fecha_fin timestamp, posicion_seg int, finalizado boolean,
         PRIMARY KEY ((id_perfil, mes), fecha, id_visualizacion)
       ) WITH CLUSTERING ORDER BY (fecha DESC, id_visualizacion ASC)`,

	// Historial de un contenido (P8): partición por contenido
	`CREATE TABLE IF NOT EXISTS ${KEYSPACE}.historial_por_contenido (
         id_contenido uuid, fecha timestamp, id_visualizacion uuid,
         id_perfil uuid, id_episodio uuid, id_sesion uuid,
         fecha_fin timestamp, posicion_seg int, finalizado boolean,
         PRIMARY KEY ((id_contenido), fecha, id_visualizacion)
       ) WITH CLUSTERING ORDER BY (fecha DESC, id_visualizacion ASC)`,

	// Sesiones cerradas de una cuenta (P6). Las activas están en Redis.
	`CREATE TABLE IF NOT EXISTS ${KEYSPACE}.sesiones_por_cuenta (
         id_cuenta uuid, fecha_inicio timestamp, id_sesion uuid,
         id_perfil uuid, id_dispositivo uuid, fecha_fin timestamp, motivo_cierre text,
         PRIMARY KEY ((id_cuenta), fecha_inicio, id_sesion)
       ) WITH CLUSTERING ORDER BY (fecha_inicio DESC, id_sesion ASC)`,
];

try {
	await cliente.connect();
	for (const sentencia of esquema) await cliente.execute(sentencia);

	const { rows } = await cliente.execute(
		'SELECT table_name FROM system_schema.tables WHERE keyspace_name = ?',
		[KEYSPACE],
	);
	console.log(`✓ keyspace ${KEYSPACE}`);
	for (const r of rows) console.log(`✓ tabla ${r.table_name}`);
} finally {
	await cliente.shutdown();
}