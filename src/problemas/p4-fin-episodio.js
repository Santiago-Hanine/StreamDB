import db from '../db/mongo.js';
import { redis } from '../db/redis.js';
import { cassandraClient } from '../db/cassandra.js';
import { cypher } from '../db/neo4j.js';

import { esId } from '../lib/ids.js';
import { ErroresApp, pedidoInvalido } from '../lib/errores.js';
import { ejecutarSaga } from '../lib/saga.js';
import { claves } from './p2-inicio-reproduccion-sesiones.js';

const mesDe = (fecha) => fecha.toISOString().slice(0, 7);

// Redis consultas:

// En una sola operación atómica: lee el "continuar viendo" anterior (para poder restaurarlo)
// y lo mueve al episodio siguiente, o lo saca si ya no hay siguiente (película o último episodio).
// También marca en la sesión que esta visualización terminó, así P3 no la vuelve a pisar.
const MOVER_CONTINUAR = `
local cv, continuar, perfilesConCv, sesion = KEYS[1], KEYS[2], KEYS[3], KEYS[4]
local modo, idContenido, idPerfil, siguiente = ARGV[1], ARGV[2], ARGV[3], ARGV[4]
local ahora, ahoraIso, idVisualizacion = tonumber(ARGV[5]), ARGV[6], ARGV[7]
local previo = redis.call('HGETALL', cv)
local score = redis.call('ZSCORE', continuar, idContenido)
redis.call('DEL', cv)
if modo == 'siguiente' then
  redis.call('HSET', cv, 'idEpisodio', siguiente, 'segundo', '0', 'actualizado', ahoraIso)
  redis.call('ZADD', continuar, ahora, idContenido)
  redis.call('SADD', perfilesConCv, idPerfil)
else
  redis.call('ZREM', continuar, idContenido)
  redis.call('SREM', perfilesConCv, idPerfil)
end
if redis.call('EXISTS', sesion) == 1 then redis.call('HSET', sesion, 'finalizada', idVisualizacion) end
return { previo, score or '' }`;

// Compensación: deja "continuar viendo" exactamente como estaba (idempotente: se puede repetir)
const RESTAURAR_CONTINUAR = `
local cv, continuar, perfilesConCv, sesion = KEYS[1], KEYS[2], KEYS[3], KEYS[4]
local idContenido, idPerfil, score = ARGV[1], ARGV[2], ARGV[3]
redis.call('DEL', cv)
if #ARGV > 3 then
  redis.call('HSET', cv, unpack(ARGV, 4))
  redis.call('ZADD', continuar, score, idContenido)
  redis.call('SADD', perfilesConCv, idPerfil)
else
  redis.call('ZREM', continuar, idContenido)
  redis.call('SREM', perfilesConCv, idPerfil)
end
if redis.call('EXISTS', sesion) == 1 then redis.call('HDEL', sesion, 'finalizada') end
return 1`;

// Cassandra consultas:

const LEER_FILA = `SELECT posicion_seg, fecha_fin, finalizado FROM historial_por_perfil
  WHERE id_perfil = ? AND mes = ? AND fecha = ? AND id_visualizacion = ?`;
const ACTUALIZAR_POR_PERFIL = `UPDATE historial_por_perfil SET finalizado = ?, posicion_seg = ?, fecha_fin = ?
  WHERE id_perfil = ? AND mes = ? AND fecha = ? AND id_visualizacion = ?`;
const ACTUALIZAR_POR_CONTENIDO = `UPDATE historial_por_contenido SET finalizado = ?, posicion_seg = ?, fecha_fin = ?
  WHERE id_contenido = ? AND fecha = ? AND id_visualizacion = ?`;

// Neo4j consultas:

// MERGE por idVisualizacion: repetirlo no crea una segunda señal (hay restricción de unicidad)
const CREAR_SENAL = `MERGE (p:Perfil {id: $idPerfil})
  WITH p MATCH (c:Contenido {id: $idContenido})
  MERGE (p)-[r:VIO {idVisualizacion: $idVisualizacion}]->(c)
  ON CREATE SET r.fecha = datetime($fecha)
  RETURN count(r) AS creadas`;
const BORRAR_SENAL = 'MATCH ()-[r:VIO {idVisualizacion: $idVisualizacion}]->() DELETE r';

// Unidad terminada y la siguiente (si hay), leídas de la ficha en Mongo (también la usa P3 al reconstruir)
export async function unidadYSiguiente(idContenido, unidad) {
	const contenido = await db.collection('contenidos').findOne(
		{ _id: idContenido },
		{ projection: { tipo: 1, duracionSeg: 1, temporadas: 1 } },
	);
	if (!contenido) throw new ErroresApp(`No existe el contenido ${idContenido}`, 404);
	if (contenido.tipo !== 'serie') return { duracionSeg: contenido.duracionSeg, siguiente: null };

	// Todos los episodios en orden de temporada y número
	const episodios = [...contenido.temporadas]
		.sort((a, b) => a.numero - b.numero)
		.flatMap((t) => [...t.episodios].sort((a, b) => a.numero - b.numero).map((e) => ({ ...e, temporada: t.numero })));
	const i = episodios.findIndex((e) => e.id === unidad);
	if (i === -1) throw new ErroresApp(`El episodio ${unidad} no pertenece al contenido`, 409);

	const sig = episodios[i + 1];
	return {
		duracionSeg: episodios[i].duracionSeg,
		siguiente: sig ? { idEpisodio: sig.id, temporada: sig.temporada, episodio: sig.numero, titulo: sig.titulo } : null,
	};
}

export async function finEpisodio(idSesion, { fallarEn } = {}) {
	if (!esId(idSesion)) throw pedidoInvalido('idSesion no es un id válido');

	// 1. Datos de la sesión, guardados por P2: identifican la fila de Cassandra y las claves de Redis
	const sesion = await redis.hGetAll(claves.sesion(idSesion));
	if (!sesion.idPerfil || !(await redis.exists(claves.vida(idSesion)))) {
		throw new ErroresApp(`La sesión ${idSesion} no existe o expiró`, 410);
	}
	const { idPerfil, idContenido, idEpisodio: unidad, idVisualizacion } = sesion;
	const fechaInicio = new Date(sesion.fechaInicio);
	const mes = mesDe(fechaInicio);

	// Reintento de una operación que ya terminó bien: no se repite nada
	if (sesion.finalizada === idVisualizacion) {
		return { idSesion, idVisualizacion, yaRegistrado: true };
	}

	// 2. Mongo (solo lectura): duración de lo que terminó y cuál es el siguiente episodio
	const { duracionSeg, siguiente } = await unidadYSiguiente(idContenido, unidad);
	const fechaFin = new Date();

	const keysCv = [
		claves.cv(idPerfil, idContenido), claves.continuar(idPerfil),
		claves.perfilesConCv(idContenido), claves.sesion(idSesion),
	];
	const actualizarFila = (finalizado, posicion, fin) => cassandraClient.batch(
		[
			{ query: ACTUALIZAR_POR_PERFIL, params: [finalizado, posicion, fin, idPerfil, mes, fechaInicio, idVisualizacion] },
			{ query: ACTUALIZAR_POR_CONTENIDO, params: [finalizado, posicion, fin, idContenido, fechaInicio, idVisualizacion] },
		],
		{ prepare: true, logged: true },
	);

	const { idSaga } = await ejecutarSaga({
		tipo: 'fin_episodio',
		fallarEn,
		datos: { idSesion, idVisualizacion, idPerfil, idContenido, idEpisodio: unidad, siguiente: siguiente?.idEpisodio ?? null },
		pasos: [
			{
				nombre: 'marcar_finalizado', // Cassandra
				ejecutar: async () => {
					// Se guarda cómo estaba la fila para poder volverla atrás
					const { rows: [previa] } = await cassandraClient.execute(
						LEER_FILA, [idPerfil, mes, fechaInicio, idVisualizacion], { prepare: true },
					);
					if (!previa) throw new ErroresApp(`No existe la visualización ${idVisualizacion} en el historial`, 409);
					await actualizarFila(true, duracionSeg ?? previa.posicion_seg, fechaFin);
					return { posicionSeg: previa.posicion_seg, fechaFin: previa.fecha_fin, finalizado: previa.finalizado };
				},
				compensar: async (previa) => {
					await actualizarFila(previa.finalizado ?? false, previa.posicionSeg, previa.fechaFin);
				},
			},
			{
				nombre: 'continuar_viendo', // Redis
				ejecutar: async () => {
					const [previo, score] = await redis.eval(MOVER_CONTINUAR, {
						keys: keysCv,
						arguments: [
							siguiente ? 'siguiente' : 'quitar', idContenido, idPerfil, siguiente?.idEpisodio ?? '',
							String(fechaFin.getTime()), fechaFin.toISOString(), idVisualizacion,
						],
					});
					return { previo, score };
				},
				compensar: async ({ previo, score }) => {
					await redis.eval(RESTAURAR_CONTINUAR, {
						keys: keysCv,
						arguments: [idContenido, idPerfil, String(score), ...previo],
					});
				},
			},
			{
				nombre: 'senal_vio', // Neo4j: va última porque es la que alimenta las recomendaciones (P5)
				ejecutar: async () => {
					const [{ creadas }] = await cypher(CREAR_SENAL, {
						idPerfil, idContenido, idVisualizacion, fecha: fechaFin.toISOString(),
					});
					if (creadas === 0) throw new ErroresApp(`El contenido ${idContenido} no existe en Neo4j`, 409);
				},
				compensar: async () => {
					await cypher(BORRAR_SENAL, { idVisualizacion });
				},
			},
		],
	});

	return { idSaga, idSesion, idVisualizacion, finalizado: unidad, siguiente };
}
