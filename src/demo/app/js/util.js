export const $ = (s, raiz = document) => raiz.querySelector(s);
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const corto = (id) => String(id ?? '').slice(0, 8);
export const tiempo = (s) => {
	s = Math.max(0, Math.round(s ?? 0));
	const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), seg = String(s % 60).padStart(2, '0');
	return h ? `${h}:${String(m).padStart(2, '0')}:${seg}` : `${m}:${seg}`;
};

export const MOTORES = {
	mongo: 'MongoDB', neo4j: 'Neo4j', cassandra: 'Cassandra', redis: 'Redis', postgres: 'PostgreSQL',
};
export const pildora = (motor) => `<span class="pildora m-${motor}">${MOTORES[motor]}</span>`;

let temporizador;
export function aviso(texto, tipo = '') {
	const el = document.getElementById('aviso');
	el.className = tipo;
	el.textContent = texto;
	el.hidden = false;
	clearTimeout(temporizador);
	temporizador = setTimeout(() => { el.hidden = true; }, 4000);
}

export function abrirModal(html) {
	const modal = document.getElementById('modal');
	modal.innerHTML = `<div class="modal-caja"><button class="cerrar" aria-label="Cerrar">✕</button>${html}</div>`;
	modal.hidden = false;
	modal.onclick = (e) => { if (e.target === modal || e.target.closest('.cerrar')) cerrarModal(); };
	return modal.querySelector('.modal-caja');
}
export function cerrarModal() {
	document.getElementById('modal').hidden = true;
}
