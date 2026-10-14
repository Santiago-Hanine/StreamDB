import db from '../db/mongo.js';
import { redis } from '../db/redis.js';
import { nuevoId, esId } from '../lib/ids.js';
import { ErroresApp, pedidoInvalido, noEncontrado, conflicto } from '../lib/errores.js';
import { ejecutarSaga } from '../lib/saga.js';

// Una sesión sin actividad durante este tiempo expira sola (P6). El P3 la renueva en cada reporte.
export const SESION_TTL_SEG = 120;

export const claves = {
	cupo: (idCuenta) => `cupo:${idCuenta}`,         // ZSET: sesiones activas de la cuenta (score = última actividad)
	sesion: (idSesion) => `sesion:${idSesion}`,     // HASH: datos de la sesión, con TTL
	viendo: (idContenido) => `viendo:${idContenido}`, // ZSET: sesiones mirando el contenido (P8)
};

// Todo en una sola operación atómica:
// 1. saca del cupo las sesiones vencidas  2. si ya está esta sesión, no hace nada (idempotente)
// 3. si no hay lugar devuelve 0           4. si hay, guarda la sesión y devuelve 1
const RESERVAR_CUPO = `
local cupo, sesion, viendo = KEYS[1], KEYS[2], KEYS[3]
local idSesion, ahora, limite, ttl = ARGV[1], tonumber(ARGV[2]), tonumber(ARGV[3]), tonumber(ARGV[4])
local vencidas = ahora - ttl * 1000
redis.call('ZREMRANGEBYSCORE', cupo, '-inf', vencidas)
redis.call('ZREMRANGEBYSCORE', viendo, '-inf', vencidas)
if redis.call('ZSCORE', cupo, idSesion) then return 1 end
if redis.call('ZCARD', cupo) >= limite then return 0 end
redis.call('ZADD', cupo, ahora, idSesion)
redis.call('HSET', sesion, unpack(ARGV, 5))
redis.call('EXPIRE', sesion, ttl)
redis.call('ZADD', viendo, ahora, idSesion)
return 1`;

// Compensación, también atómica e idempotente: borrar algo que no existe no falla
const LIBERAR_CUPO = `
redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('DEL', KEYS[2])
redis.call('ZREM', KEYS[3], ARGV[1])
return 1`;

async function validar({ idPerfil, idDispositivo, idContenido, idEpisodio } = {}) {
	const errores = [];
	for (const [nombre, valor] of Object.entries({ idPerfil, idDispositivo, idContenido })) {
		if (!esId(valor)) errores.push(`${nombre} no es un id válido`);
	}
	if (idEpisodio !== undefined && !esId(idEpisodio)) errores.push('idEpisodio no es un id válido');
	if (errores.length) throw pedidoInvalido('El pedido no es válido', errores);

	// La cuenta se deduce del perfil (el DER v2 sacó idCuenta de la sesión)
	const cuenta = await db.collection('cuentas').findOne(
		{ 'perfiles.id': idPerfil },
		{ projection: { estado: 1, limiteSesiones: 1, 'perfiles.$': 1 } },
	);
	if (!cuenta) throw noEncontrado(`No existe el perfil ${idPerfil}`);
	if (cuenta.estado !== 'activa') throw new ErroresApp(`La cuenta está ${cuenta.estado}`, 403);
	const perfil = cuenta.perfiles[0];

	const dispositivo = await db.collection('dispositivos').findOne({ _id: idDispositivo }, { projection: { _id: 1 } });
	if (!dispositivo) throw noEncontrado(`No existe el dispositivo ${idDispositivo}`);

	const contenido = await db.collection('contenidos').findOne(
		{ _id: idContenido, estado: 'publicado' },
		{ projection: { tipo: 1, titulo: 1, clasificacionEdad: 1, 'temporadas.episodios.id': 1 } },
	);
	if (!contenido) throw noEncontrado(`No existe el contenido ${idContenido} o no está publicado`);
	if (contenido.clasificacionEdad > perfil.clasificacionEdad) {
		throw new ErroresApp(`"${contenido.titulo}" no es apto para el perfil (+${contenido.clasificacionEdad})`, 403);
	}

	// Unidad reproducible: el episodio en series, el contenido mismo en películas
	let unidad = idContenido;
	if (contenido.tipo === 'serie') {
		const episodios = contenido.temporadas.flatMap((t) => t.episodios.map((e) => e.id));
		if (idEpisodio && !episodios.includes(idEpisodio)) throw pedidoInvalido('El episodio no pertenece a la serie');
		unidad = idEpisodio ?? episodios[0]; // TODO: cuando exista P3, arrancar desde "continuar viendo"
	} else if (idEpisodio) {
		throw pedidoInvalido('Una película no tiene episodios');
	}

	return { cuenta, unidad };
}

export async function iniciarReproduccion(pedido, { fallarEn } = {}) {
	const { cuenta, unidad } = await validar(pedido);
	const { idPerfil, idDispositivo, idContenido } = pedido;

	// Se generan UNA vez: viajan a Redis, a Cassandra (registrar_inicio) y después a Neo4j (P4)
	const idSesion = nuevoId();
	const idVisualizacion = nuevoId();
	const fechaInicio = new Date();
	const keys = [claves.cupo(cuenta._id), claves.sesion(idSesion), claves.viendo(idContenido)];

	await ejecutarSaga({
		tipo: 'inicio_reproduccion',
		fallarEn,
		datos: { idSesion, idVisualizacion, idCuenta: cuenta._id, idPerfil, idContenido },
		pasos: [
			{
				nombre: 'reservar_cupo', // Redis
				ejecutar: async () => {
					const reservado = await redis.eval(RESERVAR_CUPO, {
						keys,
						arguments: [
							idSesion, String(fechaInicio.getTime()), String(cuenta.limiteSesiones), String(SESION_TTL_SEG),
							'idCuenta', cuenta._id,
							'idPerfil', idPerfil,
							'idDispositivo', idDispositivo,
							'idContenido', idContenido,
							'idEpisodio', unidad,
							'idVisualizacion', idVisualizacion,
							'fechaInicio', fechaInicio.toISOString(),
						],
					});
					if (reservado === 0) {
						throw conflicto(`La cuenta alcanzó su límite de ${cuenta.limiteSesiones} sesiones simultáneas`, {
							limite: cuenta.limiteSesiones,
						});
					}
				},
				compensar: async () => {
					await redis.eval(LIBERAR_CUPO, { keys, arguments: [idSesion] });
				},
			},
			{
				nombre: 'registrar_inicio', // Cassandra
				// TODO Cassandra: insertar la fila de la visualización (historial_por_perfil y por_contenido)
				ejecutar: async () => { },
				compensar: async () => { },
			},
		],
	});

	return { idSesion, idVisualizacion, idEpisodio: unidad, fechaInicio, expiraEnSeg: SESION_TTL_SEG };
}