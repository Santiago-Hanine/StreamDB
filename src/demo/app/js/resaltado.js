// Colores de sintaxis de la consola, un tokenizador simple por lenguaje.
import { esc } from './util.js';

const palabras = (s) => new Set(s.split(/\s+/));

const SQL = 'SELECT FROM WHERE AND OR NOT IN IS NULL AS ON JOIN LEFT RIGHT INNER OUTER FULL CROSS GROUP BY ORDER HAVING LIMIT OFFSET ' +
	'INSERT INTO VALUES UPDATE SET DELETE CREATE TABLE DROP ALTER ADD COLUMN INDEX PRIMARY KEY FOREIGN REFERENCES DISTINCT CASE WHEN ' +
	'THEN ELSE END BEGIN COMMIT ROLLBACK RETURNING WITH UNION ALL EXISTS BETWEEN LIKE ILIKE ASC DESC TRUE FALSE EXPLAIN ANALYZE VIEW ' +
	'IF CONSTRAINT UNIQUE CHECK DEFAULT TRANSACTION ISOLATION LEVEL SERIALIZABLE READ COMMITTED FOR SHARE ANY TRUNCATE GRANT TYPE';

const LENGUAJES = {
	postgres: { claves: palabras(SQL), mayusculas: true, comentario: /--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/y, comillasId: '"', meta: true },
	cassandra: {
		claves: palabras(SQL + ' KEYSPACE KEYSPACES TABLES USE DESCRIBE TTL USING TIMESTAMP ALLOW FILTERING CONSISTENCY TRACING OFF ' +
			'BATCH APPLY TOKEN WRITETIME CLUSTERING PARTITION REPLICATION DURABLE_WRITES MATERIALIZED STATIC FROZEN LIST MAP SHOW VERSION HOST PAGING EXPAND'),
		mayusculas: true, comentario: /--[^\n]*|\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/y, comillasId: '"',
	},
	neo4j: {
		claves: palabras('MATCH OPTIONAL WHERE RETURN WITH CREATE MERGE DELETE DETACH SET REMOVE UNWIND ORDER BY SKIP LIMIT AS AND OR NOT ' +
			'XOR IN IS NULL TRUE FALSE DISTINCT CASE WHEN THEN ELSE END ON EXISTS CALL YIELD UNION ALL EXPLAIN PROFILE CONTAINS STARTS ENDS ' +
			'INDEX CONSTRAINT FOR REQUIRE SHOW DROP ASC DESC ASCENDING DESCENDING FOREACH LOAD CSV HEADERS FROM'),
		mayusculas: true, comentario: /\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/y, comillasId: '`', etiquetas: true,
	},
	mongo: {
		claves: palabras('const let var function return await async new true false null undefined if else for of in typeof this show use it'),
		comentario: /\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/y,
	},
	redis: { comando: true },
};

const STRING = /'(?:[^'\\\n]|\\.)*'?|"(?:[^"\\\n]|\\.)*"?|`(?:[^`\\]|\\.)*`?/y;
const NUMERO = /-?\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b/iy;
const PALABRA = /[A-Za-z_$][\w$]*/y;
const ETIQUETA = /:\s*`?[A-Za-z_][\w]*`?/y; // :Label en Cypher
const META = /\\[^\s]+/y; // \dt de psql

const pintar = (clase, texto) => `<span class="t-${clase}">${esc(texto)}</span>`;

function tomar(re, texto, i) {
	re.lastIndex = i;
	const m = re.exec(texto);
	return m && m[0] ? m[0] : null;
}

export function resaltar(motor, texto) {
	const l = LENGUAJES[motor];
	if (!l) return esc(texto);
	let html = '', i = 0, inicioLinea = true;
	while (i < texto.length) {
		const c = texto[i];
		let t;
		if (c === '\n' || c === ' ' || c === '\t') {
			html += c;
			if (c === '\n') inicioLinea = true;
			i++;
			continue;
		}
		if (l.comentario && (t = tomar(l.comentario, texto, i))) html += pintar('com', t);
		else if (l.meta && inicioLinea && c === '\\' && (t = tomar(META, texto, i))) html += pintar('kw', t);
		else if ('\'"`'.includes(c) && (t = tomar(STRING, texto, i))) html += pintar(c === l.comillasId ? 'id' : 'str', t);
		else if (l.etiquetas && c === ':' && (t = tomar(ETIQUETA, texto, i))) html += pintar('etq', t);
		else if ((t = tomar(NUMERO, texto, i)) && !/[\w$]/.test(texto[i - 1] ?? '')) html += pintar('num', t);
		else if ((t = tomar(PALABRA, texto, i))) html += pintarPalabra(l, t, texto[i + t.length], inicioLinea);
		else {
			t = c;
			html += esc(c);
		}
		i += t.length;
		inicioLinea = false;
	}
	return html;
}

function pintarPalabra(l, palabra, siguiente, inicioLinea) {
	if (l.comando) return inicioLinea ? pintar('kw', palabra) : esc(palabra); // Redis: solo el comando
	if (palabra.startsWith('$')) return pintar('var', palabra);
	if (l.claves.has(l.mayusculas ? palabra.toUpperCase() : palabra)) return pintar('kw', palabra);
	if (siguiente === '(') return pintar('fn', palabra);
	if (palabra === 'db') return pintar('var', palabra);
	return esc(palabra);
}
