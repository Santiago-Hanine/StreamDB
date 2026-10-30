// Pedidos a la API con traza, para la columna de motores. Si hay una falla armada se manda ?fallarEn.
import { mostrarClic } from './motores.js';
import { esc } from './util.js';

let falla = null;
const LIMITE_MS = 10000; // con un motor caído la API puede no responder

// La falla armada se gasta solo si la saga falló en ese paso
export const fallaConsumida = (r, paso) => Boolean(r.traza?.saga?.pasos?.some((p) => p.nombre === paso && p.estado === 'fallido'));

export async function pedir({ metodo = 'GET', ruta, body, accion, pasos = [], mostrar = true }) {
	const usada = falla && pasos.includes(falla) ? falla : null;
	if (usada) {
		ruta += (ruta.includes('?') ? '&' : '?') + 'fallarEn=' + encodeURIComponent(usada);
		armarFalla(null);
	}
	const opciones = { method: metodo, headers: { 'x-traza': '1' }, signal: AbortSignal.timeout(LIMITE_MS) };
	if (body !== undefined) {
		opciones.headers['content-type'] = 'application/json';
		opciones.body = JSON.stringify(body);
	}
	let status, cuerpo, traza = null;
	try {
		const r = await fetch(ruta, opciones);
		status = r.status;
		cuerpo = await r.json().catch(() => null);
		const id = r.headers.get('x-traza');
		if (id) traza = await fetch(`/demo/api/trazas/${id}`).then((t) => (t.ok ? t.json() : null)).catch(() => null);
	} catch (e) {
		status = 0;
		cuerpo = { error: `No se pudo conectar con la API: ${e.message}` };
	}
	const resultado = { status, cuerpo, traza };
	if (usada && !fallaConsumida(resultado, usada)) armarFalla(usada);
	if (mostrar && accion) mostrarClic(accion, resultado);
	return resultado;
}

// Consultas internas, sin traza
export async function leer(ruta, opciones) {
	const r = await fetch(ruta, { signal: AbortSignal.timeout(LIMITE_MS), ...opciones });
	const cuerpo = await r.json().catch(() => null);
	if (!r.ok) throw new Error(cuerpo?.error ?? `Error ${r.status}`);
	return cuerpo;
}

export const fallaArmada = () => falla;

export function armarFalla(paso) {
	falla = paso;
	const el = document.getElementById('falla-armada');
	if (!paso) { el.hidden = true; return; }
	el.innerHTML = `⚠️ Falla armada: la próxima acción que use el paso «${esc(paso)}» va a fallar ahí <button class="boton chico">Desarmar</button>`;
	el.hidden = false;
	el.querySelector('button').onclick = () => armarFalla(null);
	document.dispatchEvent(new CustomEvent('falla-armada'));
}

// Junta varios pedidos en uno para la columna
export function combinar(resultados) {
	const conTraza = resultados.filter((r) => r.traza);
	const peor = resultados.find((r) => r.status >= 400 || r.status === 0);
	return {
		status: peor?.status ?? 200,
		cuerpo: peor?.cuerpo ?? {},
		traza: {
			ms: Math.max(0, ...conTraza.map((r) => r.traza.ms ?? 0)),
			ops: conTraza.flatMap((r) => r.traza.ops),
			saga: null,
		},
	};
}
