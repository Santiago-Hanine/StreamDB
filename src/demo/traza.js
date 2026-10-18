// Traza de un pedido: registra cada operación que se hace contra los cinco motores (cuál, qué y
// cuánto tardó), para que el panel de demo muestre cómo resuelve cada problema.
// No cambia la lógica de los problemas: envuelve los clientes de cada motor una sola vez al arrancar.
// Solo se registra cuando el pedido trae el encabezado `x-traza` (lo manda el panel).
import { AsyncLocalStorage } from 'node:async_hooks';
import { client as mongo } from '../db/mongo.js';
import { driver as neo4j } from '../db/neo4j.js';
import { redis } from '../db/redis.js';
import { cassandraClient } from '../db/cassandra.js';
import { pool as postgres } from '../db/postgres.js';
import { nuevoId } from '../lib/ids.js';

const contexto = new AsyncLocalStorage();
const trazas = new Map(); // id → traza (solo las últimas)
const MAX_TRAZAS = 50;
const fondo = []; // operaciones fuera de todo pedido (listener y barrido de P6)
const MAX_FONDO = 300;

const ahora = () => performance.now();
// Espacios colapsados pero con los saltos de línea: el panel muestra la operación entera al expandirla
const compactar = (texto, max = 4000) => {
	const t = String(texto).split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).filter(Boolean).join('\n');
	return t.length > max ? t.slice(0, max) + '…' : t;
};
const json = (v) => {
	try { return JSON.stringify(v) ?? ''; } catch { return String(v); }
};
// Texto de la consulta + los parámetros con que se ejecutó
const conParametros = (texto, params) => {
	const hay = params && (Array.isArray(params) ? params.length : Object.keys(params).length);
	return hay ? `${texto}\n-- parámetros: ${json(params)}` : texto;
};

// ─── Registro ─────────────────────────────────────────────────────────────────

function abrir(motor, op, detalle, extra = {}) {
	const traza = contexto.getStore();
	if (traza?.silencio) return null; // pedido sin traza (o consulta interna del panel)
	const entrada = { motor, op, detalle: compactar(detalle), inicio: ahora(), ms: null, ...extra };
	if (traza) traza.ops.push(entrada);
	else {
		entrada.fondo = true;
		entrada.fecha = Date.now();
		fondo.push(entrada);
		if (fondo.length > MAX_FONDO) fondo.shift();
	}
	return entrada;
}

function cerrar(entrada, error) {
	if (!entrada) return;
	entrada.ms = Math.round((ahora() - entrada.inicio) * 10) / 10;
	if (error) entrada.error = compactar(error.message ?? error, 200);
}

// Envuelve una función que devuelve una promesa
function medir(motor, op, detalle, fn, extra) {
	const entrada = abrir(motor, op, detalle, extra);
	return fn().then(
		(r) => { cerrar(entrada); return r; },
		(e) => { cerrar(entrada, e); throw e; },
	);
}

// ─── MongoDB: eventos de monitoreo de comandos del driver ─────────────────────

// Los nombres de los pasos de cada saga (para mostrar "paso X → hecho" en el log)
const pasosDeSaga = new Map();
const MONGO_IGNORAR = new Set(['hello', 'isMaster', 'ping', 'endSessions', 'saslStart', 'saslContinue', 'buildInfo']);
const enCurso = new Map(); // requestId → entrada (el evento de fin no siempre llega con el contexto)

function describirMongo(nombre, cmd) {
	const coleccion = cmd[nombre];
	if (coleccion === 'sagas') {
		if (nombre === 'insert') {
			const saga = cmd.documents[0];
			pasosDeSaga.set(saga._id, saga.pasos.map((p) => p.nombre));
			return { detalle: `log de la saga: inicia "${saga.tipo}" con ${saga.pasos.length} pasos`, log: true, idSaga: saga._id };
		}
		if (nombre === 'update') {
			const { q, u } = cmd.updates[0];
			const pasos = pasosDeSaga.get(q._id) ?? [];
			const cambios = Object.entries(u.$set ?? {}).flatMap(([campo, valor]) => {
				const m = campo.match(/^pasos\.(\d+)\.estado$/);
				if (m) return [`paso "${pasos[m[1]] ?? m[1]}" → ${valor}`];
				if (campo === 'estado') return [`saga → ${valor}`];
				return [];
			});
			return { detalle: `log de la saga: ${cambios.join(', ') || 'actualiza'}`, log: true, idSaga: q._id };
		}
	}
	switch (nombre) {
		case 'find': {
			const extras = ['projection', 'sort', 'limit'].filter((k) => cmd[k] !== undefined).map((k) => ` · ${k} ${json(cmd[k])}`).join('');
			return { detalle: `${coleccion} · filtro ${json(cmd.filter ?? {})}${extras}` };
		}
		case 'aggregate': return { detalle: `${coleccion} · pipeline ${json(cmd.pipeline)}` };
		case 'insert': return { detalle: `${coleccion} · ${cmd.documents.length} documento(s): ${json(cmd.documents)}` };
		case 'update': return { detalle: `${coleccion} · filtro ${json(cmd.updates[0].q)} · cambio ${json(cmd.updates[0].u)}` };
		case 'delete': return { detalle: `${coleccion} · filtro ${json(cmd.deletes[0].q)}` };
		default: return { detalle: typeof coleccion === 'string' ? coleccion : '' };
	}
}

mongo.on('commandStarted', (e) => {
	if (MONGO_IGNORAR.has(e.commandName)) return;
	const { detalle, ...extra } = describirMongo(e.commandName, e.command);
	const entrada = abrir('mongo', e.commandName, detalle, extra);
	if (entrada) enCurso.set(e.requestId, entrada);
});
mongo.on('commandSucceeded', (e) => {
	cerrar(enCurso.get(e.requestId));
	enCurso.delete(e.requestId);
});
mongo.on('commandFailed', (e) => {
	cerrar(enCurso.get(e.requestId), e.failure);
	enCurso.delete(e.requestId);
});

// ─── Neo4j ────────────────────────────────────────────────────────────────────

const executeQuery = neo4j.executeQuery.bind(neo4j);
neo4j.executeQuery = (consulta, ...resto) => {
	const texto = typeof consulta === 'string' ? consulta : consulta.text;
	const op = texto.trim().split(/\s+/)[0].toUpperCase();
	return medir('neo4j', op, conParametros(texto, resto[0]), () => executeQuery(consulta, ...resto));
};

// ─── Redis ────────────────────────────────────────────────────────────────────

function describirRedis(args) {
	const comando = String(args[0]).toUpperCase();
	if (comando === 'EVAL' || comando === 'EVALSHA') {
		const n = Number(args[2]);
		const claves = args.slice(3, 3 + n).join(', ') || '(las arma el script)';
		const argv = args.slice(3 + n).map(String).join(', ');
		const script = comando === 'EVAL' ? `\n${args[1]}` : '';
		return { op: 'EVAL', detalle: `script Lua atómico · claves: ${claves}${argv ? ` · argumentos: ${argv}` : ''}${script}` };
	}
	return { op: comando, detalle: args.slice(1).map(String).join(' ') };
}

// `redis` es un proxy del cliente real (`_self`), que es el que manda los comandos: se envuelve ese
const cliente = redis._self ?? redis;
const sendCommand = cliente.sendCommand.bind(cliente);
cliente.sendCommand = (args, opciones) => {
	const { op, detalle } = describirRedis(args);
	return medir('redis', op, detalle, () => sendCommand(args, opciones));
};
// MULTI/EXEC no pasa por sendCommand
const executeMulti = cliente._executeMulti.bind(cliente);
cliente._executeMulti = (comandos, ...resto) => {
	const detalle = comandos.map((c) => c.args.map(String).join(' ')).join('\n');
	return medir('redis', 'MULTI', `${comandos.length} comandos:\n${detalle}`, () => executeMulti(comandos, ...resto));
};

// ─── Cassandra ────────────────────────────────────────────────────────────────

const primeraPalabra = (cql) => cql.trim().split(/\s+/)[0].toUpperCase();

const execute = cassandraClient.execute.bind(cassandraClient);
cassandraClient.execute = (cql, ...resto) => {
	if (typeof resto.at(-1) === 'function') return execute(cql, ...resto); // con callback: no se mide
	return medir('cassandra', primeraPalabra(cql), conParametros(cql, resto[0]), () => execute(cql, ...resto));
};
const batch = cassandraClient.batch.bind(cassandraClient);
cassandraClient.batch = (consultas, ...resto) => {
	if (typeof resto.at(-1) === 'function') return batch(consultas, ...resto);
	const textos = consultas.map((c) => (typeof c === 'string' ? compactar(c) : conParametros(compactar(c.query), c.params)));
	return medir('cassandra', 'BATCH', `${consultas.length} sentencias:\n${textos.join('\n')}`, () => batch(consultas, ...resto));
};

// ─── PostgreSQL ───────────────────────────────────────────────────────────────

const query = postgres.query.bind(postgres);
postgres.query = (sql, ...resto) => {
	const texto = typeof sql === 'string' ? sql : sql.text;
	const valores = Array.isArray(resto[0]) ? resto[0] : sql.values;
	return medir('postgres', primeraPalabra(texto), conParametros(texto, valores), () => query(sql, ...resto));
};

// ─── Middleware y consultas ───────────────────────────────────────────────────

// Va antes de las rutas. Con `x-traza`, el pedido se registra y la respuesta trae su id en `x-traza`
export function middleware(req, res, next) {
	if (!req.get('x-traza')) return contexto.run({ silencio: true }, next);

	const traza = {
		id: nuevoId(), metodo: req.method, ruta: req.originalUrl,
		fecha: Date.now(), inicio: ahora(), ms: null, status: null, ops: [],
	};
	trazas.set(traza.id, traza);
	if (trazas.size > MAX_TRAZAS) trazas.delete(trazas.keys().next().value);

	res.set('x-traza', traza.id);
	res.on('finish', () => {
		traza.ms = Math.round(ahora() - traza.inicio);
		traza.status = res.statusCode;
	});
	contexto.run(traza, next);
}

// Para las consultas internas del panel que no deben aparecer en la traza
export const sinTraza = (fn) => contexto.run({ silencio: true }, fn);

export function obtenerTraza(id) {
	const traza = trazas.get(id);
	if (!traza) return null;
	const fin = traza.inicio + (traza.ms ?? ahora() - traza.inicio);
	// Lo que hicieron los procesos de fondo mientras duraba el pedido (ej. el listener de P6)
	const deFondo = fondo.filter((o) => o.inicio >= traza.inicio && o.inicio <= fin);
	const ops = [...traza.ops, ...deFondo]
		.sort((a, b) => a.inicio - b.inicio)
		.map(({ inicio, fecha, ...o }) => ({ ...o, desde: Math.round((inicio - traza.inicio) * 10) / 10 }));
	const sagas = [...new Set(ops.filter((o) => o.idSaga).map((o) => o.idSaga))];
	const { inicio, ...resto } = traza;
	// Si hubo varias (ej. el proceso de vencimientos de P8, una por contenido), se muestra la primera
	return { ...resto, ops, idSaga: sagas[0] ?? null, cantidadSagas: sagas.length };
}
