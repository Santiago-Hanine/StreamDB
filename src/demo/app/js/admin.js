// Consola admin: alta de serie (P1), licencias y retiro (P8), sesiones activas (P6), fallas y reinicio.
import { registrar, ir } from './router.js';
import { pedir, leer, armarFalla, fallaArmada } from './api.js';
import { PASOS } from './motores.js';
import { esc, pildora, corto, MOTORES, aviso, abrirModal } from './util.js';

const API = '/api/v1';
const DURACION_EPISODIO = 2700;
const FECHA_SEED = '2026-10-17'; // "hoy" del seed: las licencias vencidas a esta fecha son las de P8
const REFRESCO_SESIONES_MS = 5000;

let refresco = null; // setInterval de la pestaña de sesiones activas

let demo = null;
const datosDemo = async () => (demo ??= await leer('/demo/api/datos'));

// Cuerpo del alta (P1): segunda temporada inventada de la serie demo, con sus géneros, plataforma y elenco
export function cuerpoAlta(d, { titulo, episodios }) {
	const limpio = titulo.trim().startsWith(d.prefijoAlta) ? titulo.trim() : d.prefijoAlta + titulo.trim();
	return {
		titulo: limpio,
		clasificacionEdad: 13,
		anioEstreno: 2026,
		generos: d.serie.generos.slice(0, 2),
		idPlataforma: d.serie.idPlataforma,
		elenco: d.serie.elenco.map((a, i) => ({ idActor: a.idActor, personaje: i ? 'Antagonista' : 'Protagonista' })),
		vinculos: [{ idContenido: d.serie.id, tipo: 'secuela' }],
		temporadas: [{ numero: 1, episodios: episodios.map((e) => e.trim()).filter(Boolean).map((t) => ({ titulo: t, duracionSeg: DURACION_EPISODIO })) }],
	};
}

// Listeners globales del admin (fuera del import, así el módulo también se puede importar en las pruebas)
export function iniciar() {
	// "Reiniciar demo" está en la barra admin (la pinta el router)
	document.addEventListener('click', async (e) => {
		if (!e.target.closest('#reiniciar')) return;
		const r = await leer('/demo/api/reiniciar', { method: 'POST' }).catch((err) => ({ error: err.message }));
		if (r.error) return aviso(r.error, 'error');
		armarFalla(null);
		aviso(`Demo reiniciada: ${r.sesionesCerradas} sesiones cerradas, ${r.retirosDeshechos} retiros deshechos, ${r.seriesBorradas} series borradas`);
		ir(location.hash.slice(2));
	});
	// El refresco de sesiones activas se corta al salir de esa pestaña
	window.addEventListener('hashchange', () => { clearInterval(refresco); refresco = null; });
}

const encabezado = (titulo, motores, texto) => `<div class="panel" style="background:none;border:0;padding:0">
	<h1>${titulo}</h1><p class="suave">${motores.map(pildora).join(' ')} ${texto}</p></div>`;

// ─── Catálogo (P1) ────────────────────────────────────────────────────────────

registrar('admin/catalogo', async (vista) => {
	const d = await datosDemo();
	vista.innerHTML = `${encabezado('Catálogo', ['mongo', 'neo4j'], 'Dar de alta una serie es una saga: la ficha y los episodios en MongoDB, el nodo, el elenco y los vínculos en Neo4j, y al final se publica. Si un paso falla, se deshace lo anterior en orden inverso.')}
		<div class="panel"><h2>Nueva serie</h2>
			<div class="formulario">
				<label for="titulo">Título</label><input type="text" id="titulo" value="${esc(new Date().toLocaleTimeString('es-AR'))} · El regreso del faro">
				<label>Se copia de</label><span class="suave">«${esc(d.serie.titulo)}»: géneros ${esc(d.serie.generos.slice(0, 2).join(', '))}, plataforma ${esc(d.serie.plataforma)},
					elenco ${esc(d.serie.elenco.map((a) => a.nombre).join(' y '))}. Queda vinculada como su <b>secuela</b>.</span>
				<label for="episodios">Episodios (uno por línea)</label><textarea id="episodios" rows="3" class="campo" style="background:var(--superficie-2);border:1px solid var(--borde);border-radius:6px;padding:8px;color:inherit">Piloto\nLa tormenta</textarea>
			</div>
			<p class="suave">El título lleva el prefijo «${esc(d.prefijoAlta)}» para que «Reiniciar demo» la borre.</p>
			<button class="boton rojo" id="cargar">Cargar serie</button>
		</div>
		<div class="panel"><h2>Series cargadas desde la demo</h2><div id="cargadas"><p class="vacio">Cargando…</p></div></div>`;

	const listar = async () => {
		// P7 por la plataforma y el género de la serie demo: ahí aparecen las publicadas
		const r = await leer(`${API}/contenidos?idPlataforma=${d.serie.idPlataforma}&genero=${encodeURIComponent(d.serie.generos[0])}&limite=50`).catch(() => null);
		const altas = (r?.contenidos ?? []).filter((c) => c.titulo.startsWith(d.prefijoAlta));
		vista.querySelector('#cargadas').innerHTML = altas.length
			? `<table class="tabla">${altas.map((c) => `<tr><td><b>${esc(c.titulo)}</b></td><td class="suave">${c.cantidadEpisodios} episodios</td>
				<td class="suave">${esc(c.vinculados.map((v) => `${v.relacion} de ${v.titulo}`).join(', '))}</td></tr>`).join('')}</table>`
			: '<p class="vacio">Todavía no se cargó ninguna (o la última falló y se deshizo).</p>';
	};
	vista.querySelector('#cargar').onclick = async (e) => {
		e.target.disabled = true;
		const body = cuerpoAlta(d, { titulo: vista.querySelector('#titulo').value, episodios: vista.querySelector('#episodios').value.split('\n') });
		const r = await pedir({ metodo: 'POST', ruta: `${API}/contenidos/series`, body, accion: 'Alta de serie', pasos: Object.keys(PASOS.P1) });
		e.target.disabled = false;
		if (r.status === 201) aviso(`Serie publicada: ${body.titulo}`);
		vista.querySelector('#titulo').value = `${new Date().toLocaleTimeString('es-AR')} · El regreso del faro`;
		await listar();
	};
	await listar();
}, 'admin');

// ─── Licencias (P8) ───────────────────────────────────────────────────────────

const filaContenido = (c) => `<div class="panel" data-id="${c.id}">
	<h2>${esc(c.titulo)} <span class="suave" style="font-size:13px;font-weight:400">· ${esc(c.estado)}</span></h2>
	<table class="tabla"><tr><th>Región</th><th>Desde</th><th>Hasta</th><th>Estado</th></tr>
	${c.licencias.map((l) => `<tr><td>${esc(l.region)}</td><td>${esc(l.desde)}</td><td>${esc(l.hasta)}</td>
		<td><span class="estado-lic ${esc(l.estado)}">${esc(l.estado)}</span></td></tr>`).join('') || '<tr><td colspan="4" class="vacio">Sin licencias</td></tr>'}</table>
	<div style="display:flex;gap:10px;margin-top:12px;flex-wrap:wrap">
		${c.estado === 'retirado'
			? '<button class="boton" data-accion="republicar">Volver a publicar</button>'
			: '<button class="boton rojo" data-accion="retirar">Retirar del catálogo</button>'}
		<button class="boton" data-accion="trazabilidad">Trazabilidad</button>
	</div></div>`;

registrar('admin/licencias', async (vista) => {
	vista.innerHTML = `${encabezado('Licencias', ['postgres', 'redis', 'neo4j', 'mongo'], 'Las licencias viven en PostgreSQL (una restricción impide que se superpongan). Retirar un contenido borra su "continuar viendo" en Redis, lo marca en Neo4j y Mongo, y vence las licencias al final.')}
		<div class="panel"><h2>Fecha de referencia</h2>
			<p class="suave">Simula "hoy" para los retiros: no se puede retirar algo con una licencia vigente a esta fecha (lo verifica PostgreSQL).
			«Procesar vencimientos» busca los contenidos sin ninguna licencia vigente a esa fecha y los retira, una saga por contenido.</p>
			<div class="filtros"><input type="date" id="fecha" value="${FECHA_SEED}"><button class="boton rojo" id="procesar">Procesar vencimientos</button></div></div>
		<div class="filtros"><input type="search" id="buscar" placeholder="Buscar contenido por título…" style="flex:1"></div>
		<div id="lista"><p class="vacio">Cargando…</p></div>`;
	const lista = vista.querySelector('#lista');
	let contenidos = [];
	const mostrar = async (q = '') => {
		try {
			({ contenidos } = await leer('/demo/api/app/licencias' + (q ? `?q=${encodeURIComponent(q)}` : '')));
			lista.innerHTML = contenidos.map(filaContenido).join('') || '<p class="vacio">Nada con ese título.</p>';
		} catch (e) {
			lista.innerHTML = `<p class="error-texto">${esc(e.message)}</p>`;
		}
	};
	let espera;
	vista.querySelector('#buscar').oninput = (e) => { clearTimeout(espera); espera = setTimeout(() => mostrar(e.target.value.trim()), 300); };
	vista.querySelector('#procesar').onclick = async () => {
		const fecha = vista.querySelector('#fecha').value;
		const r = await pedir({ metodo: 'POST', ruta: `${API}/licencias/procesar-vencimientos?fecha=${fecha}`, accion: `Procesar vencimientos al ${fecha}`, pasos: Object.keys(PASOS.P8) });
		if (r.status === 200) aviso(`Revisados ${r.cuerpo.revisados}: ${r.cuerpo.retirados.length} retirados${r.cuerpo.errores.length ? `, ${r.cuerpo.errores.length} con error` : ''}`);
		await mostrar(vista.querySelector('#buscar').value.trim());
	};
	lista.onclick = async (e) => {
		const b = e.target.closest('[data-accion]');
		if (!b) return;
		const c = contenidos.find((x) => x.id === b.closest('[data-id]').dataset.id);
		if (b.dataset.accion === 'retirar') {
			const fecha = vista.querySelector('#fecha').value;
			const r = await pedir({ metodo: 'POST', ruta: `${API}/contenidos/${c.id}/retiro`, body: { fecha }, accion: `Retirar «${c.titulo}» al ${fecha}`, pasos: Object.keys(PASOS.P8) });
			const vigentes = c.licencias.filter((l) => l.estado === 'vigente').map((l) => l.hasta).sort();
			if (r.status === 409 && vigentes.length) aviso(`Tiene licencia vigente hasta el ${vigentes.at(-1)}: poné una fecha de referencia posterior para retirarlo`, 'error');
		} else if (b.dataset.accion === 'republicar') {
			await leer(`/demo/api/republicar/${c.id}`, { method: 'POST' }).catch((err) => aviso(err.message, 'error'));
			aviso(`«${c.titulo}» volvió a publicarse`);
		} else {
			return trazabilidad(c);
		}
		await mostrar(vista.querySelector('#buscar').value.trim());
	};
	await mostrar();
}, 'admin');

async function trazabilidad(c) {
	const r = await pedir({ ruta: `${API}/contenidos/${c.id}/trazabilidad?limite=5`, accion: `Trazabilidad de «${c.titulo}»` });
	if (r.status !== 200) return aviso(r.cuerpo?.error ?? 'Error', 'error');
	const t = r.cuerpo;
	const seccion = (motor, titulo, html, dato) => `<h3 style="margin-top:16px">${pildora(motor)} ${titulo}</h3>${dato?.error ? `<p class="error-texto">${esc(dato.error)}</p>` : html}`;
	abrirModal(`<h2>Trazabilidad · ${esc(c.titulo)}</h2>
		<p class="suave">Una sola consulta, cinco motores en paralelo, todos con el mismo id.</p>
		${seccion('mongo', 'Ficha', `<p>${esc(t.ficha.tipo)} · ${esc(t.ficha.estado)}${t.ficha.retiro ? ` · retirado el ${esc(String(t.ficha.retiro.fecha).slice(0, 10))}` : ''} · ${t.ficha.episodios ?? '—'} episodios</p>`, t.ficha)}
		${seccion('neo4j', 'Grafo', `<p>${esc(JSON.stringify(Object.fromEntries(Object.entries(t.vinculos).filter(([k]) => k !== 'origen'))))}</p>`, t.vinculos)}
		${seccion('redis', 'Viendo ahora', `<p>${t.viendoAhora.perfiles ?? 0} perfiles · ${t.viendoAhora.sesiones ?? 0} sesiones</p>`, t.viendoAhora)}
		${seccion('cassandra', 'Historial', `<p>${t.historial.total} visualizaciones en total (se conserva aunque se retire)</p>`, t.historial)}
		${seccion('postgres', 'Licencias', `<p>${(t.licencias.licencias ?? []).map((l) => `${esc(l.region)} ${esc(l.estado)} hasta ${esc(l.hasta)}`).join(' · ') || 'sin licencias'}</p>`, t.licencias)}`);
}

// ─── Sesiones activas (P6) ────────────────────────────────────────────────────


registrar('admin/sesiones', async (vista) => {
	const [{ cuentas }, { dispositivos }] = await Promise.all([leer('/demo/api/app/cuentas'), leer('/demo/api/app/dispositivos')]);
	vista.innerHTML = `${encabezado('Sesiones activas', ['redis', 'cassandra'], 'Las sesiones activas y el cupo viven en Redis con vencimiento (120 s sin reportes). Al cerrarse, por expiración, en forma remota o manual, el cierre queda registrado en Cassandra.')}
		<div class="filtros"><select class="campo" id="cuenta">${cuentas.map((c) => `<option value="${c.id}">${esc(c.email)}</option>`).join('')}</select>
			<button class="boton rojo" id="cerrar-todas">Cerrar todas (remoto)</button></div>
		<div class="panel"><h2>Activas ${pildora('redis')} <span class="suave" id="cupo" style="font-size:13px;font-weight:400"></span></h2><div id="activas"></div></div>
		<div class="panel"><h2>Cerradas ${pildora('cassandra')}</h2><div id="historial"></div></div>`;
	const cuenta = () => cuentas.find((c) => c.id === vista.querySelector('#cuenta').value);
	const perfil = (id) => cuenta().perfiles.find((p) => p.id === id)?.nombre ?? corto(id);
	const disp = (id) => dispositivos.find((x) => x.id === id)?.modelo ?? corto(id);

	const mostrar = async () => {
		const s = await leer(`${API}/cuentas/${cuenta().id}/sesiones`).catch(() => null);
		if (!s) { vista.querySelector('#activas').innerHTML = '<p class="error-texto">No se pudieron leer las sesiones</p>'; return; }
		vista.querySelector('#cupo').textContent = `${s.activas.length} de ${s.limiteSesiones} lugares ocupados`;
		vista.querySelector('#activas').innerHTML = s.activas.length ? `<table class="tabla"><tr><th>Perfil</th><th>Dispositivo</th><th>Vence en</th><th></th></tr>
			${s.activas.map((a) => `<tr data-sesion="${a.idSesion}"><td>${esc(perfil(a.idPerfil))}</td><td>${esc(disp(a.idDispositivo))}</td><td>${a.expiraEnSeg} s</td>
				<td style="text-align:right"><button class="boton chico" data-accion="expirar">Forzar expiración</button> <button class="boton chico" data-accion="cerrar">Cerrar</button></td></tr>`).join('')}</table>`
			: '<p class="vacio">Nadie está mirando ahora. Abrí la vista usuario y reproducí algo.</p>';
		vista.querySelector('#historial').innerHTML = s.historial.length ? `<table class="tabla"><tr><th>Perfil</th><th>Dispositivo</th><th>Inicio</th><th>Cierre</th><th>Motivo</th></tr>
			${s.historial.slice(0, 10).map((h) => `<tr><td>${esc(perfil(h.idPerfil))}</td><td>${esc(disp(h.idDispositivo))}</td>
				<td class="suave">${new Date(h.inicioSesion).toLocaleTimeString('es-AR')}</td><td class="suave">${new Date(h.fechaFin).toLocaleTimeString('es-AR')}</td>
				<td>${esc(h.motivoCierre)}</td></tr>`).join('')}</table>` : '<p class="vacio">Sin cierres registrados.</p>';
	};
	vista.querySelector('#cuenta').onchange = mostrar;
	vista.querySelector('#cerrar-todas').onclick = async () => {
		await pedir({ metodo: 'POST', ruta: `${API}/cuentas/${cuenta().id}/cerrar-sesiones`, accion: 'Cerrar todas las sesiones (remoto)' });
		await mostrar();
	};
	vista.querySelector('#activas').onclick = async (e) => {
		const b = e.target.closest('[data-accion]');
		if (!b) return;
		const id = b.closest('[data-sesion]').dataset.sesion;
		if (b.dataset.accion === 'cerrar') {
			await pedir({ metodo: 'DELETE', ruta: `${API}/reproducciones/${id}`, accion: 'Cerrar una sesión' });
		} else {
			b.disabled = true;
			await pedir({ metodo: 'POST', ruta: `/demo/api/expirar/${id}`, accion: 'Forzar la expiración (como 2 minutos sin reportes)' });
		}
		await mostrar();
	};
	await mostrar();
	clearInterval(refresco);
	refresco = setInterval(mostrar, REFRESCO_SESIONES_MS);
}, 'admin');

// ─── Fallas ───────────────────────────────────────────────────────────────────

const EJERCICIOS = {
	P1: 'Alta de serie (Admin → Catálogo)',
	P2: 'Inicio de reproducción (▶ en la vista usuario)',
	P4: 'Fin de episodio (terminar o "Saltar al final")',
	P8: 'Retiro por licencia (Admin → Licencias)',
};

registrar('admin/fallas', (vista) => {
	const pintar = () => {
		const armada = fallaArmada();
		vista.innerHTML = `${encabezado('Fallas', [], 'Elegí un paso: la próxima acción que lo use va a fallar justo ahí, y en la columna de la derecha vas a ver cómo la saga deshace los pasos anteriores en orden inverso.')}
			<div class="fallas">${Object.entries(EJERCICIOS).map(([p, titulo]) => `<div class="panel"><b>${p} · ${titulo}</b>
				<div class="pasos">${Object.entries(PASOS[p]).map(([paso, motor]) => `<button class="paso-falla m-${motor} ${armada === paso ? 'armado' : ''}" data-paso="${paso}" title="${MOTORES[motor]}">${paso}</button>`).join('<span class="suave">→</span>')}</div></div>`).join('')}</div>
			${armada ? '<button class="boton" id="desarmar">Desarmar</button>' : ''}`;
		vista.querySelectorAll('[data-paso]').forEach((b) => b.onclick = () => { armarFalla(b.dataset.paso); pintar(); });
		vista.querySelector('#desarmar')?.addEventListener('click', () => { armarFalla(null); pintar(); });
	};
	pintar();
}, 'admin');
