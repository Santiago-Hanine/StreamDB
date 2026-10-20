// Vistas del usuario: inicio (destacado + filas), detalle de un contenido.
import { registrar } from './router.js';
import { estado } from './estado.js';
import { pedir, leer, combinar } from './api.js';
import { mostrarClic } from './motores.js';
import { abrirPlayer, unidad } from './player.js';
import { esc, pildora, tiempo, abrirModal, cerrarModal } from './util.js';

const GENEROS_EN_INICIO = 2;
const POR_PAGINA = 24;
const MESES_ACTIVIDAD = 3;
const API = '/api/v1';

// ─── Carátulas: degradado derivado del id (sin imágenes externas) ─────────────

function tono(id) {
	let h = 0;
	for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
	return h % 360;
}
export const fondo = (id) => {
	const h = tono(id);
	return `linear-gradient(155deg, hsl(${h} 55% 38%), hsl(${(h + 50) % 360} 60% 14%))`;
};

export function caratula(c, { extra = '', tag = '', progreso = null } = {}) {
	const barra = progreso != null ? `<div class="barra-progreso"><i style="width:${Math.min(100, Math.round(progreso * 100))}%"></i></div>` : '';
	return `<div class="caratula" data-id="${c.id}" style="background:${fondo(c.id)}" title="${esc(c.titulo)}">
		${tag ? `<span class="tag">${esc(tag)}</span>` : ''}
		<div class="titulo">${esc(c.titulo)}</div>${extra ? `<div class="extra">${esc(extra)}</div>` : ''}${barra}</div>`;
}

// Clic en cualquier carátula de un contenedor → detalle
export function alClicCaratula(contenedor) {
	contenedor.addEventListener('click', (e) => {
		const el = e.target.closest('.caratula');
		if (el) abrirDetalle(el.dataset.id);
	});
}

const episodioTexto = (cv) => (cv.temporada ? `T${cv.temporada} · E${cv.episodio} · ${cv.tituloEpisodio}` : 'Película');

// ─── Detalle de un contenido ──────────────────────────────────────────────────

export async function abrirDetalle(id) {
	const caja = abrirModal('<p class="vacio">Cargando…</p>');
	let c;
	try { c = await leer(`/demo/api/app/contenidos/${id}`); } catch (e) {
		caja.innerHTML = `<p class="error-texto">${esc(e.message)}</p>`;
		return;
	}
	const apto = c.clasificacionEdad <= estado.perfil.clasificacionEdad;
	const episodios = (c.temporadas ?? []).map((t) => `<h3 style="margin-top:14px">Temporada ${t.numero}</h3>
		<table class="tabla">${t.episodios.map((e) => `<tr><td>${e.numero}. ${esc(e.titulo)}</td><td class="suave">${tiempo(e.duracionSeg)}</td>
		<td style="text-align:right"><button class="boton chico" data-episodio="${e.id}">▶</button></td></tr>`).join('')}</table>`).join('');
	caja.innerHTML = `<button class="cerrar" aria-label="Cerrar">✕</button>
		<div class="destacado" style="background:${fondo(c.id)};min-height:150px;padding:20px;margin-bottom:16px"><h1>${esc(c.titulo)}</h1></div>
		<p>${c.tipo === 'serie' ? 'Serie' : 'Película'} · ${c.anioEstreno} · +${c.clasificacionEdad} · ${esc(c.plataforma?.nombre)}${c.estado !== 'publicado' ? ` · <b class="error-texto">${esc(c.estado)}</b>` : ''}</p>
		<p class="suave">${esc((c.generos ?? []).join(' · '))}</p>
		${c.elenco?.length ? `<p class="suave">Elenco: ${esc(c.elenco.slice(0, 4).map((a) => a.nombre).join(', '))}</p>` : ''}
		${apto ? '' : `<p class="error-texto">No es apto para el perfil ${esc(estado.perfil.nombre)} (+${estado.perfil.clasificacionEdad}). Igual podés intentar reproducirlo para ver cómo lo rechaza la API.</p>`}
		<div class="acciones" style="display:flex;gap:10px"><button class="boton primario" data-episodio="">▶ Reproducir</button></div>
		${episodios}`;
	caja.addEventListener('click', (e) => {
		const b = e.target.closest('[data-episodio]');
		if (!b) return;
		cerrarModal();
		abrirPlayer(c.id, b.dataset.episodio || undefined);
	});
}

// ─── Inicio del usuario ───────────────────────────────────────────────────────

let demo = null;
const datosDemo = async () => (demo ??= await leer('/demo/api/datos'));

registrar('home', async (vista, params, sigue) => {
	const p = estado.perfil;
	vista.innerHTML = '<div id="destacado"></div><div id="filas"><p class="vacio">Cargando…</p></div>';

	// Si Neo4j no responde no hay géneros para las filas, pero "continuar viendo" (Redis) y las demás filas siguen
	const [catalogo, d] = await Promise.all([
		leer('/demo/api/app/catalogo').catch(() => null),
		datosDemo().catch(() => null),
	]);
	if (!sigue()) return;
	const generos = catalogo?.generos ?? [];
	const pedidos = [
		{ clave: 'cv', motor: 'redis', titulo: 'Continuar viendo', explica: 'el segundo exacto donde quedaste, en Redis',
			ruta: `${API}/perfiles/${p.id}/continuar-viendo` },
		{ clave: 'rec', motor: 'neo4j', titulo: 'Porque viste…', explica: 'recorrido del grafo desde lo que viste',
			ruta: `${API}/perfiles/${p.id}/recomendaciones?limite=10` },
		...generos.slice(0, GENEROS_EN_INICIO).map((g) => ({ clave: g, motor: 'mongo', titulo: g, explica: 'filtro del catálogo, solo lo apto para el perfil',
			ruta: `${API}/contenidos?genero=${encodeURIComponent(g)}&idPerfil=${p.id}&limite=12` })),
	];
	const resultados = await Promise.all(pedidos.map((x) => pedir({ ruta: x.ruta, mostrar: false })));
	if (!sigue()) return;
	if (!estado.conservarColumna) mostrarClic(`Abrir el inicio de ${p.nombre}`, combinar(resultados));
	estado.conservarColumna = false;

	// Filas
	const filas = pedidos.map((x, i) => {
		const r = resultados[i];
		let items = [];
		if (r.status === 200) {
			if (x.clave === 'cv') items = r.cuerpo.contenidos.map((c) => caratula({ id: c.idContenido, titulo: c.titulo },
				{ extra: `${episodioTexto(c)} · ${tiempo(c.posicionSeg)}`, progreso: c.duracionSeg ? c.posicionSeg / c.duracionSeg : 0 }));
			else if (x.clave === 'rec') items = r.cuerpo.recomendaciones.map((c) => caratula({ id: c.idContenido, titulo: c.titulo },
				{ tag: c.porque?.texto.replace(/^Porque (viste|estás viendo) /, '') ?? '', extra: `+${c.clasificacionEdad} · ${c.generos[0] ?? ''}` }));
			else items = r.cuerpo.contenidos.map((c) => caratula({ id: c._id, titulo: c.titulo },
				{ extra: `${c.tipo === 'serie' ? 'Serie' : 'Película'} · +${c.clasificacionEdad}${c.progreso ? ` · seguís en ${tiempo(c.progreso.posicionSeg)}` : ''}` }));
		}
		const cuerpo = r.status !== 200
			? `<p class="error-texto">${esc(r.cuerpo?.error ?? 'No se pudo cargar')}</p>`
			: items.join('') || '<p class="vacio">Nada por acá todavía.</p>';
		return `<section class="fila"><h3>${esc(x.titulo)} ${pildora(x.motor)} <span class="explica">${x.explica} ·
			<a href="#" data-traza="${i}"><u>ver qué hizo</u></a></span></h3><div class="carrusel">${cuerpo}</div></section>`;
	}).join('');
	const contFilas = vista.querySelector('#filas');
	contFilas.innerHTML = filas;
	alClicCaratula(contFilas);
	contFilas.addEventListener('click', (e) => {
		const a = e.target.closest('[data-traza]');
		if (!a) return;
		e.preventDefault();
		const i = Number(a.dataset.traza);
		mostrarClic(`Fila «${pedidos[i].titulo}»`, resultados[i]);
	});

	// Destacado: lo primero de "continuar viendo" que sea apto; si no, la serie demo si es apta; si no, lo primero del catálogo
	const cv = resultados[0].status === 200 ? resultados[0].cuerpo.contenidos : [];
	const candidatos = [...cv.slice(0, 3).map((c) => ({ id: c.idContenido, cv: c })), ...(d ? [{ id: d.serie.id }] : [])];
	let elegido = null;
	for (const cand of candidatos) {
		const ficha = await leer(`/demo/api/app/contenidos/${cand.id}`).catch(() => null);
		if (!sigue()) return;
		if (ficha && ficha.estado === 'publicado' && ficha.clasificacionEdad <= p.clasificacionEdad) { elegido = { ...cand, ficha }; break; }
	}
	const primero = resultados[2]?.cuerpo?.contenidos?.[0];
	if (!elegido && primero) elegido = { id: primero._id, ficha: { titulo: primero.titulo, tipo: primero.tipo, clasificacionEdad: primero.clasificacionEdad, generos: primero.generos } };
	if (!elegido) return;

	const { ficha, cv: enCurso } = elegido;
	vista.querySelector('#destacado').innerHTML = `<div class="destacado" style="background:${fondo(elegido.id)}">
		<h1>${esc(ficha.titulo)}</h1>
		<div>${ficha.tipo === 'serie' ? 'Serie' : 'Película'} · +${ficha.clasificacionEdad} · ${esc((ficha.generos ?? []).join(' · '))}</div>
		${enCurso ? `<div class="suave">${esc(episodioTexto(enCurso))} · quedaste en ${tiempo(enCurso.posicionSeg)}</div>` : ''}
		<div class="acciones"><button class="boton primario" id="play">▶ ${enCurso ? 'Continuar' : 'Reproducir'}</button>
		<button class="boton" id="info">Más información</button></div></div>`;
	vista.querySelector('#play').onclick = () => abrirPlayer(elegido.id);
	vista.querySelector('#info').onclick = () => abrirDetalle(elegido.id);
}, 'usuario');

// ─── Explorar (P7) ────────────────────────────────────────────────────────────

const opciones = (lista, elegido, todos) => `<option value="">${todos}</option>`
	+ lista.map((x) => `<option value="${esc(x.id ?? x)}" ${(x.id ?? x) === elegido ? 'selected' : ''}>${esc(x.nombre ?? x)}</option>`).join('');

registrar('explorar', async (vista) => {
	const filtro = { genero: '', idActor: '', idPlataforma: '', pagina: 1 };
	let catalogo;
	try { catalogo = await leer('/demo/api/app/catalogo'); } catch (e) {
		vista.innerHTML = `<p class="error-texto">${esc(e.message)}</p>`;
		return;
	}
	vista.innerHTML = `<h1>Explorar</h1>
		<p class="suave">Filtros combinados en ${pildora('mongo')} (solo lo publicado y apto para ${esc(estado.perfil.nombre)}),
		lo vinculado de cada resultado en ${pildora('neo4j')} y dónde quedaste en ${pildora('redis')}.</p>
		<div class="filtros">
			<select class="campo" id="f-genero">${opciones(catalogo.generos, '', 'Todos los géneros')}</select>
			<select class="campo" id="f-actor">${opciones(catalogo.actores, '', 'Cualquier actor')}</select>
			<select class="campo" id="f-plataforma">${opciones(catalogo.plataformas, '', 'Todas las plataformas')}</select>
			<span class="suave" id="total"></span>
		</div>
		<div class="grilla" id="resultados"></div>
		<div class="paginado"><button class="boton" id="ant">← Anterior</button><span id="pagina"></span><button class="boton" id="sig">Siguiente →</button></div>`;
	const grilla = vista.querySelector('#resultados');
	alClicCaratula(grilla);

	const buscar = async () => {
		const q = new URLSearchParams({ idPerfil: estado.perfil.id, limite: POR_PAGINA, pagina: filtro.pagina });
		for (const k of ['genero', 'idActor', 'idPlataforma']) if (filtro[k]) q.set(k, filtro[k]);
		grilla.innerHTML = '<p class="vacio">Buscando…</p>';
		const r = await pedir({ ruta: `${API}/contenidos?${q}`, accion: 'Explorar con filtros' });
		if (r.status !== 200) {
			grilla.innerHTML = `<p class="error-texto">${esc(r.cuerpo?.error ?? 'Error')}</p>`;
			return;
		}
		const { contenidos, total } = r.cuerpo;
		const paginas = Math.max(1, Math.ceil(total / POR_PAGINA));
		vista.querySelector('#total').textContent = `${total} resultado${total === 1 ? '' : 's'}`;
		vista.querySelector('#pagina').textContent = `Página ${filtro.pagina} de ${paginas}`;
		vista.querySelector('#ant').disabled = filtro.pagina <= 1;
		vista.querySelector('#sig').disabled = filtro.pagina >= paginas;
		grilla.innerHTML = contenidos.map((c) => caratula({ id: c._id, titulo: c.titulo }, {
			tag: c.vinculados?.length ? `${c.vinculados.length} vinculado${c.vinculados.length === 1 ? '' : 's'}` : '',
			extra: `${c.tipo === 'serie' ? `Serie · ${c.cantidadEpisodios} ep.` : 'Película'} · +${c.clasificacionEdad}${c.progreso ? ` · seguís en ${tiempo(c.progreso.posicionSeg)}` : ''}`,
		})).join('') || '<p class="vacio">No hay contenidos con esos filtros.</p>';
	};
	const cambiar = (clave) => (e) => { filtro[clave] = e.target.value; filtro.pagina = 1; buscar(); };
	vista.querySelector('#f-genero').onchange = cambiar('genero');
	vista.querySelector('#f-actor').onchange = cambiar('idActor');
	vista.querySelector('#f-plataforma').onchange = cambiar('idPlataforma');
	vista.querySelector('#ant').onclick = () => { filtro.pagina--; buscar(); };
	vista.querySelector('#sig').onclick = () => { filtro.pagina++; buscar(); };
	await buscar();
}, 'usuario');

// ─── Mi actividad (P3: historial en Cassandra) ────────────────────────────────

export function rangoMeses(hoy, meses) {
	const aaaamm = (d) => d.toISOString().slice(0, 7);
	const desde = new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth() - (meses - 1), 1));
	return { desde: aaaamm(desde), hasta: aaaamm(hoy) };
}

registrar('actividad', async (vista) => {
	const { desde, hasta } = rangoMeses(new Date(), MESES_ACTIVIDAD);
	vista.innerHTML = `<h1>Mi actividad</h1>
		<p class="suave">El historial vive en ${pildora('cassandra')}, particionado por perfil y mes: cada mes es una
		consulta por clave completa (${esc(estado.perfil.nombre)}, AAAA-MM), sin ALLOW FILTERING. Período: ${desde} a ${hasta}.</p>
		<div id="tabla"><p class="vacio">Cargando…</p></div>`;
	const r = await pedir({ ruta: `${API}/perfiles/${estado.perfil.id}/historial?desde=${desde}&hasta=${hasta}`, accion: 'Ver mi actividad' });
	const caja = vista.querySelector('#tabla');
	if (r.status !== 200) {
		caja.innerHTML = `<p class="error-texto">${esc(r.cuerpo?.error ?? 'Error')}</p>`;
		return;
	}
	const { visualizaciones } = r.cuerpo;
	if (!visualizaciones.length) {
		caja.innerHTML = '<p class="vacio">No viste nada en este período.</p>';
		return;
	}
	// Nombres de los episodios: una ficha por serie distinta
	const series = [...new Set(visualizaciones.filter((v) => v.idEpisodio && v.idEpisodio !== v.idContenido).map((v) => v.idContenido))];
	const fichas = new Map(await Promise.all(series.map(async (id) => [id, await leer(`/demo/api/app/contenidos/${id}`).catch(() => null)])));
	const fecha = (f) => new Date(f).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
	caja.innerHTML = `<p class="suave">${visualizaciones.length} visualizaciones</p><table class="tabla">
		<tr><th>Cuándo</th><th>Qué</th><th>Unidad</th><th>Hasta</th><th></th></tr>
		${visualizaciones.map((v) => {
			const ficha = fichas.get(v.idContenido);
			const texto = ficha ? unidad(ficha, v.idEpisodio).texto : 'Película';
			return `<tr><td class="suave">${fecha(v.fechaInicio)}</td><td><a href="#" data-id="${v.idContenido}"><b>${esc(v.titulo ?? v.idContenido)}</b></a></td>
				<td>${esc(texto)}</td><td>${tiempo(v.posicionSeg)}</td><td>${v.finalizado ? '✓ terminado' : ''}</td></tr>`;
		}).join('')}</table>`;
	caja.addEventListener('click', (e) => {
		const a = e.target.closest('[data-id]');
		if (!a) return;
		e.preventDefault();
		abrirDetalle(a.dataset.id);
	});
}, 'usuario');
