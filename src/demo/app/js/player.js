// Reproductor simulado: ▶ inicia la reproducción (P2), mientras "mira" reporta el segundo (P3),
// al terminar registra el fin del episodio (P4) y al cerrar libera la sesión (P6).
// El tiempo corre acelerado para no esperar un episodio entero.
import { estado } from './estado.js';
import { pedir, leer } from './api.js';
import { esc, tiempo, abrirModal, cerrarModal, aviso } from './util.js';

const VELOCIDAD = 30;          // 1 s real = 30 s de episodio
const REPORTE_CADA_MS = 3000;  // el reproductor informa el segundo cada 3 s
const DURACION_POR_DEFECTO = 2700;
const API = '/api/v1';

// Texto y duración de lo que se está viendo (episodio de una serie o película)
export function unidad(ficha, idEpisodio) {
	if (ficha.tipo !== 'serie') return { texto: 'Película', duracionSeg: ficha.duracionSeg || DURACION_POR_DEFECTO };
	for (const t of ficha.temporadas ?? []) {
		const e = t.episodios.find((x) => x.id === idEpisodio);
		if (e) return { texto: `T${t.numero} · E${e.numero} · ${e.titulo}`, duracionSeg: e.duracionSeg };
	}
	return { texto: 'Episodio', duracionSeg: DURACION_POR_DEFECTO };
}

let reloj = null;       // setInterval del avance
let ultimoReporte = 0;
let enviando = false;

const el = () => document.getElementById('player');
const sesion = () => estado.sesion;

function detener() {
	clearInterval(reloj);
	reloj = null;
}

// ─── Abrir ────────────────────────────────────────────────────────────────────

export async function abrirPlayer(idContenido, idEpisodio) {
	if (sesion()) await cerrarPlayer({ silencioso: true });
	const body = { idPerfil: estado.perfil.id, idDispositivo: estado.dispositivo.id, idContenido, ...(idEpisodio && { idEpisodio }) };
	const r = await pedir({ metodo: 'POST', ruta: `${API}/reproducciones`, body, accion: '▶ Reproducir', pasos: ['reservar_cupo', 'registrar_inicio'] });

	if (r.status === 409 && r.cuerpo?.detalle?.limite) return sinLugar(r.cuerpo);
	if (r.status !== 201) {
		abrirModal(`<h2>No se pudo reproducir</h2><p class="error-texto">${esc(r.cuerpo?.error ?? 'Error')}</p>
			<p class="suave">Mirá en la columna de la derecha qué alcanzó a hacer cada base.</p>`);
		return;
	}

	const ficha = await leer(`/demo/api/app/contenidos/${idContenido}`).catch(() => ({ titulo: 'Contenido', tipo: 'pelicula' }));
	const u = unidad(ficha, r.cuerpo.idEpisodio);
	estado.sesion = {
		idSesion: r.cuerpo.idSesion, idContenido, idEpisodio: r.cuerpo.idEpisodio,
		titulo: ficha.titulo, texto: u.texto, duracionSeg: u.duracionSeg,
		posicionSeg: r.cuerpo.posicionSeg ?? 0, reutilizada: r.cuerpo.sesionReutilizada, terminado: false,
	};
	pintar();
	reproducir();
}

// La cuenta llegó a su límite de pantallas (P2 → 409)
function sinLugar(cuerpo) {
	const caja = abrirModal(`<h2>Ya hay ${cuerpo.detalle.limite} pantallas en uso</h2>
		<p>${esc(cuerpo.error)}.</p>
		<p class="suave">Redis lleva la cuenta de las sesiones activas de la cuenta con un script Lua atómico: si no hay lugar, no se reserva nada.</p>
		<div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:14px">
			<button class="boton rojo" id="cerrar-todas">Cerrar sesión en todos lados</button>
			<button class="boton" id="otro">Elegir otro dispositivo</button></div>`);
	caja.querySelector('#cerrar-todas').onclick = async () => {
		const r = await pedir({ metodo: 'POST', ruta: `${API}/cuentas/${estado.cuenta.id}/cerrar-sesiones`, accion: 'Cerrar sesión en todos lados' });
		cerrarModal();
		if (r.status === 200) aviso(`Se cerraron ${r.cuerpo.cerradas} sesiones: ya podés reproducir`);
	};
	caja.querySelector('#otro').onclick = () => { cerrarModal(); location.hash = '#/quien'; };
}

// ─── Reproducción ─────────────────────────────────────────────────────────────

function reproducir() {
	detener();
	ultimoReporte = Date.now();
	reloj = setInterval(() => {
		const s = sesion();
		if (!s) return detener();
		s.posicionSeg = Math.min(s.duracionSeg, s.posicionSeg + VELOCIDAD);
		actualizar();
		if (s.posicionSeg >= s.duracionSeg) return terminar();
		if (Date.now() - ultimoReporte >= REPORTE_CADA_MS) reportar();
	}, 1000);
	pintarBoton();
}

async function reportar(evento = 'reporte') {
	const s = sesion();
	if (!s || (enviando && evento === 'reporte')) return;
	enviando = true;
	ultimoReporte = Date.now();
	const textos = { reporte: 'Mirando… reporte de progreso', pausa: '⏸ Pausa', cierre: '✕ Salir del reproductor' };
	const r = await pedir({ metodo: 'POST', ruta: `${API}/reproducciones/${s.idSesion}/progreso`, body: { posicionSeg: Math.round(s.posicionSeg), evento }, accion: textos[evento] });
	enviando = false;
	if (r.status === 410 && sesion() === s) {
		detener();
		mensaje(`${esc(r.cuerpo.error)}. ${/expir/.test(r.cuerpo.error) ? 'Pasaron más de 2 minutos sin reportes (o se forzó la expiración): la sesión se cerró y el lugar se liberó.' : ''}`, true);
	}
	return r;
}

async function terminar() {
	detener();
	const s = sesion();
	if (!s || s.terminado) return;
	s.terminado = true;
	s.posicionSeg = s.duracionSeg;
	actualizar();
	const r = await pedir({ metodo: 'POST', ruta: `${API}/reproducciones/${s.idSesion}/fin`, accion: 'Terminó el episodio',
		pasos: ['marcar_finalizado', 'continuar_viendo', 'senal_vio'] });
	if (r.status !== 200) {
		s.terminado = false;
		return mensaje(esc(r.cuerpo?.error ?? 'No se pudo registrar el fin'), true);
	}
	const sig = r.cuerpo.siguiente;
	mensaje(sig
		? `Terminaste ${esc(s.texto)}. "Continuar viendo" ya apunta al siguiente.<div style="margin-top:12px"><button class="boton primario" id="siguiente">Siguiente episodio ▶ T${sig.temporada} · E${sig.episodio} · ${esc(sig.titulo)}</button></div>`
		: 'Terminaste. Se registró la señal VIO en el grafo: cuenta para tus recomendaciones.');
	el().querySelector('#siguiente')?.addEventListener('click', () => abrirPlayer(s.idContenido, sig.idEpisodio));
}

export async function cerrarPlayer({ silencioso = false } = {}) {
	detener();
	const s = sesion();
	estado.sesion = null;
	el().hidden = true;
	if (!s) return;
	if (!s.terminado) {
		const r = await pedir({ metodo: 'POST', ruta: `${API}/reproducciones/${s.idSesion}/progreso`,
			body: { posicionSeg: Math.round(s.posicionSeg), evento: 'cierre' }, accion: '✕ Salir del reproductor', mostrar: !silencioso });
		if (r.status === 410) return;
	}
	await pedir({ metodo: 'DELETE', ruta: `${API}/reproducciones/${s.idSesion}`, accion: 'Cerrar la sesión de este dispositivo', mostrar: !silencioso });
	if (!silencioso && location.hash.startsWith('#/home')) window.dispatchEvent(new HashChangeEvent('hashchange'));
}

// ─── Pantalla ─────────────────────────────────────────────────────────────────

function pintar() {
	const s = sesion();
	el().innerHTML = `
		<div class="arriba"><div><h2>${esc(s.titulo)}</h2><div class="suave">${esc(s.texto)}${s.reutilizada ? ' · sesión reutilizada' : ''}</div></div>
			<button class="boton" id="salir-player">✕ Salir</button></div>
		<div class="pantalla">▶</div>
		<div id="mensaje"></div>
		<div>
			<div class="linea"><span id="pos">${tiempo(s.posicionSeg)}</span><div class="barra-progreso"><i id="avance"></i></div><span>${tiempo(s.duracionSeg)}</span></div>
			<div class="controles">
				<button class="boton primario" id="pausa"></button>
				<button class="boton" id="final">⏭ Saltar al final</button>
				<span class="suave" style="align-self:center">Tiempo acelerado ×${VELOCIDAD} · reporte de progreso cada ${REPORTE_CADA_MS / 1000} s</span>
			</div>
		</div>`;
	el().hidden = false;
	el().querySelector('#salir-player').onclick = () => cerrarPlayer();
	el().querySelector('#final').onclick = () => { const x = sesion(); if (x) { x.posicionSeg = x.duracionSeg - 1; terminar(); } };
	el().querySelector('#pausa').onclick = () => {
		if (reloj) { detener(); pintarBoton(); reportar('pausa'); } else if (sesion() && !sesion().terminado) reproducir();
	};
	actualizar();
}

function pintarBoton() {
	const b = el().querySelector('#pausa');
	if (!b) return;
	b.textContent = reloj ? '⏸ Pausa' : '▶ Seguir';
	b.disabled = Boolean(sesion()?.terminado);
}

function actualizar() {
	const s = sesion();
	if (!s) return;
	el().querySelector('#pos').textContent = tiempo(s.posicionSeg);
	el().querySelector('#avance').style.width = `${(100 * s.posicionSeg) / s.duracionSeg}%`;
}

function mensaje(html, error = false) {
	el().querySelector('#mensaje').innerHTML = `<div class="mensaje ${error ? 'error' : ''}">${html}</div>`;
	pintarBoton();
}
