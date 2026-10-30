import db from '../db/mongo.js';
import { redis } from '../db/redis.js';
import { cypher } from '../db/neo4j.js';
import { cassandraClient } from '../db/cassandra.js';
import { sql } from '../db/postgres.js';

import { esId } from '../lib/ids.js';
import { pedidoInvalido, noEncontrado, conflicto } from '../lib/errores.js';
import { ejecutarSaga } from '../lib/saga.js';
import { claves } from './p2-inicio-reproduccion-sesiones.js';

const FECHA_VALIDA = /^\d{4}-\d{2}-\d{2}$/;
const hoy = () => new Date().toISOString().slice(0, 10);

function validarFecha(fecha) {
	fecha ??= hoy();
	if (!FECHA_VALIDA.test(fecha) || Number.isNaN(Date.parse(fecha))) throw pedidoInvalido('fecha va con formato AAAA-MM-DD');
	return fecha;
}

// PostgreSQL consultas:

// vigencia es [desde, hasta)
const LICENCIAS_VIGENTES = `
  SELECT id_licencia, region, lower(vigencia) AS desde, upper(vigencia) AS hasta,
         vigencia @> $2::date AS cubre_fecha
  FROM licencia WHERE id_contenido = $1 AND estado = 'vigente'`;
// Idempotente: solo cambia las vigentes
const VENCER = `UPDATE licencia SET estado = 'vencida'
  WHERE id_licencia = ANY($1::uuid[]) AND estado = 'vigente' RETURNING id_licencia`;
const REVIVIR = `UPDATE licencia SET estado = 'vigente'
  WHERE id_licencia = ANY($1::uuid[]) AND estado = 'vencida'`;
const CONTENIDOS_CON_VENCIDAS = `
  SELECT DISTINCT id_contenido FROM licencia WHERE estado = 'vigente' AND upper(vigencia) <= $1::date`;

// Redis consultas:

// Saca el contenido de continuar viendo de todos los perfiles y devuelve lo que había para compensar.
// Lo marca como retirado para que P3 deje de aceptar progreso. Los perfiles salen de cv_perfiles:{id} (evita SCAN).
const QUITAR_CONTINUAR = `
local idContenido = ARGV[1]
local perfiles = redis.call('SMEMBERS', KEYS[1])
local guardado = {}
for _, idPerfil in ipairs(perfiles) do
  local cv = redis.call('HGETALL', 'cv:' .. idPerfil .. ':' .. idContenido)
  local score = redis.call('ZSCORE', 'continuar:' .. idPerfil, idContenido)
  if #cv > 0 then guardado[#guardado + 1] = { idPerfil, score or '0', cv } end
  redis.call('DEL', 'cv:' .. idPerfil .. ':' .. idContenido)
  redis.call('ZREM', 'continuar:' .. idPerfil, idContenido)
end
redis.call('DEL', KEYS[1])
redis.call('SET', KEYS[2], '1')
return guardado`;

// Neo4j consultas:

const MARCAR_RETIRADO = `MATCH (c:Contenido {id: $id})
  WITH c, c.estado AS previo
  SET c.estado = 'retirado', c.retiradoPor = $idSaga
  RETURN previo`;
// La compensación solo deshace el retiro de esta saga
const DESMARCAR = `MATCH (c:Contenido {id: $id}) WHERE c.retiradoPor = $idSaga
  SET c.estado = $previo REMOVE c.retiradoPor`;

// La licencia se vence al final: si algo falla sigue vigente y el próximo proceso lo reintenta.
export async function retirarContenido(idContenido, { fecha, fallarEn } = {}) {
	if (!esId(idContenido)) throw pedidoInvalido('idContenido no es un id válido');
	fecha = validarFecha(fecha);

	const ficha = await db.collection('contenidos').findOne(
		{ _id: idContenido },
		{ projection: { titulo: 1, estado: 1, retiro: 1 } },
	);
	if (!ficha) throw noEncontrado(`No existe el contenido ${idContenido}`);
	// Reintento de un retiro ya terminado
	if (ficha.estado === 'retirado') return { idContenido, titulo: ficha.titulo, yaRetirado: true, retiro: ficha.retiro };
	if (ficha.estado !== 'publicado') throw conflicto(`"${ficha.titulo}" está en ${ficha.estado}: solo se retira lo publicado`);

	const licencias = await sql(LICENCIAS_VIGENTES, [idContenido, fecha]);
	const vigentes = licencias.filter((l) => l.cubre_fecha);
	if (vigentes.length) {
		throw conflicto(`"${ficha.titulo}" tiene licencia vigente al ${fecha}`, {
			licencias: vigentes.map((l) => ({ idLicencia: l.id_licencia, region: l.region, hasta: l.hasta })),
		});
	}
	const vencidas = licencias.filter((l) => l.hasta <= fecha);
	if (!vencidas.length) throw conflicto(`"${ficha.titulo}" no tiene licencias vencidas al ${fecha}`);
	const ultima = vencidas.reduce((a, b) => (b.hasta > a.hasta ? b : a)); // la que provocó el retiro
	const idsVencidas = vencidas.map((l) => l.id_licencia);

	const { idSaga } = await ejecutarSaga({
		tipo: 'retiro_contenido',
		fallarEn,
		datos: { idContenido, fecha, idLicencia: ultima.id_licencia, licencias: idsVencidas },
		pasos: [
			{
				nombre: 'continuar_viendo', // Redis
				ejecutar: async () => {
					const guardado = await redis.eval(QUITAR_CONTINUAR, {
						keys: [claves.perfilesConCv(idContenido), claves.retirado(idContenido)], arguments: [idContenido],
					});
					return { guardado };
				},
				compensar: async ({ guardado }) => {
					const multi = redis.multi().del(claves.retirado(idContenido));
					for (const [idPerfil, score, cv] of guardado) {
						multi.del(claves.cv(idPerfil, idContenido));
						const campos = {};
						for (let i = 0; i < cv.length; i += 2) campos[cv[i]] = cv[i + 1];
						multi.hSet(claves.cv(idPerfil, idContenido), campos);
						multi.zAdd(claves.continuar(idPerfil), { score: Number(score), value: idContenido });
						multi.sAdd(claves.perfilesConCv(idContenido), idPerfil);
					}
					await multi.exec();
				},
			},
			{
				nombre: 'marcar_nodo', // Neo4j: sale de recomendaciones y vínculos
				ejecutar: async ({ idSaga }) => {
					const [fila] = await cypher(MARCAR_RETIRADO, { id: idContenido, idSaga });
					return { previo: fila?.previo ?? 'publicado', idSaga };
				},
				compensar: async ({ previo, idSaga }) => {
					await cypher(DESMARCAR, { id: idContenido, idSaga, previo });
				},
			},
			{
				nombre: 'retirar_ficha', // Mongo: sale de la exploración
				ejecutar: async ({ idSaga }) => {
					const { matchedCount } = await db.collection('contenidos').updateOne(
						{ _id: idContenido, estado: 'publicado' },
						{ $set: { estado: 'retirado', retiro: { idLicencia: ultima.id_licencia, fecha: new Date(fecha), idSaga } } },
					);
					if (!matchedCount) throw conflicto(`"${ficha.titulo}" dejó de estar publicado mientras se retiraba`);
					return { idSaga };
				},
				compensar: async ({ idSaga }) => {
					await db.collection('contenidos').updateOne(
						{ _id: idContenido, 'retiro.idSaga': idSaga },
						{ $set: { estado: 'publicado' }, $unset: { retiro: '' } },
					);
				},
			},
			{
				nombre: 'vencer_licencias', // PostgreSQL: último
				ejecutar: async () => {
					const filas = await sql(VENCER, [idsVencidas]);
					return { vencidas: filas.map((f) => f.id_licencia) };
				},
				compensar: async ({ vencidas }) => {
					await sql(REVIVIR, [vencidas]);
				},
			},
		],
	});

	return {
		idContenido, titulo: ficha.titulo, idSaga, estado: 'retirado', fecha,
		licencia: { idLicencia: ultima.id_licencia, region: ultima.region, hasta: ultima.hasta },
		licenciasVencidas: idsVencidas.length,
	};
}

// Vence las licencias terminadas a la fecha. Si al contenido no le queda otra, se retira (saga).
export async function procesarVencimientos({ fecha } = {}) {
	fecha = validarFecha(fecha);
	const contenidos = await sql(CONTENIDOS_CON_VENCIDAS, [fecha]);

	const resultado = { fecha, revisados: contenidos.length, retirados: [], soloLicenciasVencidas: 0, errores: [] };
	for (const { id_contenido: idContenido } of contenidos) {
		try {
			const licencias = await sql(LICENCIAS_VIGENTES, [idContenido, fecha]);
			if (licencias.some((l) => l.cubre_fecha)) {
				// Le queda otra licencia: sigue publicado
				await sql(VENCER, [licencias.filter((l) => l.hasta <= fecha).map((l) => l.id_licencia)]);
				resultado.soloLicenciasVencidas++;
			} else {
				const r = await retirarContenido(idContenido, { fecha });
				resultado.retirados.push({ idContenido, titulo: r.titulo, idSaga: r.idSaga });
			}
		} catch (error) {
			// Si uno falla sigue con los demás; se reintenta en la próxima corrida
			resultado.errores.push({ idContenido, error: error.message, idSaga: error.idSaga });
		}
	}
	return resultado;
}

const VINCULOS_Y_SENALES = `
  MATCH (c:Contenido {id: $id})
  OPTIONAL MATCH (c)-[r:RELACIONADO]-(o:Contenido)
  WITH c, collect(CASE WHEN o IS NULL THEN null ELSE {
    idContenido: o.id, titulo: o.titulo, estado: o.estado,
    // (A)-[secuela]->(B): A es secuela de B
    relacion: CASE WHEN r.tipo <> 'secuela' THEN r.tipo WHEN startNode(r) = c THEN 'precuela' ELSE 'secuela' END
  } END) AS vinculos
  OPTIONAL MATCH (c)<-[:ACTUA_EN]-(a:Actor)
  WITH c, vinculos, count(a) AS elenco
  OPTIONAL MATCH (c)<-[v:VIO]-()
  RETURN c.estado AS estado, c.retiradoPor AS retiradoPor, vinculos, elenco, count(v) AS senalesVio`;

const HISTORIAL = `SELECT fecha, id_visualizacion, id_perfil, id_episodio, fecha_fin, posicion_seg, finalizado
  FROM historial_por_contenido WHERE id_contenido = ? LIMIT ?`;
const TOTAL_HISTORIAL = 'SELECT count(*) AS total FROM historial_por_contenido WHERE id_contenido = ?';

const LICENCIAS = `SELECT id_licencia, region, lower(vigencia) AS desde, upper(vigencia) AS hasta, estado
  FROM licencia WHERE id_contenido = $1 ORDER BY lower(vigencia) DESC`;

// Sesiones vivas en viendo:{id} y sus perfiles
async function viendoAhora(idContenido) {
	const sesiones = await redis.zRange(claves.viendo(idContenido), 0, -1);
	const perfiles = new Set();
	let activas = 0;
	for (const idSesion of sesiones) {
		const [vive, s] = await Promise.all([redis.exists(claves.vida(idSesion)), redis.hGetAll(claves.sesion(idSesion))]);
		if (!vive || s.idContenido !== idContenido) continue; // vencida o ya en otro contenido
		activas++;
		perfiles.add(s.idPerfil);
	}
	return { perfiles: perfiles.size, sesiones: activas };
}

export async function trazabilidad(idContenido, { limite } = {}) {
	if (!esId(idContenido)) throw pedidoInvalido('idContenido no es un id válido');
	limite = Math.min(Math.max(parseInt(limite) || 20, 1), 200);

	// Las cinco consultas en paralelo: si un motor falla se informa cuál y se devuelve el resto
	const [ficha, grafo, ahora, historial, licencias] = await Promise.allSettled([
		db.collection('contenidos').findOne(
			{ _id: idContenido },
			{ projection: { titulo: 1, tipo: 1, estado: 1, anioEstreno: 1, clasificacionEdad: 1, generos: 1, plataforma: 1, retiro: 1, temporadas: 1 } },
		),
		cypher(VINCULOS_Y_SENALES, { id: idContenido }).then(([fila]) => fila ?? null),
		viendoAhora(idContenido),
		Promise.all([
			cassandraClient.execute(HISTORIAL, [idContenido, limite], { prepare: true }),
			cassandraClient.execute(TOTAL_HISTORIAL, [idContenido], { prepare: true }),
		]),
		sql(LICENCIAS, [idContenido]),
	]);

	if (ficha.status === 'fulfilled' && !ficha.value) throw noEncontrado(`No existe el contenido ${idContenido}`);
	const motor = (resultado, armar) => (resultado.status === 'fulfilled'
		? armar(resultado.value)
		: { error: `motor no disponible: ${resultado.reason.message}` });

	return {
		idContenido,
		ficha: motor(ficha, (f) => {
			const { temporadas, ...resto } = f;
			return { ...resto, episodios: temporadas?.reduce((n, t) => n + t.episodios.length, 0) ?? null, origen: 'MongoDB' };
		}),
		vinculos: motor(grafo, (g) => (g ? { ...g, origen: 'Neo4j' } : { error: 'el contenido no está en el grafo' })),
		viendoAhora: motor(ahora, (v) => ({ ...v, origen: 'Redis' })),
		historial: motor(historial, ([pagina, total]) => ({
			total: Number(total.rows[0].total),
			ultimas: pagina.rows.map((f) => ({
				idVisualizacion: f.id_visualizacion.toString(), idPerfil: f.id_perfil.toString(),
				idEpisodio: f.id_episodio?.toString() ?? null, fechaInicio: f.fecha, fechaFin: f.fecha_fin,
				posicionSeg: f.posicion_seg, finalizado: f.finalizado,
			})),
			origen: 'Cassandra',
		})),
		licencias: motor(licencias, (filas) => ({
			licencias: filas.map((l) => ({ idLicencia: l.id_licencia, region: l.region, desde: l.desde, hasta: l.hasta, estado: l.estado })),
			origen: 'PostgreSQL',
		})),
	};
}
