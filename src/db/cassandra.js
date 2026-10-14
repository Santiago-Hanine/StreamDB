import cassandra from 'cassandra-driver';

const { CASSANDRA_CONTACT_POINTS, CASSANDRA_DATACENTER, CASSANDRA_KEYSPACE = 'streamdb' } = process.env;
if (!CASSANDRA_CONTACT_POINTS || !CASSANDRA_DATACENTER) {
	throw new Error('Faltan CASSANDRA_CONTACT_POINTS o CASSANDRA_DATACENTER en las variables de entorno');
}
if (!CASSANDRA_KEYSPACE) throw new Error('Falta CASSANDRA_KEYSPACE en las variables de entorno');

export const KEYSPACE = CASSANDRA_KEYSPACE;


export const configuracion = {
	contactPoints: CASSANDRA_CONTACT_POINTS.split(','),
	localDataCenter: CASSANDRA_DATACENTER,
};

export const cassandraClient = new cassandra.Client({ ...configuracion, keyspace: KEYSPACE });

try {
	await cassandraClient.connect();
	console.log('Connected to Cassandra');
} catch (error) {
	const sinKeyspace = /Keyspace .* does not exist/.test(error.message);
	console.error(
		'Error connecting to Cassandra:',
		sinKeyspace ? `no existe el keyspace "${KEYSPACE}": corré npm run setup:cassandra` : error.message,
	);
	await cassandraClient.shutdown().catch(() => { });
	process.exit(1);
}

export default cassandraClient;