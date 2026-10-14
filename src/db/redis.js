import { createClient } from 'redis';

const { REDIS_URL } = process.env;
if (!REDIS_URL) throw new Error('Falta REDIS_URL en las variables de entorno');

let arrancando = true;

export const redis = createClient({
	url: REDIS_URL,
	socket: {
		reconnectStrategy: (intentos) =>
			arrancando ? new Error('Redis no responde') : Math.min(intentos * 200, 3000),
	},
});

redis.on('error', (error) => {
	if (!arrancando) console.error('Redis:', error.message);
});

try {
	await redis.connect();
	arrancando = false;
	console.log('Connected to Redis');
} catch (error) {
	console.error('Error connecting to Redis:', error.message);
	process.exit(1);
}

export default redis;