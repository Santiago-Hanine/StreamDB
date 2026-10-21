// Pruebas de la app de demo. Necesitan el servidor levantado (npm run dev) y el seed cargado.
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

test('altas: lista las series cargadas desde la demo (prefijo del título)', async () => {
	const { series } = await get('/demo/api/app/altas');
	assert.ok(Array.isArray(series));
	for (const x of series) assert.match(x.titulo, /^Demo P1 · /);
});

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
test('frase: P8 borra el continuar viendo en Redis', () => {
	assert.equal(frase('redis', [op('redis', 'EVAL')], { estado: 'retirado' }), 'Borró el "continuar viendo" de todos los perfiles y marcó el retiro');
});
test('frase: P4 de una película quita el continuar viendo', () => {
	assert.equal(frase('redis', [op('redis', 'EVAL')], { finalizado: 'x', siguiente: null }), 'Lo quitó de "continuar viendo" (no hay siguiente)');
});
test('frase: Cassandra registra el cierre de una sesión', () => {
	assert.equal(frase('cassandra', [op('cassandra', 'INSERT', 'INSERT INTO sesiones_por_cuenta (id_cuenta) VALUES (?)')], {}), 'Registró el cierre de la sesión');
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

const { unidad } = await import('../demo/app/js/player.js');
const serie = {
	tipo: 'serie', titulo: 'S',
	temporadas: [{ numero: 2, episodios: [{ id: 'e3', numero: 1, titulo: 'Uno', duracionSeg: 100 }] },
		{ numero: 1, episodios: [{ id: 'e1', numero: 1, titulo: 'Piloto', duracionSeg: 2700 }, { id: 'e2', numero: 2, titulo: 'Dos', duracionSeg: 2580 }] }],
};

test('unidad: episodio de una serie con su duración', () => {
	assert.deepEqual(unidad(serie, 'e2'), { texto: 'T1 · E2 · Dos', duracionSeg: 2580 });
});
test('unidad: película usa la duración de la ficha', () => {
	assert.deepEqual(unidad({ tipo: 'pelicula', duracionSeg: 6000 }, 'x'), { texto: 'Película', duracionSeg: 6000 });
});
test('unidad: episodio desconocido usa 45 minutos', () => {
	assert.deepEqual(unidad(serie, 'zz'), { texto: 'Episodio', duracionSeg: 2700 });
});

const { rangoMeses } = await import('../demo/app/js/usuario.js');

test('rangoMeses: tres meses hasta el actual', () => {
	assert.deepEqual(rangoMeses(new Date('2026-10-19T12:00:00Z'), 3), { desde: '2026-08', hasta: '2026-10' });
});
test('rangoMeses: cruza el año', () => {
	assert.deepEqual(rangoMeses(new Date('2026-02-10T12:00:00Z'), 3), { desde: '2025-12', hasta: '2026-02' });
});

const { cuerpoAlta } = await import('../demo/app/js/admin.js');
const formP1 = {
	titulo: 'Mi serie', episodios: ['Piloto', 'La tormenta'],
	generos: ['Drama', 'Suspenso'], idPlataforma: 'p1', clasificacionEdad: '16', anioEstreno: '2025',
	actores: ['a1', 'a2'], vinculo: { idContenido: 's1', tipo: 'mismo_universo' },
};
const prefijo = { prefijoAlta: 'Demo P1 · ' };

test('cuerpoAlta: usa lo elegido en el formulario', () => {
	const c = cuerpoAlta(prefijo, formP1);
	assert.equal(c.titulo, 'Demo P1 · Mi serie');
	assert.deepEqual(c.generos, ['Drama', 'Suspenso']);
	assert.equal(c.idPlataforma, 'p1');
	assert.equal(c.clasificacionEdad, 16);
	assert.equal(c.anioEstreno, 2025);
	assert.deepEqual(c.elenco, [{ idActor: 'a1', personaje: 'Protagonista' }, { idActor: 'a2', personaje: 'Reparto' }]);
	assert.deepEqual(c.vinculos, [{ idContenido: 's1', tipo: 'mismo_universo' }]);
	assert.deepEqual(c.temporadas, [{ numero: 1, episodios: [{ titulo: 'Piloto', duracionSeg: 2700 }, { titulo: 'La tormenta', duracionSeg: 2700 }] }]);
});
test('cuerpoAlta: sin vínculo, no duplica el prefijo y descarta episodios vacíos', () => {
	const c = cuerpoAlta(prefijo, { ...formP1, titulo: 'Demo P1 · Otra', episodios: ['Uno', '  ', ''], vinculo: null });
	assert.equal(c.titulo, 'Demo P1 · Otra');
	assert.deepEqual(c.vinculos, []);
	assert.equal(c.temporadas[0].episodios.length, 1);
});

const player = await import('../demo/app/js/player.js');
const api = await import('../demo/app/js/api.js');
const router = await import('../demo/app/js/router.js');
const { conLimite } = await import('../lib/limite.js');

test('player: otro dispositivo no cierra la sesión anterior (así se llena el cupo en una pestaña)', () => {
	assert.equal(player.cerrarAnteriorAlAbrir({ idDispositivo: 'tv' }, 'movil'), false);
	assert.equal(player.cerrarAnteriorAlAbrir({ idDispositivo: 'tv' }, 'tv'), true);
});

test('player: con la sesión expirada o terminada no se puede seguir ni saltar al final', () => {
	assert.deepEqual(player.controles({ expirada: true }), { pausa: false, final: false });
	assert.deepEqual(player.controles({ terminado: true }), { pausa: false, final: false });
	assert.deepEqual(player.controles({}), { pausa: true, final: true });
});

test('falla armada: solo se gasta si la saga falló en ese paso', () => {
	const saga = (estado) => ({ traza: { saga: { pasos: [{ nombre: 'retirar_ficha', estado }] } } });
	assert.equal(api.fallaConsumida(saga('fallido'), 'retirar_ficha'), true);
	assert.equal(api.fallaConsumida(saga('pendiente'), 'retirar_ficha'), false);
	assert.equal(api.fallaConsumida({ status: 409, traza: { saga: null } }, 'retirar_ficha'), false);
});

test('router: un render viejo deja de ser vigente cuando empieza otro', () => {
	const primero = router.nuevoTurno();
	assert.equal(primero(), true);
	const segundo = router.nuevoTurno();
	assert.equal(primero(), false);
	assert.equal(segundo(), true);
});

test('conLimite: devuelve el valor o falla si tarda demasiado', async () => {
	assert.equal(await conLimite(Promise.resolve(7), 50), 7);
	await assert.rejects(conLimite(new Promise(() => {}), 50), /tardó más de 50 ms/);
});

const consola = async (motor, comando) => {
	const r = await fetch(`${base}/demo/api/consola/${motor}`, {
		method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ comando }),
	});
	assert.equal(r.status, 200, `${motor} respondió ${r.status}`);
	return r.json();
};

test('consola: mongosh con sus comandos propios y estado entre comandos', async () => {
	assert.match((await consola('mongo', 'show collections')).salida, /contenidos/);
	assert.equal((await consola('mongo', 'const n = db.contenidos.countDocuments()')).error, false);
	assert.ok(Number((await consola('mongo', 'n')).salida) > 0);
	const mal = await consola('mongo', 'db.nada.foo()');
	assert.ok(mal.error && /TypeError/.test(mal.salida));
});

test('consola: mongo avisa al instante si el comando está incompleto', async () => {
	const r = await consola('mongo', 'db.contenidos.find({ tipo: "serie"');
	assert.ok(r.error && /incompleto/.test(r.salida));
	assert.equal((await consola('mongo', 'db.getName()')).salida, 'streamdb');
});

test('consola: cqlsh con DESCRIBE y errores marcados', async () => {
	assert.match((await consola('cassandra', 'DESCRIBE TABLES')).salida, /sesiones_por_cuenta/);
	const mal = await consola('cassandra', 'SELECT * FROM no_existe');
	assert.ok(mal.error && /no_existe does not exist/.test(mal.salida) && !/<stdin>/.test(mal.salida));
});

test('consola: Neo4j con el formato de cypher-shell y varias sentencias', async () => {
	const r = await consola('neo4j', 'MATCH (g:Genero) RETURN g ORDER BY g.nombre LIMIT 1; RETURN 1 AS uno');
	assert.match(r.salida, /\| \(:Genero \{nombre: ".+"\}\) +\|/);
	assert.match(r.salida, /\| uno \|\n\+-----\+\n\| 1 {3}\|/);
	assert.ok((await consola('neo4j', ':param x => 1')).error);
});

test('consola: redis-cli y psql con su formato', async () => {
	assert.match((await consola('redis', 'DBSIZE')).salida, /^\(integer\) \d+$/);
	assert.ok((await consola('redis', 'NOEXISTE')).error);
	assert.match((await consola('postgres', '\\dt')).salida, /licencia/);
	assert.match((await consola('postgres', 'select 1 as uno')).salida, /uno\s*\n-+\n\s+1\n\(1 row\)/);
	assert.ok((await consola('postgres', 'select nada')).error);
});

test('consola: motor desconocido responde 400', async () => {
	const r = await fetch(`${base}/demo/api/consola/oracle`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"comando":"x"}' });
	assert.equal(r.status, 400);
});

const { resaltar } = await import('../demo/app/js/resaltado.js');
const { nuevoPrompt } = await import('../demo/app/js/consola.js');

test('resaltar: palabras clave, strings y números de cada lenguaje', () => {
	assert.equal(resaltar('postgres', "select 'a' -- x"), '<span class="t-kw">select</span> <span class="t-str">&#39;a&#39;</span> <span class="t-com">-- x</span>');
	assert.equal(resaltar('postgres', '\\dt'), '<span class="t-kw">\\dt</span>');
	assert.equal(resaltar('neo4j', 'MATCH (g:Genero)'), '<span class="t-kw">MATCH</span> (g<span class="t-etq">:Genero</span>)');
	assert.equal(resaltar('mongo', 'db.x.find({ $gt: 3 })'),
		'<span class="t-var">db</span>.x.<span class="t-fn">find</span>({ <span class="t-var">$gt</span>: <span class="t-num">3</span> })');
	assert.equal(resaltar('redis', 'SET k "v w"'), '<span class="t-kw">SET</span> k <span class="t-str">&quot;v w&quot;</span>');
	assert.equal(resaltar('cassandra', 'SELECT x1 FROM t'), '<span class="t-kw">SELECT</span> x1 <span class="t-kw">FROM</span> t');
});

test('nuevoPrompt: cambia con use en Mongo y en Cassandra', () => {
	assert.equal(nuevoPrompt('mongo', 'use admin', { salida: 'switched to db admin', error: false }), 'admin>');
	assert.equal(nuevoPrompt('cassandra', 'USE system;', { salida: '', error: false }), 'cqlsh:system>');
	assert.equal(nuevoPrompt('cassandra', 'USE nada;', { salida: 'x', error: true }), null);
	assert.equal(nuevoPrompt('postgres', 'select 1', { salida: '', error: false }), null);
});
