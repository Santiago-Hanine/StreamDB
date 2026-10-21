import pg from 'pg';

const { POSTGRES_URL } = process.env;
if (!POSTGRES_URL) throw new Error('Falta POSTGRES_URL en las variables de entorno');

// Fallar rápido (por defecto espera sin límite)
export const pool = new pg.Pool({ connectionString: POSTGRES_URL, connectionTimeoutMillis: 5000 });

pool.on('error', (error) => console.error('PostgreSQL:', error.message));

// DATE como texto 'AAAA-MM-DD' (si no, lo pasa a Date con la zona local)
pg.types.setTypeParser(pg.types.builtins.DATE, (valor) => valor);

try {
	await pool.query('SELECT 1');
	console.log('Connected to PostgreSQL');
} catch (error) {
	console.error('Error connecting to PostgreSQL:', error.message);
	process.exit(1);
}

export async function sql(texto, params = []) {
	const { rows } = await pool.query(texto, params);
	return rows;
}

export default pool;
