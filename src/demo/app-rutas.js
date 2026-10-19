// Rutas auxiliares de la app de demo (/app): lo que la app necesita mostrar y la API no tiene
// (cuentas para elegir, dispositivos, estado de los motores, licencias, catálogo para los filtros).
// Son consultas internas: van sin traza, así la columna de motores muestra solo los ejercicios.
import { Router } from 'express';
import db from '../db/mongo.js';
import { cypher } from '../db/neo4j.js';
import { redis } from '../db/redis.js';
import { cassandraClient } from '../db/cassandra.js';
import { sql } from '../db/postgres.js';
import { sinTraza } from './traza.js';
import { datosDemo } from './rutas.js';
import { esId } from '../lib/ids.js';
import { pedidoInvalido, noEncontrado } from '../lib/errores.js';

const router = Router();

const CUENTAS_EXTRA = 4;  // además de la demo, para elegir
const MAX_BUSQUEDA = 10;
const LICENCIAS_EXTRA = 8;
const ACTORES = 12;
const TIPOS_DISPOSITIVO = ['tv', 'movil', 'web', 'consola', 'tablet'];

const escaparRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const conTodo = (fn) => async (req, res) => res.json(await sinTraza(() => fn(req)));

// ─── Estado de conexión de cada motor ─────────────────────────────────────────

router.get('/motores', conTodo(async () => {
	const pings = {
		mongo: () => db.command({ ping: 1 }),
		neo4j: () => cypher('RETURN 1 AS ok'),
		cassandra: () => cassandraClient.execute('SELECT now() FROM system.local'),
		redis: () => redis.ping(),
		postgres: () => sql('SELECT 1'),
	};
	const nombres = Object.keys(pings);
	const resultados = await Promise.allSettled(nombres.map((m) => pings[m]()));
	return Object.fromEntries(nombres.map((m, i) => [m, resultados[i].status === 'fulfilled']));
}));

// ─── Cuentas para elegir ──────────────────────────────────────────────────────

const PROYECCION_CUENTA = { email: 1, limiteSesiones: 1, perfiles: 1 };
const cuentaPublica = (c) => ({
	id: c._id, email: c.email, limiteSesiones: c.limiteSesiones,
	perfiles: c.perfiles.map((p) => ({ id: p.id, nombre: p.nombre, clasificacionEdad: p.clasificacionEdad })),
});

router.get('/cuentas', conTodo(async (req) => {
	const cuentas = db.collection('cuentas');
	const email = String(req.query.email ?? '').trim();
	if (email) {
		const encontradas = await cuentas
			.find({ estado: 'activa', email: { $regex: escaparRegex(email), $options: 'i' } }, { projection: PROYECCION_CUENTA })
			.sort({ email: 1 }).limit(MAX_BUSQUEDA).toArray();
		return { cuentas: encontradas.map(cuentaPublica) };
	}
	const demo = await cuentas.findOne({ email: 'demo@streamdb.test' }, { projection: PROYECCION_CUENTA });
	// Una cuenta por cada límite de sesiones distinto, para mostrar cupos diferentes
	const otras = [];
	const limites = new Set();
	for await (const c of cuentas.find({ estado: 'activa', _id: { $ne: demo?._id } }, { projection: PROYECCION_CUENTA }).sort({ _id: 1 }).limit(200)) {
		if (otras.length >= CUENTAS_EXTRA) break;
		if (limites.has(c.limiteSesiones) && limites.size < 3) continue;
		limites.add(c.limiteSesiones);
		otras.push(c);
	}
	return { cuentas: [demo, ...otras].filter(Boolean).map(cuentaPublica) };
}));

// ─── Dispositivos (el seed no los asocia a cuentas: uno de cada tipo) ─────────

router.get('/dispositivos', conTodo(async () => {
	const dispositivos = await Promise.all(TIPOS_DISPOSITIVO.map((tipo) => db.collection('dispositivos')
		.findOne({ tipo }, { sort: { _id: 1 }, projection: { tipo: 1, modelo: 1, sistemaOperativo: 1 } })));
	return {
		dispositivos: dispositivos.filter(Boolean).map((d) => ({ id: d._id, tipo: d.tipo, modelo: d.modelo, sistemaOperativo: d.sistemaOperativo })),
	};
}));

// ─── Contenidos con sus licencias (P8) ────────────────────────────────────────

const LICENCIAS = `SELECT id_licencia, id_contenido, region, lower(vigencia) AS desde, upper(vigencia) AS hasta, estado
                   FROM licencia WHERE id_contenido = ANY($1::uuid[]) ORDER BY region, lower(vigencia)`;

async function conLicencias(ids) {
	const [fichas, filas] = await Promise.all([
		db.collection('contenidos').find({ _id: { $in: ids } }, { projection: { titulo: 1, estado: 1 } }).toArray(),
		sql(LICENCIAS, [ids]),
	]);
	const porId = new Map(fichas.map((f) => [f._id, f]));
	return ids.filter((id) => porId.has(id)).map((id) => ({
		id, titulo: porId.get(id).titulo, estado: porId.get(id).estado,
		licencias: filas.filter((l) => l.id_contenido === id)
			.map((l) => ({ idLicencia: l.id_licencia, region: l.region, desde: l.desde, hasta: l.hasta, estado: l.estado })),
	}));
}

router.get('/licencias', conTodo(async (req) => {
	const q = String(req.query.q ?? '').trim();
	if (q) {
		const fichas = await db.collection('contenidos')
			.find({ titulo: { $regex: escaparRegex(q), $options: 'i' } }, { projection: { _id: 1 } })
			.sort({ titulo: 1 }).limit(MAX_BUSQUEDA).toArray();
		return { contenidos: await conLicencias(fichas.map((f) => f._id)) };
	}
	const d = await datosDemo();
	const fijos = [d.serie.id, d.vencido?.id].filter(Boolean);
	const otros = await sql(
		`SELECT DISTINCT id_contenido FROM licencia WHERE NOT id_contenido = ANY($1::uuid[]) ORDER BY id_contenido LIMIT $2`,
		[fijos, LICENCIAS_EXTRA],
	);
	return { contenidos: await conLicencias([...fijos, ...otros.map((f) => f.id_contenido)]) };
}));

// ─── Ficha de un contenido (para el detalle y la duración en el reproductor) ──

router.get('/contenidos/:id', conTodo(async (req) => {
	if (!esId(req.params.id)) throw pedidoInvalido('id no es un id válido');
	const c = await db.collection('contenidos').findOne({ _id: req.params.id }, {
		projection: { titulo: 1, tipo: 1, estado: 1, anioEstreno: 1, clasificacionEdad: 1, generos: 1, plataforma: 1, elenco: 1, duracionSeg: 1, temporadas: 1 },
	});
	if (!c) throw noEncontrado(`No existe el contenido ${req.params.id}`);
	const { _id, ...resto } = c;
	return { id: _id, ...resto };
}));

// ─── Catálogo para filtros y para el alta de P1 ───────────────────────────────

router.get('/catalogo', conTodo(async () => {
	const [generos, actores, plataformas] = await Promise.all([
		cypher('MATCH (g:Genero) RETURN g.nombre AS nombre ORDER BY nombre'),
		cypher(`MATCH (a:Actor) RETURN a.id AS id, a.nombre + ' ' + a.apellido AS nombre ORDER BY a.id LIMIT ${ACTORES}`),
		db.collection('contenidos').aggregate([
			{ $group: { _id: '$plataforma.id', nombre: { $first: '$plataforma.nombre' } } },
			{ $sort: { nombre: 1 } },
		]).toArray(),
	]);
	return {
		generos: generos.map((g) => g.nombre),
		plataformas: plataformas.map((p) => ({ id: p._id, nombre: p.nombre })),
		actores,
	};
}));

export default router;
