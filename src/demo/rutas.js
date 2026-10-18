// Panel de demo (GET /demo): ejecuta cada problema y cada falla, y muestra qué hizo cada motor.
// Estas rutas solo sirven al panel: datos de ejemplo, trazas, estado de los motores y reinicio.
import { Router } from 'express';
import { fileURLToPath } from 'node:url';
import db from '../db/mongo.js';
import { cypher } from '../db/neo4j.js';
import { redis } from '../db/redis.js';
import { cassandraClient } from '../db/cassandra.js';
import { sql } from '../db/postgres.js';
import { esId } from '../lib/ids.js';
import { pedidoInvalido, noEncontrado } from '../lib/errores.js';
import { claves } from '../problemas/p2-inicio-reproduccion-sesiones.js';
import { cerrarSesionesDeCuenta } from '../problemas/p6-expiracion-cierre-sesiones.js';
import { obtenerTraza, sinTraza } from './traza.js';

const router = Router();
const PANEL = fileURLToPath(new URL('./panel.html', import.meta.url));
const PREFIJO_ALTA = 'Demo P1 · '; // título de las series que crea el panel (el reinicio las borra)

router.get('/', (req, res) => res.sendFile(PANEL));

// ─── Datos de ejemplo (los fijos del seed) ────────────────────────────────────

let cache = null;
async function datosDemo() {
	if (cache) return cache;
	const contenidos = db.collection('contenidos');
	const [cuenta, serie, pelicula, dispositivos, [vencido]] = await Promise.all([
		db.collection('cuentas').findOne({ email: 'demo@streamdb.test' }, { projection: { limiteSesiones: 1, perfiles: 1 } }),
		contenidos.findOne({ titulo: 'El faro del norte', tipo: 'serie' }),
		contenidos.findOne(
			{ tipo: 'pelicula', estado: 'publicado', clasificacionEdad: { $lte: 13 } },
			{ sort: { _id: 1 }, projection: { titulo: 1, clasificacionEdad: 1 } },
		),
		db.collection('dispositivos').find({}, { sort: { _id: 1 }, limit: 3, projection: { _id: 1 } }).toArray(),
		// Un contenido cuyas licencias terminaron todas (el seed deja algunos así para P8)
		sql(`SELECT id_contenido FROM licencia GROUP BY id_contenido
             HAVING max(upper(vigencia)) <= CURRENT_DATE ORDER BY id_contenido LIMIT 1`),
	]);
	if (!cuenta || !serie) throw noEncontrado('No están los datos de demo: corré npm run seed');
	const fichaVencido = vencido && await contenidos.findOne(
		{ _id: vencido.id_contenido },
		{ projection: { titulo: 1, clasificacionEdad: 1, plataforma: 1, generos: 1 } },
	);

	cache = {
		cuenta: { id: cuenta._id, limiteSesiones: cuenta.limiteSesiones },
		perfiles: cuenta.perfiles.map((p) => ({ id: p.id, nombre: p.nombre, clasificacionEdad: p.clasificacionEdad })),
		dispositivos: dispositivos.map((d) => d._id),
		serie: {
			id: serie._id, titulo: serie.titulo, clasificacionEdad: serie.clasificacionEdad,
			generos: serie.generos, idPlataforma: serie.plataforma.id, plataforma: serie.plataforma.nombre,
			elenco: serie.elenco.slice(0, 2).map((a) => ({ idActor: a.idActor, nombre: a.nombre })),
			episodios: serie.temporadas.flatMap((t) => t.episodios.map((e) => ({ id: e.id, titulo: `T${t.numero}E${e.numero} · ${e.titulo}` }))),
		},
		pelicula: pelicula && { id: pelicula._id, titulo: pelicula.titulo, clasificacionEdad: pelicula.clasificacionEdad },
		vencido: fichaVencido && {
			id: fichaVencido._id, titulo: fichaVencido.titulo, clasificacionEdad: fichaVencido.clasificacionEdad,
			idPlataforma: fichaVencido.plataforma.id, genero: fichaVencido.generos[0],
		},
		prefijoAlta: PREFIJO_ALTA,
	};
	return cache;
}

router.get('/api/datos', async (req, res) => {
	res.json(await sinTraza(datosDemo));
});

// ─── Traza de un pedido (con su saga, si la hubo) ─────────────────────────────

router.get('/api/trazas/:id', async (req, res) => {
	const traza = obtenerTraza(req.params.id);
	if (!traza) throw noEncontrado('No existe esa traza (se guardan solo las últimas 50)');
	const saga = traza.idSaga
		? await sinTraza(() => db.collection('sagas').findOne({ _id: traza.idSaga }))
		: null;
	res.json({ ...traza, saga });
});

// ─── Estado de los motores para los datos de demo ─────────────────────────────

const corto = (id) => (id ? String(id).slice(0, 8) : '—');
const segundos = (s) => (s == null ? '—' : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);
// Fecha corta para las claves de las filas de Cassandra (así no cambian cuando entra una fila nueva)
const momento = (fecha) => fecha.toLocaleString('es-AR', {
	timeZone: 'America/Argentina/Buenos_Aires', day: '2-digit', month: '2-digit',
	hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

async function estado(idPerfil) {
	const d = await datosDemo();
	const perfil = d.perfiles.find((p) => p.id === idPerfil) ?? d.perfiles[0];
	const titulos = new Map([[d.serie.id, d.serie.titulo], [d.pelicula?.id, d.pelicula?.titulo], [d.vencido?.id, d.vencido?.titulo]]);
	const episodios = new Map(d.serie.episodios.map((e) => [e.id, e.titulo]));
	const nombreDe = (id) => d.perfiles.find((p) => p.id === id)?.nombre ?? corto(id);
	const dispositivoDe = (id) => { const i = d.dispositivos.indexOf(id); return i >= 0 ? `dispositivo ${i + 1}` : corto(id); };
	const unidad = (idContenido, idEpisodio) =>
		!idEpisodio || idEpisodio === idContenido ? 'película' : (episodios.get(idEpisodio) ?? `episodio ${corto(idEpisodio)}`);
	const mes = new Date().toISOString().slice(0, 7);
	const ids = [d.serie.id, d.pelicula?.id, d.vencido?.id].filter(Boolean);

	const motor = async (fn) => { try { return await fn(); } catch (e) { return [{ clave: 'error', valor: `motor no disponible: ${e.message}` }]; } };

	const [r, c, n, m, p] = await Promise.all([
		motor(async () => {
			const filas = [];
			const sesiones = await redis.zRange(claves.cupo(d.cuenta.id), 0, -1);
			filas.push({ clave: `cupo:{cuenta}`, valor: `${sesiones.length} de ${d.cuenta.limiteSesiones} lugares ocupados` });
			for (const id of sesiones) {
				const [s, vida] = await Promise.all([redis.hGetAll(claves.sesion(id)), redis.ttl(claves.vida(id))]);
				filas.push({
					clave: `sesion:${corto(id)}`,
					valor: `${nombreDe(s.idPerfil)} · ${dispositivoDe(s.idDispositivo)} · ${titulos.get(s.idContenido) ?? corto(s.idContenido)}`
						+ (vida > 0 ? ` · vence en ${vida} s` : ' · vencida, sin cerrar'),
					id,
				});
			}
			for (const id of ids) {
				const cv = await redis.hGetAll(claves.cv(perfil.id, id));
				filas.push({
					clave: `cv:{${perfil.nombre}}:${titulos.get(id)}`,
					valor: cv.idEpisodio ? `${unidad(id, cv.idEpisodio)} · segundo ${segundos(Number(cv.segundo))}` : '(no lo empezó)',
				});
			}
			filas.push({ clave: `continuar:{${perfil.nombre}}`, valor: `${await redis.zCard(claves.continuar(perfil.id))} contenidos` });
			if (d.vencido) filas.push({ clave: `retirado:${d.vencido.titulo}`, valor: (await redis.exists(claves.retirado(d.vencido.id))) ? 'sí' : 'no' });
			filas.push({ clave: 'cierres_pendientes', valor: `${await redis.lLen('cierres_pendientes')} sin registrar en Cassandra` });
			return filas;
		}),
		motor(async () => {
			const [historial, sesiones] = await Promise.all([
				cassandraClient.execute(
					'SELECT fecha, id_visualizacion, id_contenido, id_episodio, posicion_seg, finalizado FROM historial_por_perfil WHERE id_perfil = ? AND mes = ? LIMIT 3',
					[perfil.id, mes], { prepare: true }),
				cassandraClient.execute(
					'SELECT fecha_inicio, id_sesion, id_dispositivo, fecha_fin, motivo_cierre FROM sesiones_por_cuenta WHERE id_cuenta = ? LIMIT 3',
					[d.cuenta.id], { prepare: true }),
			]);
			return [
				// ventana: son las 3 más recientes; si una sale porque entró otra, no es que se borró
				...historial.rows.map((f) => ({
					clave: `historial_por_perfil · ${momento(f.fecha)} · ${corto(f.id_visualizacion)}`, ventana: true,
					valor: `${titulos.get(f.id_contenido.toString()) ?? corto(f.id_contenido)} · ${unidad(f.id_contenido.toString(), f.id_episodio?.toString())}`
						+ ` · segundo ${segundos(f.posicion_seg)}${f.finalizado ? ' · terminado' : ''}`,
				})),
				...(historial.rows.length ? [] : [{ clave: 'historial_por_perfil', valor: `${perfil.nombre} no vio nada este mes` }]),
				...sesiones.rows.map((f) => ({
					clave: `sesiones_por_cuenta · ${momento(f.fecha_inicio)} · ${corto(f.id_sesion)}`, ventana: true,
					valor: `${dispositivoDe(f.id_dispositivo.toString())} · cerrada por ${f.motivo_cierre}`,
				})),
			];
		}),
		motor(async () => {
			const [vio] = await cypher('MATCH (:Perfil {id: $id})-[v:VIO]->() RETURN count(v) AS n', { id: perfil.id });
			const nodos = await cypher('MATCH (c:Contenido) WHERE c.id IN $ids RETURN c.id AS id, c.estado AS estado', { ids });
			const [altas] = await cypher('MATCH (c:Contenido) WHERE c.titulo STARTS WITH $p RETURN count(c) AS n', { p: PREFIJO_ALTA });
			const [vinculos] = await cypher('MATCH (:Contenido {id: $id})-[r:RELACIONADO]-() RETURN count(r) AS n', { id: d.serie.id });
			return [
				{ clave: `VIO de ${perfil.nombre}`, valor: `${vio.n} relaciones` },
				...nodos.map((x) => ({ clave: `(:Contenido) ${titulos.get(x.id)}`, valor: x.estado })),
				{ clave: `vínculos de ${d.serie.titulo}`, valor: `${vinculos.n} relaciones` },
				{ clave: 'series dadas de alta en el panel', valor: `${altas.n} nodos` },
			];
		}),
		motor(async () => {
			const [fichas, ultima, altas] = await Promise.all([
				db.collection('contenidos').find({ _id: { $in: ids } }, { projection: { estado: 1 } }).toArray(),
				db.collection('sagas').findOne({}, { sort: { creadaEn: -1 }, projection: { tipo: 1, estado: 1 } }),
				db.collection('contenidos').countDocuments({ titulo: { $regex: `^${PREFIJO_ALTA}` } }),
			]);
			return [
				...fichas.map((f) => ({ clave: `contenidos · ${titulos.get(f._id)}`, valor: f.estado })),
				{ clave: 'series dadas de alta en el panel', valor: `${altas} documentos` },
				{ clave: 'última saga', valor: ultima ? `${ultima.tipo} · ${ultima.estado}` : '(ninguna)', log: true },
			];
		}),
		motor(async () => {
			const filas = await sql(
				`SELECT id_contenido, region, upper(vigencia) AS hasta, estado FROM licencia
                 WHERE id_contenido = ANY($1::uuid[]) ORDER BY id_contenido, region`,
				[[d.serie.id, d.vencido?.id].filter(Boolean)],
			);
			return filas.map((f) => ({ clave: `licencia ${titulos.get(f.id_contenido)} · ${f.region}`, valor: `${f.estado} · hasta ${f.hasta}` }));
		}),
	]);

	return { perfil: perfil.nombre, motores: { redis: r, cassandra: c, neo4j: n, mongo: m, postgres: p } };
}

router.get('/api/estado', async (req, res) => {
	res.json(await sinTraza(() => estado(req.query.perfil)));
});

// ─── P6: forzar la expiración de una sesión (simula 2 minutos sin reportes) ───

// Le pone 1 ms de vida a vida:{id}. Al expirar, Redis avisa y el listener de P6 la cierra:
// es exactamente el camino de una expiración real, sin esperar los 120 s.
router.post('/api/expirar/:idSesion', async (req, res) => {
	const { idSesion } = req.params;
	if (!esId(idSesion)) throw pedidoInvalido('idSesion no es un id válido');
	if (!(await redis.pExpire(claves.vida(idSesion), 1))) throw noEncontrado('La sesión no está activa');

	// Se espera (sin registrar estas consultas) a que el listener la cierre
	const inicio = Date.now();
	let cerrada = false;
	while (!cerrada && Date.now() - inicio < 4000) {
		await new Promise((r) => setTimeout(r, 100));
		cerrada = !(await sinTraza(() => redis.exists(claves.sesion(idSesion))));
	}
	res.json({ idSesion, cerrada, cerradaPor: cerrada ? 'listener de expiraciones (P6)' : null, esperaMs: Date.now() - inicio });
});

// ─── Reiniciar la demo ────────────────────────────────────────────────────────

// Deshace los retiros que hizo la saga de P8 (los que tienen retiro.idSaga): vuelve a publicar
// en Mongo y Neo4j, las licencias a vigente y borra la marca de Redis. Los cv borrados no vuelven.
async function deshacerRetiros(filtro = {}) {
	const retirados = await db.collection('contenidos')
		.find({ ...filtro, estado: 'retirado', 'retiro.idSaga': { $exists: true } }, { projection: { 'retiro.idSaga': 1 } }).toArray();
	if (!retirados.length) return 0;
	const ids = retirados.map((c) => c._id);
	const sagas = await db.collection('sagas')
		.find({ _id: { $in: retirados.map((c) => c.retiro.idSaga) } }, { projection: { 'datos.licencias': 1 } }).toArray();
	const licencias = sagas.flatMap((s) => s.datos?.licencias ?? []);
	await Promise.all([
		db.collection('contenidos').updateMany({ _id: { $in: ids } }, { $set: { estado: 'publicado' }, $unset: { retiro: '' } }),
		cypher(`MATCH (c:Contenido) WHERE c.id IN $ids SET c.estado = 'publicado' REMOVE c.retiradoPor`, { ids }),
		sql(`UPDATE licencia SET estado = 'vigente' WHERE id_licencia = ANY($1::uuid[])`, [licencias]),
		redis.del(ids.map((id) => claves.retirado(id))),
	]);
	return retirados.length;
}

// Vuelve a publicar un contenido retirado por P8, para poder repetir el retiro (y sus fallas)
router.post('/api/republicar/:id', async (req, res) => {
	if (!esId(req.params.id)) throw pedidoInvalido('id no es un id válido');
	res.json({ idContenido: req.params.id, republicado: (await sinTraza(() => deshacerRetiros({ _id: req.params.id }))) === 1 });
});

// Deja los datos de demo como después del seed, para volver a probar:
// cierra las sesiones de la cuenta demo, deshace los retiros de P8 y borra las series que creó el panel.
router.post('/api/reiniciar', async (req, res) => {
	await sinTraza(async () => {
		const d = await datosDemo();
		const resultado = {};

		resultado.sesionesCerradas = (await cerrarSesionesDeCuenta(d.cuenta.id)).cerradas;
		resultado.retirosDeshechos = await deshacerRetiros();

		// Series creadas desde el panel (P1)
		const altas = await db.collection('contenidos').find({ titulo: { $regex: `^${PREFIJO_ALTA}` } }, { projection: { _id: 1 } }).toArray();
		const idsAltas = altas.map((c) => c._id);
		await Promise.all([
			db.collection('contenidos').deleteMany({ _id: { $in: idsAltas } }),
			cypher('MATCH (c:Contenido) WHERE c.titulo STARTS WITH $p DETACH DELETE c', { p: PREFIJO_ALTA }),
		]);
		resultado.seriesBorradas = idsAltas.length;

		res.json(resultado);
	});
});

export default router;
