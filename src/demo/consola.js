// Consola de la app de demo. Mongo, Cassandra, Redis y Postgres usan la shell real del contenedor,
// abierta una sola vez para que guarde el estado entre comandos. Neo4j va por el driver porque
// cypher-shell sin TTY no ejecuta nada hasta que se le cierra la entrada.
import { Router } from 'express';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isNode, isRelationship, isPath } from 'neo4j-driver';
import { driver } from '../db/neo4j.js';
import { sinTraza } from './traza.js';
import { pedidoInvalido, ErroresApp } from '../lib/errores.js';

const RAIZ = fileURLToPath(new URL('../../', import.meta.url));
const LIMITE_MS = 20000; // después se corta y se reinicia la shell
const ARRANQUE_MS = 30000;
const MAX_SALIDA = 100_000;
const COLA = 4096; // el marcador de fin se busca solo al final

const keyspace = process.env.CASSANDRA_KEYSPACE ?? 'streamdb';
const POSTGRES = new URL(process.env.POSTGRES_URL ?? 'postgres://streamdb:streamdb@localhost:5432/streamdb');
const MONGO_DB = new URL(process.env.MONGO_URL ?? 'mongodb://localhost:27017/streamdb').pathname.slice(1) || 'streamdb';

// psql y cqlsh esperan hasta ver el ; y el marcador quedaría adentro
const conPuntoYComa = (texto) => {
	const t = texto.trim();
	if (!t || t.endsWith(';') || /^\\/.test(t.split('\n').at(-1).trim())) return t;
	return t + ';';
};

const lineaCompleta = (marca) => new RegExp(`(^|\\n)${marca}\\n`);

const SHELLS = {
	mongo: {
		servicio: 'mongo',
		comando: `mongosh ${MONGO_DB} --quiet --norc`,
		inicio: 'prompt = ""', // sin TTY igual imprime el prompt
		marca: (n) => `print("__FIN_${n}__")`,
		fin: (b, n) => b.search(lineaCompleta(`__FIN_${n}__`)),
		preparar: (texto) => {
			if (mongoIncompleto(texto)) throw new ErroresComando('Comando incompleto: falta cerrar un paréntesis, una llave o una comilla.');
			return texto;
		},
		esError: /^(Uncaught\b|Mongo\w*Error|\w*Error\b|\w+Error:)/m,
	},
	cassandra: {
		servicio: 'cassandra',
		comando: `cqlsh -k ${keyspace}`,
		// Marcador: una sentencia inválida a propósito, el error la repite
		marca: (n) => `__FIN_${n}__;`,
		fin: (b, n) => b.search(new RegExp(`(^|\\n)<stdin>:\\d+:Invalid syntax[^\\n]*\\n<stdin>:\\d+:\\s*__FIN_${n}__;\\n<stdin>:\\d+:\\s*\\^\\n`)),
		preparar: conPuntoYComa,
		esError: /^<stdin>:\d+:/m,
		limpiar: (s) => s.replace(/^<stdin>:\d+:/gm, ''),
	},
	redis: {
		servicio: 'redis',
		comando: 'redis-cli --no-raw', // mismo formato que en una terminal
		marca: (n) => `ECHO __FIN_${n}__`,
		fin: (b, n) => b.search(lineaCompleta(`"__FIN_${n}__"`)),
		esError: /^\(error\)/m,
	},
	postgres: {
		servicio: 'postgres',
		comando: `psql -X -U ${decodeURIComponent(POSTGRES.username)} -d ${POSTGRES.pathname.slice(1)} -P pager=off`,
		marca: (n) => `\\echo __FIN_${n}__`,
		fin: (b, n) => b.search(lineaCompleta(`__FIN_${n}__`)),
		preparar: conPuntoYComa,
		esError: /^(psql:.*)?(ERROR|FATAL):/m,
		limpiar: (s) => s.replace(/^psql:<stdin>:\d+: /gm, ''),
	},
};

class ErroresComando extends Error {}

// mongosh espera más líneas si el JS quedó abierto, y el marcador quedaría adentro
export function mongoIncompleto(texto) {
	if (/^\s*(show|use|it|exit|quit|help)\b/.test(texto)) return false;
	let abiertos = 0, comilla = null;
	for (let i = 0; i < texto.length; i++) {
		const c = texto[i];
		if (comilla) {
			if (c === '\\') i++;
			else if (c === comilla) comilla = null;
			else if (c === '\n' && comilla !== '`') comilla = null; // un string común sin cerrar es error, no continuación
		} else if (c === '/' && texto[i + 1] === '/') {
			while (i < texto.length && texto[i] !== '\n') i++;
		} else if (c === '/' && texto[i + 1] === '*') {
			const cierre = texto.indexOf('*/', i + 2);
			if (cierre < 0) return true;
			i = cierre + 1;
		} else if (`'"\``.includes(c)) comilla = c;
		else if ('([{'.includes(c)) abiertos++;
		else if (')]}'.includes(c)) abiertos--;
	}
	return abiertos > 0 || comilla === '`';
}

class Shell {
	constructor(motor, def) {
		this.motor = motor;
		this.def = def;
		this.proc = null;
		this.n = 0;
		this.espera = null;
		this.cola = Promise.resolve(); // un comando a la vez
	}

	ejecutar(texto) {
		const r = this.cola.then(() => this.correr(texto));
		this.cola = r.catch(() => {});
		return r;
	}

	async correr(texto) {
		const listo = this.def.preparar ? this.def.preparar(texto) : texto;
		if (!this.proc) await this.abrir();
		const salida = await this.esperar(listo, LIMITE_MS);
		return { salida: this.def.limpiar ? this.def.limpiar(salida) : salida, error: this.def.esError.test(salida) };
	}

	async abrir() {
		const { servicio, comando } = this.def;
		const proc = spawn('docker', ['compose', 'exec', '-T', '-e', 'PYTHONUNBUFFERED=1', servicio, 'sh', '-c', `${comando} 2>&1`], { cwd: RAIZ });
		this.proc = proc;
		this.buffer = '';
		const recibir = (d) => { this.buffer += d; this.revisar(); };
		proc.stdout.setEncoding('utf8').on('data', recibir);
		proc.stderr.setEncoding('utf8').on('data', recibir); // errores de docker (ej. contenedor apagado)
		proc.stdin.on('error', () => {});
		proc.on('error', (e) => this.terminar(proc, `No se pudo ejecutar docker: ${e.message}`));
		proc.on('close', () => this.terminar(proc, `La shell de ${this.motor} se cerró.`));
		try {
			await this.esperar(this.def.inicio ?? '', ARRANQUE_MS);
		} catch (e) {
			this.cerrar();
			throw new ErroresComando(`No se pudo abrir la shell de ${this.motor}.\n${e.message}`);
		}
	}

	esperar(texto, ms) {
		return new Promise((resolve, reject) => {
			const n = ++this.n;
			this.buffer = '';
			const timer = setTimeout(() => {
				this.cerrar();
				reject(new ErroresComando(`El comando tardó más de ${ms / 1000} s y se cortó. Se reinició la shell (se pierde lo que tenía: use, variables, transacciones…).`));
			}, ms);
			this.espera = { n, resolve, reject, timer };
			this.proc.stdin.write((texto ? texto + '\n' : '') + this.def.marca(n) + '\n');
		});
	}

	revisar() {
		const e = this.espera;
		if (!e) return;
		const desde = Math.max(0, this.buffer.length - COLA);
		const i = this.def.fin(this.buffer.slice(desde), e.n);
		if (i < 0) return;
		clearTimeout(e.timer);
		this.espera = null;
		e.resolve(recortar(this.buffer.slice(0, desde + i)));
		this.buffer = '';
	}

	// La shell se cerró (\q, exit) o docker falló: el próximo comando abre otra
	terminar(proc, mensaje) {
		if (this.proc !== proc) return;
		this.proc = null;
		const e = this.espera;
		if (!e) return;
		clearTimeout(e.timer);
		this.espera = null;
		e.reject(new ErroresComando([recortar(this.buffer).trim(), mensaje].filter(Boolean).join('\n')));
	}

	cerrar() {
		const proc = this.proc;
		this.proc = null;
		proc?.kill();
		if (this.espera) {
			clearTimeout(this.espera.timer);
			this.espera = null;
		}
	}
}

const recortar = (s) => (s.length > MAX_SALIDA ? s.slice(0, MAX_SALIDA) + `\n… (salida recortada: ${s.length} caracteres)` : s);

// El driver ejecuta una sentencia por vez
export function separarSentencias(texto) {
	const sentencias = [];
	let actual = '', comilla = null;
	for (let i = 0; i < texto.length; i++) {
		const c = texto[i];
		if (comilla) {
			actual += c;
			if (c === '\\') actual += texto[++i] ?? '';
			else if (c === comilla) comilla = null;
		} else if (c === '/' && texto[i + 1] === '/') {
			while (i < texto.length && texto[i] !== '\n') i++;
			actual += '\n';
		} else if (c === ';') {
			sentencias.push(actual);
			actual = '';
		} else {
			if (c === '"' || c === "'" || c === '`') comilla = c;
			actual += c;
		}
	}
	sentencias.push(actual);
	return sentencias.map((s) => s.trim()).filter(Boolean);
}

const props = (o) => `{${Object.entries(o).map(([k, v]) => `${k}: ${valorCypher(v)}`).join(', ')}}`;
const nodo = (n) => `(${n.labels.map((l) => ':' + l).join('')}${Object.keys(n.properties).length ? ' ' + props(n.properties) : ''})`;
const relacion = (r) => `[:${r.type}${Object.keys(r.properties).length ? ' ' + props(r.properties) : ''}]`;

export function valorCypher(v) {
	if (v === null || v === undefined) return 'NULL';
	if (typeof v === 'string') return JSON.stringify(v);
	if (Array.isArray(v)) return `[${v.map(valorCypher).join(', ')}]`;
	if (isNode(v)) return nodo(v);
	if (isRelationship(v)) return relacion(v);
	if (isPath(v)) {
		return v.segments.reduce((texto, s) => {
			const ida = s.relationship.startNodeElementId === s.start.elementId;
			return texto + (ida ? `-${relacion(s.relationship)}->` : `<-${relacion(s.relationship)}-`) + nodo(s.end);
		}, nodo(v.start));
	}
	if (typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) return props(v);
	return String(v); // números, booleanos, fechas y puntos
}

export function tablaCypher(claves, filas) {
	if (!claves.length) return '';
	const celdas = filas.map((f) => claves.map((k) => valorCypher(f[k])));
	const anchos = claves.map((k, i) => Math.max(k.length, ...celdas.map((c) => c[i].length)));
	const borde = '+' + anchos.map((a) => '-'.repeat(a + 2)).join('+') + '+';
	const fila = (c) => '| ' + c.map((x, i) => x.padEnd(anchos[i])).join(' | ') + ' |';
	return [borde, fila(claves), borde, ...celdas.map(fila), ...(celdas.length ? [borde] : [])].join('\n');
}

const CONTADORES = {
	nodesCreated: 'Added %d nodes', nodesDeleted: 'Deleted %d nodes',
	relationshipsCreated: 'Created %d relationships', relationshipsDeleted: 'Deleted %d relationships',
	propertiesSet: 'Set %d properties', labelsAdded: 'Added %d labels', labelsRemoved: 'Removed %d labels',
	indexesAdded: 'Added %d indexes', indexesRemoved: 'Removed %d indexes',
	constraintsAdded: 'Added %d constraints', constraintsRemoved: 'Removed %d constraints',
};

function plan(p, nivel = 0) {
	const detalle = p.arguments?.Details ?? '';
	const perfil = p.dbHits !== undefined ? `  (filas: ${p.rows}, db hits: ${p.dbHits})` : '';
	return [`${'  '.repeat(nivel)}+${p.operatorType.replace(/@.*/, '')}${detalle ? '  ' + detalle : ''}${perfil}`,
		...p.children.flatMap((h) => plan(h, nivel + 1))];
}

async function correrCypher(texto) {
	const partes = [];
	for (const sentencia of separarSentencias(texto)) {
		if (sentencia.startsWith(':')) {
			throw new ErroresComando(`Los comandos de cypher-shell (${sentencia.split(/\s/)[0]}…) no están disponibles acá: escribí Cypher.`);
		}
		const { records, keys, summary } = await driver.executeQuery(sentencia).catch((e) => {
			throw new ErroresComando([...partes, e.message].join('\n\n'));
		});
		const filas = records.map((r) => r.toObject());
		const contadores = Object.entries(summary.counters.updates())
			.filter(([k, n]) => n > 0 && CONTADORES[k])
			.map(([k, n]) => CONTADORES[k].replace('%d', n));
		const salida = keys.length ? [tablaCypher(keys, filas), ''] : [];
		salida.push(
			`${filas.length} row${filas.length === 1 ? '' : 's'}`,
			`ready to start consuming query after ${summary.resultAvailableAfter} ms, results consumed after another ${summary.resultConsumedAfter} ms`,
		);
		if (contadores.length) salida.push(contadores.join(', '));
		const p = summary.profile || summary.plan; // EXPLAIN / PROFILE
		if (p) salida.push('', ...plan(p));
		partes.push(salida.join('\n'));
	}
	return { salida: partes.join('\n\n'), error: false };
}

const shells = Object.fromEntries(Object.entries(SHELLS).map(([m, def]) => [m, new Shell(m, def)]));
const MOTORES = ['mongo', 'cassandra', 'neo4j', 'redis', 'postgres'];

process.on('exit', () => Object.values(shells).forEach((s) => s.cerrar()));

const router = Router();

// Ejecuta cualquier comando: solo desde la misma máquina
router.use((req, res, next) => {
	const ip = req.socket.remoteAddress ?? '';
	if (['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip)) return next();
	next(new ErroresApp('La consola solo se puede usar desde la máquina donde corre el servidor', 403));
});

router.param('motor', (req, res, next, motor) => {
	next(MOTORES.includes(motor) ? undefined : pedidoInvalido(`Motor desconocido: ${motor}`));
});

router.post('/:motor', async (req, res) => {
	const { motor } = req.params;
	const comando = String(req.body?.comando ?? '');
	if (!comando.trim()) throw pedidoInvalido('Falta el comando');
	const inicio = performance.now();
	let salida, error;
	try {
		({ salida, error } = motor === 'neo4j' ? await sinTraza(() => correrCypher(comando)) : await shells[motor].ejecutar(comando));
	} catch (e) {
		if (!(e instanceof ErroresComando)) throw e;
		salida = e.message;
		error = true;
	}
	const ms = Math.round(performance.now() - inicio);
	res.json({ salida: salida.replace(/^\n+|\s+$/g, ''), error, ms });
});

router.post('/:motor/reiniciar', (req, res) => {
	shells[req.params.motor]?.cerrar();
	res.json({ ok: true });
});

export default router;
