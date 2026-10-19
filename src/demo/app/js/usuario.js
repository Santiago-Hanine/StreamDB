// Vistas del usuario: inicio (destacado + filas), detalle de un contenido.
import { registrar } from './router.js';
import { estado } from './estado.js';
import { pedir, leer, combinar } from './api.js';
import { mostrarClic } from './motores.js';
import { abrirPlayer } from './player.js';
import { esc, pildora, tiempo, abrirModal, cerrarModal } from './util.js';

const GENEROS_EN_INICIO = 2;
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

registrar('home', async (vista) => {
	const p = estado.perfil;
	vista.innerHTML = '<div id="destacado"></div><div id="filas"><p class="vacio">Cargando…</p></div>';

	let generos, d;
	try {
		[{ generos }, d] = await Promise.all([leer('/demo/api/app/catalogo'), datosDemo()]);
	} catch (e) {
		vista.querySelector('#filas').innerHTML = `<p class="error-texto">No se pudo cargar el inicio: ${esc(e.message)}</p>`;
		return;
	}
	const pedidos = [
		{ clave: 'cv', motor: 'redis', titulo: 'Continuar viendo', explica: 'el segundo exacto donde quedaste, en Redis',
			ruta: `${API}/perfiles/${p.id}/continuar-viendo` },
		{ clave: 'rec', motor: 'neo4j', titulo: 'Porque viste…', explica: 'recorrido del grafo desde lo que viste',
			ruta: `${API}/perfiles/${p.id}/recomendaciones?limite=10` },
		...generos.slice(0, GENEROS_EN_INICIO).map((g) => ({ clave: g, motor: 'mongo', titulo: g, explica: 'filtro del catálogo, solo lo apto para el perfil',
			ruta: `${API}/contenidos?genero=${encodeURIComponent(g)}&idPerfil=${p.id}&limite=12` })),
	];
	const resultados = await Promise.all(pedidos.map((x) => pedir({ ruta: x.ruta, mostrar: false })));
	mostrarClic(`Abrir el inicio de ${p.nombre}`, combinar(resultados));

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
	const candidatos = [...cv.slice(0, 3).map((c) => ({ id: c.idContenido, cv: c })), { id: d.serie.id }];
	let elegido = null;
	for (const cand of candidatos) {
		const ficha = await leer(`/demo/api/app/contenidos/${cand.id}`).catch(() => null);
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
