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
