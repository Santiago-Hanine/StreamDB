// Pedidos a la API real con traza: cada uno se muestra en la columna de motores.
// Si hay una falla "armada" y el pedido tiene ese paso, se manda ?fallarEn=<paso> y se desarma.
import { mostrarClic } from './motores.js';
import { esc } from './util.js';

let falla = null;

export async function pedir({ metodo = 'GET', ruta, body, accion, pasos = [], mostrar = true }) {
	if (falla && pasos.includes(falla)) {
		ruta += (ruta.includes('?') ? '&' : '?') + 'fallarEn=' + encodeURIComponent(falla);
		armarFalla(null);
	}
	const opciones = { method: metodo, headers: { 'x-traza': '1' } };
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
	if (mostrar && accion) mostrarClic(accion, resultado);
	return resultado;
}

// Consultas internas de la app (sin traza): devuelven el JSON o lanzan
export async function leer(ruta, opciones) {
	const r = await fetch(ruta, opciones);
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
