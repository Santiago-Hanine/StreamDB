// Prueba de concurrencia de P2: varios dispositivos compiten al mismo tiempo por el último lugar
// del cupo de la cuenta demo. Tiene que ganar uno solo y el resto recibir 409.
// Al final compara con la versión ingenua (leer el cupo y después agregar, en dos comandos),
// que con los mismos pedidos simultáneos supera el límite.
import 'dotenv/config';
import db, { client } from '../db/mongo.js';
import { redis } from '../db/redis.js';
import { cassandraClient } from '../db/cassandra.js';
import { iniciarReproduccion, claves } from '../problemas/p2-inicio-reproduccion-sesiones.js';
import { cerrarSesionesDeCuenta } from '../problemas/p6-expiracion-cierre-sesiones.js';

const COMPETIDORES = 5;
let ok = true;
const verificar = (condicion, texto) => {
	console.log(`  ${condicion ? '✓' : '✗'} ${texto}`);
	if (!condicion) ok = false;
};

try {
	const cuenta = await db.collection('cuentas').findOne({ email: 'demo@streamdb.test' });
	const serie = await db.collection('contenidos').findOne({ titulo: 'El faro del norte', tipo: 'serie' }, { projection: { _id: 1 } });
	if (!cuenta || !serie) throw new Error('No están los datos de demo: corré npm run seed');
	const { limiteSesiones: limite } = cuenta;
	const perfil = cuenta.perfiles[0];
	const dispositivos = (await db.collection('dispositivos')
		.find({}, { sort: { _id: 1 }, limit: limite - 1 + COMPETIDORES, projection: { _id: 1 } }).toArray()).map((d) => d._id);
	const iniciar = (idDispositivo) => iniciarReproduccion({ idPerfil: perfil.id, idDispositivo, idContenido: serie._id });

	// 1. Cupo con un solo lugar libre
	await cerrarSesionesDeCuenta(cuenta._id);
	for (const d of dispositivos.slice(0, limite - 1)) await iniciar(d);
	console.log(`\nCuenta demo: límite ${limite}, ocupados ${await redis.zCard(claves.cupo(cuenta._id))}. `
		+ `${COMPETIDORES} dispositivos piden el último lugar al mismo tiempo:`);

	// 2. Todos a la vez: pasan juntos la validación de Mongo y llegan juntos a Redis
	const competidores = dispositivos.slice(limite - 1);
	const resultados = await Promise.allSettled(competidores.map(iniciar));
	resultados.forEach((r, i) => console.log(`  dispositivo ${i + 1}: ${r.status === 'fulfilled'
		? `ganó (sesión ${r.value.idSesion.slice(0, 8)})`
		: `${r.reason.status} ${r.reason.message}`}`));

	const ganadores = resultados.filter((r) => r.status === 'fulfilled');
	const perdedores = resultados.filter((r) => r.status === 'rejected');
	const ocupados = await redis.zCard(claves.cupo(cuenta._id));
	const conSesion = await Promise.all(competidores.map((d) => redis.exists(claves.dispositivo(d))));
	const sagas = await db.collection('sagas')
		.find({ _id: { $in: perdedores.map((r) => r.reason.idSaga) } }, { projection: { estado: 1, pasos: 1 } }).toArray();

	console.log('\nResultado:');
	verificar(ganadores.length === 1, `ganó uno solo (${ganadores.length})`);
	verificar(perdedores.every((r) => r.reason.status === 409), `los otros ${perdedores.length} recibieron 409`);
	verificar(ocupados === limite, `el cupo quedó en ${ocupados} de ${limite}: nunca se superó`);
	verificar(conSesion.filter(Boolean).length === 1, 'solo el ganador tiene sesión en su dispositivo');
	verificar(sagas.length === perdedores.length && sagas.every((s) => s.estado === 'compensada' && s.pasos[1].estado === 'pendiente'),
		'las sagas de los perdedores se cortaron en reservar_cupo: no escribieron en Cassandra');

	// 3. La versión ingenua, con los mismos pedidos simultáneos, sobre una clave de prueba
	const clave = 'prueba:cupo_ingenuo';
	await redis.del(clave);
	for (let i = 0; i < limite - 1; i++) await redis.zAdd(clave, { score: Date.now(), value: `ocupado${i}` });
	await Promise.all(competidores.map(async (d) => {
		if ((await redis.zCard(clave)) < limite) await redis.zAdd(clave, { score: Date.now(), value: d }); // leer y después escribir
	}));
	const ingenuo = await redis.zCard(clave);
	await redis.del(clave);
	console.log(`\nVersión ingenua (ZCARD y después ZADD, sin Lua): el cupo terminó en ${ingenuo} de ${limite}.`);
	console.log('  Todos leyeron "hay lugar" antes de que alguno escribiera. El script Lua lee y escribe en una sola operación.');

	await cerrarSesionesDeCuenta(cuenta._id);
	console.log(ok ? '\n✓ Prueba de concurrencia correcta' : '\n✗ La prueba de concurrencia falló');
	process.exitCode = ok ? 0 : 1;
} finally {
	await Promise.allSettled([client.close(), redis.quit(), cassandraClient.shutdown()]);
}
