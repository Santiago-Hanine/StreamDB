// Pruebas de las rutas de la app de demo (/app y /demo/api/app/*).
// Corren contra el servidor levantado (npm run dev) y con los datos del seed.
import 'dotenv/config';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const base = `http://localhost:${process.env.PORT}`;
const get = async (ruta) => {
	const r = await fetch(base + ruta);
	assert.equal(r.status, 200, `${ruta} respondió ${r.status}`);
	return r.json();
};

test('motores: los cinco conectados', async () => {
	const r = await get('/demo/api/app/motores');
	assert.deepEqual(r, { mongo: true, neo4j: true, cassandra: true, redis: true, postgres: true });
});

test('cuentas: la demo va primero y tiene sus tres perfiles', async () => {
	const { cuentas } = await get('/demo/api/app/cuentas');
	assert.equal(cuentas[0].email, 'demo@streamdb.test');
	assert.deepEqual(cuentas[0].perfiles.map((p) => p.nombre), ['Titular', 'Adolescente', 'Niños']);
	assert.equal(cuentas.length, 5);
});

test('cuentas: busca por email', async () => {
	const { cuentas } = await get('/demo/api/app/cuentas?email=DEMO@');
	assert.equal(cuentas[0].email, 'demo@streamdb.test');
});

test('cuentas: un email con caracteres de regex no rompe', async () => {
	const { cuentas } = await get('/demo/api/app/cuentas?email=' + encodeURIComponent('.*('));
	assert.deepEqual(cuentas, []);
});

test('dispositivos: uno por tipo', async () => {
	const { dispositivos } = await get('/demo/api/app/dispositivos');
	assert.deepEqual(dispositivos.map((d) => d.tipo).sort(), ['consola', 'movil', 'tablet', 'tv', 'web']);
});

test('licencias: la serie demo primero, con licencia vigente', async () => {
	const { contenidos } = await get('/demo/api/app/licencias');
	assert.equal(contenidos[0].titulo, 'El faro del norte');
	assert.ok(contenidos[0].licencias.some((l) => l.estado === 'vigente'));
});

test('catalogo: 20 géneros y plataformas', async () => {
	const c = await get('/demo/api/app/catalogo');
	assert.equal(c.generos.length, 20);
	assert.ok(c.plataformas.length > 0 && c.actores.length === 12);
});

test('las consultas de la app no se registran en una traza', async () => {
	const r = await fetch(base + '/demo/api/app/cuentas', { headers: { 'x-traza': '1' } });
	const t = await get('/demo/api/trazas/' + r.headers.get('x-traza'));
	assert.deepEqual(t.ops, []);
});

test('la app se sirve en /app', async () => {
	const r = await fetch(base + '/app/');
	assert.equal(r.status, 200);
	assert.match(await r.text(), /<aside id="motores"/);
});

test('contenido: ficha de la serie demo con temporadas y duraciones', async () => {
	const { cuentas } = await get('/demo/api/app/cuentas');
	const { contenidos } = await get('/demo/api/app/licencias');
	const c = await get('/demo/api/app/contenidos/' + contenidos[0].id);
	assert.equal(c.titulo, 'El faro del norte');
	assert.equal(c.clasificacionEdad, 16);
	assert.equal(c.temporadas.length, 3);
	assert.ok(c.temporadas[0].episodios[0].duracionSeg > 0);
	assert.ok(cuentas.length);
});

test('contenido: id inválido responde 400', async () => {
	const r = await fetch(base + '/demo/api/app/contenidos/no-es-un-id');
	assert.equal(r.status, 400);
});

// ─── Frases de la columna de motores (lógica pura del frontend) ───────────────

const { frase } = await import('../demo/app/js/motores.js');
const op = (motor, op, detalle = '') => ({ motor, op, detalle });

test('frase: P2 reserva el cupo en Redis', () => {
	assert.equal(frase('redis', [op('redis', 'EVAL')], { idSesion: 'x', sesionReutilizada: false }), 'Reservó un lugar en el cupo de pantallas');
});
test('frase: P2 reutiliza la sesión del dispositivo', () => {
	assert.equal(frase('redis', [op('redis', 'EVAL')], { idSesion: 'x', sesionReutilizada: true }), 'Reutilizó la sesión de este dispositivo');
});
test('frase: P3 guarda el segundo exacto', () => {
	assert.equal(frase('redis', [op('redis', 'EVAL')], { checkpoint: 'no_corresponde' }), 'Guardó el segundo exacto (continuar viendo)');
});
test('frase: Cassandra escribe en el historial', () => {
	assert.equal(frase('cassandra', [op('cassandra', 'INSERT')], {}), 'Escribió en el historial');
});
test('frase: Neo4j registra la señal VIO', () => {
	assert.equal(frase('neo4j', [op('neo4j', 'MERGE', 'MERGE (p)-[r:VIO {idVisualizacion: $id}]->(c)')], {}), 'Registró la señal VIO (para recomendar)');
});
test('frase: Neo4j recorre el grafo', () => {
	assert.equal(frase('neo4j', [op('neo4j', 'MATCH')], {}), 'Recorrió el grafo (vínculos, elenco, géneros)');
});
test('frase: Postgres cambia licencias', () => {
	assert.equal(frase('postgres', [op('postgres', 'SELECT'), op('postgres', 'UPDATE')], {}), 'Cambió el estado de licencias');
});
test('frase: Mongo actualiza el catálogo', () => {
	assert.equal(frase('mongo', [op('mongo', 'update', 'contenidos · filtro {}')], {}), 'Actualizó el catálogo');
});
