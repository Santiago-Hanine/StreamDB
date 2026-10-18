import db from '../db/mongo.js';
import { redis } from '../db/redis.js';
import { cassandraClient } from '../db/cassandra.js';

import { nuevoId, esId } from '../lib/ids.js';
import { ErroresApp, pedidoInvalido, noEncontrado, conflicto } from '../lib/errores.js';
import { ejecutarSaga } from '../lib/saga.js';

// Una sesión sin actividad durante este tiempo expira sola (P6). El P3 la renueva en cada reporte.
// El TTL lo lleva la clave vida:{id}; los datos (sesion:{id}) quedan hasta que P6 cierra la sesión,
// así al expirar todavía se sabe qué limpiar y qué registrar en Cassandra.
export const SESION_TTL_SEG = 120;

export const claves = {
	cupo: (idCuenta) => `cupo:${idCuenta}`,         // ZSET: sesiones activas de la cuenta (score = última actividad)
	sesion: (idSesion) => `sesion:${idSesion}`,     // HASH: datos de la sesión (sin TTL: los borra P6 al cerrarla)
	vida: (idSesion) => `vida:${idSesion}`,         // STRING con TTL: mientras exista, la sesión está activa
	viendo: (idContenido) => `viendo:${idContenido}`, // ZSET: sesiones mirando el contenido (P8)
	dispositivo: (idDispositivo) => `disp:${idDispositivo}`, // STRING: sesión activa del dispositivo, con el mismo TTL
	// "Continuar viendo" (P3)
	cv: (idPerfil, idContenido) => `cv:${idPerfil}:${idContenido}`, // HASH: idEpisodio (unidad), segundo, actualizado
	continuar: (idPerfil) => `continuar:${idPerfil}`,              // ZSET: contenidos con cv del perfil (score = actualizado)
	perfilesConCv: (idContenido) => `cv_perfiles:${idContenido}`,  // SET: perfiles con cv de ese contenido (para borrarlos en P8)
	retirado: (idContenido) => `retirado:${idContenido}`,           // STRING: el contenido se retiró (P8): P3 deja de aceptar progreso
};

// Redis consultas:

// Regla: una sesión por dispositivo. El cupo limita dispositivos simultáneos, no reproducciones:
// si el dispositivo ya tiene una sesión activa de la cuenta (ej. pasa al episodio siguiente),
// se reutiliza esa sesión en vez de ocupar otro lugar.
//
// Todo en una sola operación atómica:
// 1. saca del cupo las sesiones vencidas
// 2a. sesión nueva: si ya está (reintento) no hace nada; si no hay lugar devuelve 0; si hay, la guarda y devuelve 1
// 2b. reutilizar: compare-and-set sobre la visualización anterior (si otro pedido la cambió, devuelve -2);
//     guarda los datos nuevos y devuelve los anteriores, para poder compensar
// 3. en los dos casos: el dispositivo apunta a la sesión y se renuevan la vida (TTL) y los scores
//    (al reutilizar se conserva inicioSesion: la sesión empezó antes que esta reproducción)
const RESERVAR_CUPO = `
local cupo, sesion, viendo, disp, viendoPrevio, vida = KEYS[1], KEYS[2], KEYS[3], KEYS[4], KEYS[5], KEYS[6]
local idSesion, ahora, limite, ttl = ARGV[1], tonumber(ARGV[2]), tonumber(ARGV[3]), tonumber(ARGV[4])
local visPrevia = ARGV[5]
local vencidas = ahora - ttl * 1000
redis.call('ZREMRANGEBYSCORE', cupo, '-inf', vencidas)
redis.call('ZREMRANGEBYSCORE', viendo, '-inf', vencidas)
local resultado = 1
if visPrevia ~= '' then
  if redis.call('GET', disp) ~= idSesion or not redis.call('ZSCORE', cupo, idSesion)
     or redis.call('EXISTS', vida) == 0
     or redis.call('HGET', sesion, 'idVisualizacion') ~= visPrevia then return -2 end
  resultado = redis.call('HGETALL', sesion)
  local inicioSesion = redis.call('HGET', sesion, 'inicioSesion')
  redis.call('DEL', sesion)
  redis.call('HSET', sesion, unpack(ARGV, 6))
  if inicioSesion then redis.call('HSET', sesion, 'inicioSesion', inicioSesion) end
  redis.call('ZREM', viendoPrevio, idSesion)
else
  if redis.call('ZSCORE', cupo, idSesion) then return 1 end
  if redis.call('ZCARD', cupo) >= limite then return 0 end
  redis.call('HSET', sesion, unpack(ARGV, 6))
end
redis.call('ZADD', cupo, ahora, idSesion)
redis.call('SET', vida, '1', 'EX', ttl)
redis.call('ZADD', viendo, ahora, idSesion)
redis.call('SET', disp, idSesion, 'EX', ttl)
return resultado`;

// Compensación de una sesión nueva, atómica e idempotente: borrar algo que no existe no falla.
// El dispositivo se suelta solo si todavía apunta a esta sesión.
const LIBERAR_CUPO = `
redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('DEL', KEYS[2], KEYS[6])
redis.call('ZREM', KEYS[3], ARGV[1])
if redis.call('GET', KEYS[4]) == ARGV[1] then redis.call('DEL', KEYS[4]) end
return 1`;

// Compensación de una sesión reutilizada: vuelve a dejarla como estaba (no se libera: seguía activa)
const RESTAURAR_SESION = `
local sesion, viendo, viendoPrevio, vida = KEYS[1], KEYS[2], KEYS[3], KEYS[4]
local idSesion, ttl, ahora = ARGV[1], tonumber(ARGV[2]), tonumber(ARGV[3])
redis.call('DEL', sesion)
redis.call('HSET', sesion, unpack(ARGV, 4))
redis.call('SET', vida, '1', 'EX', ttl)
redis.call('ZREM', viendo, idSesion)
redis.call('ZADD', viendoPrevio, ahora, idSesion)
return 1`;

// Cassandra consultas:

const INSERTAR_POR_PERFIL = `INSERT INTO historial_por_perfil
  (id_perfil, mes, fecha, id_visualizacion, id_contenido, id_episodio, id_sesion, fecha_fin, posicion_seg, finalizado)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const INSERTAR_POR_CONTENIDO = `INSERT INTO historial_por_contenido
  (id_contenido, fecha, id_visualizacion, id_perfil, id_episodio, id_sesion, fecha_fin, posicion_seg, finalizado)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const BORRAR_POR_PERFIL = 'DELETE FROM historial_por_perfil WHERE id_perfil = ? AND mes = ? AND fecha = ? AND id_visualizacion = ?';
const BORRAR_POR_CONTENIDO = 'DELETE FROM historial_por_contenido WHERE id_contenido = ? AND fecha = ? AND id_visualizacion = ?';

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

	// "Continuar viendo" (P3): dónde quedó este perfil en este contenido, si ya lo empezó
	const cv = await redis.hGetAll(claves.cv(idPerfil, idContenido));

	// Unidad reproducible: el episodio en series, el contenido mismo en películas
	let unidad = idContenido;
	if (contenido.tipo === 'serie') {
		const episodios = contenido.temporadas.flatMap((t) => t.episodios.map((e) => e.id));
		if (idEpisodio && !episodios.includes(idEpisodio)) throw pedidoInvalido('El episodio no pertenece a la serie');
		// Sin episodio pedido: se retoma el de "continuar viendo", o el primero si nunca la empezó
		unidad = idEpisodio ?? (episodios.includes(cv.idEpisodio) ? cv.idEpisodio : episodios[0]);
	} else if (idEpisodio) {
		throw pedidoInvalido('Una película no tiene episodios');
	}

	// Se retoma en el segundo guardado solo si es la misma unidad
	const posicionSeg = cv.idEpisodio === unidad ? Number(cv.segundo) || 0 : 0;

	return { cuenta, unidad, posicionSeg, esSerie: contenido.tipo === 'serie' };
}

export async function iniciarReproduccion(pedido, { fallarEn } = {}) {
	const { cuenta, unidad, posicionSeg, esSerie } = await validar(pedido);
	const { idPerfil, idDispositivo, idContenido } = pedido;

	// ¿El dispositivo ya tiene una sesión activa de esta cuenta? Entonces se reutiliza (no ocupa otro lugar)
	const idSesionPrevia = await redis.get(claves.dispositivo(idDispositivo));
	const previa = idSesionPrevia ? await redis.hGetAll(claves.sesion(idSesionPrevia)) : {};
	const reutiliza = previa.idCuenta === cuenta._id && (await redis.exists(claves.vida(idSesionPrevia))) === 1;

	// Se generan UNA vez: viajan a Redis, a Cassandra (registrar_inicio) y después a Neo4j (P4)
	const idSesion = reutiliza ? idSesionPrevia : nuevoId();
	const idVisualizacion = nuevoId();
	const fechaInicio = new Date();
	const viendoPrevio = claves.viendo(reutiliza ? previa.idContenido : idContenido);
	const keys = [
		claves.cupo(cuenta._id), claves.sesion(idSesion), claves.viendo(idContenido),
		claves.dispositivo(idDispositivo), viendoPrevio, claves.vida(idSesion),
	];

	const mes = fechaInicio.toISOString().slice(0, 7);
	const idEpisodio = esSerie ? unidad : null;       // en películas la unidad es el contenido, pero en Cassandra va null

	await ejecutarSaga({
		tipo: 'inicio_reproduccion',
		fallarEn,
		datos: { idSesion, sesionReutilizada: reutiliza, idVisualizacion, idCuenta: cuenta._id, idPerfil, idContenido },
		pasos: [
			{
				nombre: 'reservar_cupo', // Redis
				ejecutar: async () => {
					const reservado = await redis.eval(RESERVAR_CUPO, {
						keys,
						arguments: [
							idSesion, String(fechaInicio.getTime()), String(cuenta.limiteSesiones), String(SESION_TTL_SEG),
							reutiliza ? previa.idVisualizacion : '',
							'idCuenta', cuenta._id,
							'idPerfil', idPerfil,
							'idDispositivo', idDispositivo,
							'idContenido', idContenido,
							'idEpisodio', unidad,
							'idVisualizacion', idVisualizacion,
							'fechaInicio', fechaInicio.toISOString(),
							'inicioSesion', fechaInicio.toISOString(),
						],
					});
					if (reservado === 0) {
						throw conflicto(`La cuenta alcanzó su límite de ${cuenta.limiteSesiones} sesiones simultáneas`, {
							limite: cuenta.limiteSesiones,
						});
					}
					if (reservado === -2) {
						throw conflicto('Otro pedido de este dispositivo cambió la sesión al mismo tiempo: reintentá');
					}
					// Si reutilizó, devuelve la sesión anterior (lista campo, valor, ...) para poder restaurarla
					return Array.isArray(reservado) ? { sesionAnterior: reservado } : {};
				},
				compensar: async ({ sesionAnterior } = {}) => {
					if (sesionAnterior) {
						await redis.eval(RESTAURAR_SESION, {
							keys: [claves.sesion(idSesion), claves.viendo(idContenido), viendoPrevio, claves.vida(idSesion)],
							arguments: [idSesion, String(SESION_TTL_SEG), String(Date.now()), ...sesionAnterior],
						});
					} else {
						await redis.eval(LIBERAR_CUPO, { keys, arguments: [idSesion] });
					}
				},
			},
			{
				nombre: 'registrar_inicio', // Cassandra
				ejecutar: async () => {
					// Si una de las dos inserciones se aplica, Cassandra garantiza la otra
					// posicion_seg arranca donde retoma (P3), no en 0: si no, la fila nueva "pisaría" el progreso
					await cassandraClient.batch(
						[
							{
								query: INSERTAR_POR_PERFIL,
								params: [idPerfil, mes, fechaInicio, idVisualizacion, idContenido, idEpisodio, idSesion, fechaInicio, posicionSeg, false],
							},
							{
								query: INSERTAR_POR_CONTENIDO,
								params: [idContenido, fechaInicio, idVisualizacion, idPerfil, idEpisodio, idSesion, fechaInicio, posicionSeg, false],
							},
						],
						{ prepare: true, logged: true },
					);
				},
				compensar: async () => {
					await cassandraClient.batch(
						[
							{ query: BORRAR_POR_PERFIL, params: [idPerfil, mes, fechaInicio, idVisualizacion] },
							{ query: BORRAR_POR_CONTENIDO, params: [idContenido, fechaInicio, idVisualizacion] },
						],
						{ prepare: true, logged: true },
					);
				},
			},
		],
	});

	return {
		idSesion, sesionReutilizada: reutiliza, idVisualizacion, idEpisodio: unidad, posicionSeg, fechaInicio,
		expiraEnSeg: SESION_TTL_SEG,
	};
}