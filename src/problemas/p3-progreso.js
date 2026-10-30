import db from '../db/mongo.js';
import { redis } from '../db/redis.js';
import { cassandraClient } from '../db/cassandra.js';

import { esId } from '../lib/ids.js';
import { ErroresApp, pedidoInvalido, noEncontrado, conflicto } from '../lib/errores.js';
import { claves, SESION_TTL_SEG } from './p2-inicio-reproduccion-sesiones.js';
import { unidadYSiguiente } from './p4-fin-episodio.js';

// Cada cuántos reportes se guarda en Cassandra (Redis se actualiza en todos)
export const CHECKPOINT_CADA = 6;
const EVENTOS = ['reporte', 'pausa', 'cierre'];

const mesDe = (fecha) => fecha.toISOString().slice(0, 7); // parte de la clave de partición

// Redis consultas:

// Script atómico:
// 1. -1 si la sesión expiró (P6), -2 si el contenido se retiró (P8)
// 2. guarda el punto exacto en continuar viendo
// 3. heartbeat: renueva TTL y scores
// 4. devuelve el número de reporte
const REPORTAR_PROGRESO = `
local sesion, cupo, viendo, cv, continuar, perfilesConCv, disp, vida, retirado = KEYS[1], KEYS[2], KEYS[3], KEYS[4], KEYS[5], KEYS[6], KEYS[7], KEYS[8], KEYS[9]
local idSesion, idPerfil, idContenido, unidad = ARGV[1], ARGV[2], ARGV[3], ARGV[4]
local segundo, ahora, ahoraIso, ttl = ARGV[5], tonumber(ARGV[6]), ARGV[7], tonumber(ARGV[8])
if redis.call('EXISTS', vida) == 0 then return -1 end
if redis.call('EXISTS', retirado) == 1 then return -2 end
redis.call('HSET', cv, 'idEpisodio', unidad, 'segundo', segundo, 'actualizado', ahoraIso)
redis.call('ZADD', continuar, ahora, idContenido)
redis.call('SADD', perfilesConCv, idPerfil)
redis.call('HSET', sesion, 'ultimaActividad', ahoraIso, 'posicionSeg', segundo)
redis.call('EXPIRE', vida, ttl)
if redis.call('GET', disp) == idSesion then redis.call('EXPIRE', disp, ttl) end
redis.call('ZADD', cupo, 'XX', ahora, idSesion)
redis.call('ZADD', viendo, 'XX', ahora, idSesion)
return redis.call('HINCRBY', sesion, 'reportes', 1)`;

// Cassandra consultas:

// UPDATE es upsert: repetirlo da lo mismo
const ACTUALIZAR_POR_PERFIL = `UPDATE historial_por_perfil SET posicion_seg = ?, fecha_fin = ?
  WHERE id_perfil = ? AND mes = ? AND fecha = ? AND id_visualizacion = ?`;
const ACTUALIZAR_POR_CONTENIDO = `UPDATE historial_por_contenido SET posicion_seg = ?, fecha_fin = ?
  WHERE id_contenido = ? AND fecha = ? AND id_visualizacion = ?`;

const HISTORIAL_DEL_MES = `SELECT fecha, id_visualizacion, id_contenido, id_episodio, id_sesion,
  fecha_fin, posicion_seg, finalizado
  FROM historial_por_perfil WHERE id_perfil = ? AND mes = ? LIMIT ?`;

export async function reportarProgreso(idSesion, { posicionSeg, evento = 'reporte' } = {}) {
	const errores = [];
	if (!esId(idSesion)) errores.push('idSesion no es un id válido');
	if (!Number.isInteger(posicionSeg) || posicionSeg < 0) errores.push('posicionSeg debe ser un entero >= 0');
	if (!EVENTOS.includes(evento)) errores.push(`evento debe ser uno de: ${EVENTOS.join(', ')}`);
	if (errores.length) throw pedidoInvalido('El pedido no es válido', errores);

	const sesion = await redis.hGetAll(claves.sesion(idSesion));
	if (!sesion.idPerfil) throw new ErroresApp(`La sesión ${idSesion} no existe o expiró`, 410);
	const { idCuenta, idPerfil, idDispositivo, idContenido, idEpisodio: unidad, idVisualizacion } = sesion;
	const fechaInicio = new Date(sesion.fechaInicio);
	// P4 ya registró el fin: se ignora un reporte tardío
	if (sesion.finalizada === idVisualizacion) {
		throw conflicto('Esta visualización ya terminó: iniciá la reproducción del siguiente episodio');
	}

	const ahora = new Date();
	const reporte = await redis.eval(REPORTAR_PROGRESO, {
		keys: [
			claves.sesion(idSesion), claves.cupo(idCuenta), claves.viendo(idContenido),
			claves.cv(idPerfil, idContenido), claves.continuar(idPerfil), claves.perfilesConCv(idContenido),
			claves.dispositivo(idDispositivo), claves.vida(idSesion), claves.retirado(idContenido),
		],
		arguments: [
			idSesion, idPerfil, idContenido, unidad,
			String(posicionSeg), String(ahora.getTime()), ahora.toISOString(), String(SESION_TTL_SEG),
		],
	});
	// Pudo expirar entre la lectura y el script
	if (reporte === -1) throw new ErroresApp(`La sesión ${idSesion} no existe o expiró`, 410);
	if (reporte === -2) throw new ErroresApp('El contenido fue retirado del catálogo', 410);

	const tocaCheckpoint = evento !== 'reporte' || reporte % CHECKPOINT_CADA === 0;
	let checkpoint = 'no_corresponde';
	if (tocaCheckpoint) {
		try {
			await cassandraClient.batch(
				[
					{
						query: ACTUALIZAR_POR_PERFIL,
						params: [posicionSeg, ahora, idPerfil, mesDe(fechaInicio), fechaInicio, idVisualizacion],
					},
					{
						query: ACTUALIZAR_POR_CONTENIDO,
						params: [posicionSeg, ahora, idContenido, fechaInicio, idVisualizacion],
					},
				],
				{ prepare: true, logged: true },
			);
			checkpoint = 'guardado';
		} catch (error) {
			// No se compensa Redis: el próximo checkpoint corrige Cassandra
			console.error(`P3: falló el checkpoint de ${idVisualizacion} en Cassandra:`, error.message);
			checkpoint = 'fallido';
		}
	}

	return { idSesion, idVisualizacion, idEpisodio: unidad, posicionSeg, reporte, checkpoint };
}

async function perfilExiste(idPerfil) {
	const cuenta = await db.collection('cuentas').findOne({ 'perfiles.id': idPerfil }, { projection: { _id: 1 } });
	if (!cuenta) throw noEncontrado(`No existe el perfil ${idPerfil}`);
}

// Si Redis perdió los datos se reconstruye desde Cassandra (mes actual o el anterior).
// Igual que P4: si la última visualización terminó, se retoma en el episodio siguiente.
async function reconstruirDesdeCassandra(idPerfil) {
	const ahora = new Date();
	const anterior = new Date(Date.UTC(ahora.getUTCFullYear(), ahora.getUTCMonth() - 1, 1));

	let filas = [];
	for (const mes of [mesDe(ahora), mesDe(anterior)]) {
		({ rows: filas } = await cassandraClient.execute(HISTORIAL_DEL_MES, [idPerfil, mes, 500], { prepare: true }));
		if (filas.length) break;
	}

	// Vienen de la más nueva a la más vieja
	const ultimas = new Map();
	for (const f of filas) {
		const idContenido = f.id_contenido.toString();
		if (!ultimas.has(idContenido)) ultimas.set(idContenido, f);
	}

	let reconstruidos = 0;
	for (const [idContenido, f] of ultimas) {
		let unidad = f.id_episodio?.toString() ?? idContenido; // película: la unidad es el contenido
		let segundo = f.posicion_seg ?? 0;
		if (f.finalizado) {
			if (!f.id_episodio) continue;
			const { siguiente } = await unidadYSiguiente(idContenido, unidad).catch(() => ({ siguiente: null }));
			if (!siguiente) continue;
			[unidad, segundo] = [siguiente.idEpisodio, 0];
		}
		const actualizado = f.fecha_fin ?? f.fecha;
		reconstruidos++;
		await redis.multi()
			.hSet(claves.cv(idPerfil, idContenido), {
				idEpisodio: unidad, segundo: String(segundo), actualizado: actualizado.toISOString(),
			})
			.zAdd(claves.continuar(idPerfil), { score: actualizado.getTime(), value: idContenido })
			.sAdd(claves.perfilesConCv(idContenido), idPerfil)
			.exec();
	}
	return reconstruidos;
}

export async function continuarViendo(idPerfil, { limite } = {}) {
	if (!esId(idPerfil)) throw pedidoInvalido('idPerfil no es un id válido');
	limite = Math.min(Math.max(parseInt(limite) || 10, 1), 50);
	await perfilExiste(idPerfil);

	let origen = 'redis';
	let ids = await redis.zRange(claves.continuar(idPerfil), 0, limite - 1, { REV: true });
	if (!ids.length && await reconstruirDesdeCassandra(idPerfil)) {
		origen = 'cassandra';
		ids = await redis.zRange(claves.continuar(idPerfil), 0, limite - 1, { REV: true });
	}
	if (!ids.length) return { idPerfil, origen, contenidos: [] };

	const cvs = await Promise.all(ids.map((idContenido) => redis.hGetAll(claves.cv(idPerfil, idContenido))));

	// solo lo publicado
	const fichas = await db.collection('contenidos').find(
		{ _id: { $in: ids }, estado: 'publicado' },
		{ projection: { titulo: 1, tipo: 1, duracionSeg: 1, temporadas: 1 } },
	).toArray();
	const porId = new Map(fichas.map((f) => [f._id, f]));

	const contenidos = [];
	ids.forEach((idContenido, i) => {
		const ficha = porId.get(idContenido);
		const cv = cvs[i];
		if (!ficha || !cv.idEpisodio) return;

		const item = {
			idContenido, titulo: ficha.titulo, tipo: ficha.tipo,
			posicionSeg: Number(cv.segundo), actualizado: cv.actualizado, duracionSeg: ficha.duracionSeg,
		};
		if (ficha.tipo === 'serie') {
			for (const t of ficha.temporadas) {
				const ep = t.episodios.find((e) => e.id === cv.idEpisodio);
				if (ep) Object.assign(item, {
					idEpisodio: ep.id, temporada: t.numero, episodio: ep.numero, tituloEpisodio: ep.titulo, duracionSeg: ep.duracionSeg,
				});
			}
		}
		contenidos.push(item);
	});

	return { idPerfil, origen, contenidos };
}

const MES_VALIDO = /^\d{4}-(0[1-9]|1[0-2])$/;
const MAX_MESES = 12;

// Meses 'AAAA-MM' entre desde y hasta, del más nuevo al más viejo
function mesesEntre(desde, hasta) {
	const meses = [];
	let [anio, mes] = hasta.split('-').map(Number);
	while (`${anio}-${String(mes).padStart(2, '0')}` >= desde) {
		meses.push(`${anio}-${String(mes).padStart(2, '0')}`);
		if (--mes === 0) { mes = 12; anio--; }
	}
	return meses;
}

export async function historial(idPerfil, { desde, hasta, limite } = {}) {
	// Por defecto, los últimos 3 meses
	if (!esId(idPerfil)) throw pedidoInvalido('idPerfil no es un id válido');
	const ahora = new Date();
	hasta ??= mesDe(ahora);
	desde ??= mesDe(new Date(Date.UTC(ahora.getUTCFullYear(), ahora.getUTCMonth() - 2, 1)));
	if (!MES_VALIDO.test(desde) || !MES_VALIDO.test(hasta)) throw pedidoInvalido('desde y hasta van con formato AAAA-MM');
	if (desde > hasta) throw pedidoInvalido('desde no puede ser posterior a hasta');
	const meses = mesesEntre(desde, hasta);
	if (meses.length > MAX_MESES) throw pedidoInvalido(`El período no puede superar ${MAX_MESES} meses`);
	limite = Math.min(Math.max(parseInt(limite) || 100, 1), 500);
	await perfilExiste(idPerfil);

	// Una partición por mes, ya ordenada por fecha
	const visualizaciones = [];
	for (const mes of meses) {
		const faltan = limite - visualizaciones.length;
		if (faltan <= 0) break;
		const { rows } = await cassandraClient.execute(HISTORIAL_DEL_MES, [idPerfil, mes, faltan], { prepare: true });
		for (const f of rows) {
			visualizaciones.push({
				idVisualizacion: f.id_visualizacion.toString(),
				idContenido: f.id_contenido.toString(),
				idEpisodio: f.id_episodio?.toString() ?? null,
				fechaInicio: f.fecha, fechaFin: f.fecha_fin,
				posicionSeg: f.posicion_seg, finalizado: f.finalizado,
			});
		}
	}

	// Incluye retirados: el historial se conserva
	const ids = [...new Set(visualizaciones.map((v) => v.idContenido))];
	const fichas = await db.collection('contenidos').find({ _id: { $in: ids } }, { projection: { titulo: 1 } }).toArray();
	const titulos = new Map(fichas.map((f) => [f._id, f.titulo]));
	for (const v of visualizaciones) v.titulo = titulos.get(v.idContenido) ?? null;

	return { idPerfil, desde, hasta, total: visualizaciones.length, visualizaciones };
}
