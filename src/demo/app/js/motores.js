// Columna "Qué pasó con tu último clic": qué motores intervinieron, una frase simple por motor,
// la saga (si hubo) y, desplegable, cada operación exacta en orden.
import { esc, MOTORES } from './util.js';

const ORDEN = ['mongo', 'redis', 'cassandra', 'neo4j', 'postgres'];
const ROL = {
	mongo: 'catálogo, cuentas y log de sagas', redis: 'sesiones, cupo y continuar viendo', cassandra: 'historial y sesiones cerradas',
	neo4j: 'elenco, vínculos y señales VIO', postgres: 'licencias',
};
// En qué motor corre cada paso de las sagas (para colorear la saga y las fallas)
export const PASOS = {
	P1: { ficha: 'mongo', episodios: 'mongo', nodo: 'neo4j', elenco: 'neo4j', vinculos: 'neo4j', publicar: 'mongo' },
	P2: { reservar_cupo: 'redis', registrar_inicio: 'cassandra' },
	P4: { marcar_finalizado: 'cassandra', continuar_viendo: 'redis', senal_vio: 'neo4j' },
	P8: { continuar_viendo: 'redis', marcar_nodo: 'neo4j', retirar_ficha: 'mongo', vencer_licencias: 'postgres' },
};

const ESCRITURA = /^(INSERT|UPDATE|DELETE|BATCH|CREATE|MERGE|SET|EVAL|MULTI|insert|update|delete|HSET|ZADD|DEL|ZREM)/;
const hay = (ops, re) => ops.some((o) => re.test(o.op));
const operaciones = (n) => `${n} ${n === 1 ? 'operación' : 'operaciones'}`;

// Una frase corta que cuenta qué hizo el motor en este pedido
export function frase(motor, ops, cuerpo = {}) {
	const c = cuerpo ?? {};
	switch (motor) {
		case 'redis':
			if (c.sesionReutilizada) return 'Reutilizó la sesión de este dispositivo';
			if (c.idSesion && 'sesionReutilizada' in c) return 'Reservó un lugar en el cupo de pantallas';
			if (c.checkpoint) return 'Guardó el segundo exacto (continuar viendo)';
			if (c.siguiente !== undefined && c.finalizado) return 'Movió "continuar viendo" al episodio siguiente';
			if (c.cerradas !== undefined || c.cerrada !== undefined) return 'Cerró sesiones y liberó el cupo';
			if (c.estado === 'retirado' || c.retirados) return 'Borró el "continuar viendo" de todos los perfiles y marcó el retiro';
			if (!hay(ops, ESCRITURA)) return 'Leyó sesiones y "continuar viendo"';
			break;
		case 'cassandra':
			if (hay(ops, /^(INSERT|UPDATE|BATCH)/)) return 'Escribió en el historial';
			if (hay(ops, /^DELETE/)) return 'Borró una fila (compensación)';
			if (hay(ops, /^SELECT/)) return 'Leyó el historial por perfil y mes';
			break;
		case 'neo4j':
			if (ops.some((o) => /^(MERGE|CREATE)/.test(o.op) && /VIO/.test(o.detalle))) return 'Registró la señal VIO (para recomendar)';
			if (hay(ops, /^(CREATE|MERGE)/)) return 'Creó nodos y relaciones';
			if (ops.some((o) => /\b(SET|DELETE)\b/.test(o.detalle) && !/^RETURN/.test(o.op))) return 'Actualizó el grafo';
			if (hay(ops, /^(MATCH|OPTIONAL|WITH|UNWIND|CALL)/)) return 'Recorrió el grafo (vínculos, elenco, géneros)';
			break;
		case 'mongo':
			if (ops.some((o) => /^(update|insert|delete)$/.test(o.op) && /^contenidos/.test(o.detalle))) return 'Actualizó el catálogo';
			if (hay(ops, /^(find|aggregate|count)/)) return 'Leyó fichas y perfiles';
			break;
		case 'postgres':
			if (hay(ops, /^UPDATE/)) return 'Cambió el estado de licencias';
			if (hay(ops, /^SELECT/)) return 'Consultó licencias vigentes';
			break;
	}
	return operaciones(ops.length);
}

function resultado({ status, cuerpo, traza }) {
	const saga = traza?.saga;
	if (status >= 400 || !status) {
		const motivo = esc(String(cuerpo?.error ?? `Error ${status}`).replace(/\.$/, ''));
		if (saga?.estado === 'compensada') return `<div class="resultado mal">✕ ${motivo}. La saga se compensó: los motores quedaron como antes.</div>`;
		return `<div class="resultado mal">✕ ${motivo}</div>`;
	}
	const c = cuerpo ?? {};
	if (c.checkpoint === 'guardado') return `<div class="resultado ok">✓ Reporte n.º ${c.reporte}: Redis guardó el segundo y, como tocaba checkpoint, también Cassandra</div>`;
	if (c.checkpoint === 'no_corresponde') return `<div class="resultado ok">✓ Reporte n.º ${c.reporte}: solo Redis. Cassandra guarda un checkpoint cada 6 reportes (próximo: n.º ${Math.ceil(c.reporte / 6) * 6 || 6})</div>`;
	if (c.checkpoint === 'fallido') return `<div class="resultado mal">Reporte n.º ${c.reporte}: Redis lo guardó, pero el checkpoint en Cassandra falló. El próximo lo corrige</div>`;
	if (saga?.estado === 'completada') return `<div class="resultado ok">✓ Saga completada: ${saga.pasos.length} pasos, cada uno en su motor</div>`;
	return `<div class="resultado ok">✓ Listo · ${traza?.ms ?? '?'} ms</div>`;
}

function htmlSaga(saga) {
	if (!saga) return '';
	const marca = { hecho: '✓ hecho', fallido: '✕ falló', compensado: '↺ compensado', pendiente: '· no llegó a ejecutarse' };
	const motorDe = (paso) => Object.values(PASOS).find((p) => p[paso])?.[paso];
	const pasos = saga.pasos.map((p) => {
		const m = motorDe(p.nombre);
		return `<li class="${p.estado}"><b>${esc(p.nombre)}</b>${m ? ` <span class="suave">(${MOTORES[m]})</span>` : ''} — ${marca[p.estado] ?? esc(p.estado)}</li>`;
	}).join('');
	return `<div class="saga"><b>Saga ${esc(saga.tipo)}</b> · ${esc(saga.estado)} <span class="suave">(log en MongoDB)</span><ol>${pasos}</ol></div>`;
}

function htmlDetalle(ops) {
	if (!ops.length) return '';
	const items = ops.map((o) => `<li><span class="pildora m-${o.motor}">${MOTORES[o.motor]}</span> <b>${esc(o.op)}</b>`
		+ ` <span class="suave">${o.ms ?? '?'} ms${o.fondo ? ' · proceso de fondo' : ''}${o.log ? ' · log de saga' : ''}</span>`
		+ `${o.error ? ` <span class="error-texto">✕ ${esc(o.error)}</span>` : ''}<pre>${esc(o.detalle)}</pre></li>`).join('');
	return `<details class="detalle"><summary>Ver las ${ops.length} operaciones exactas, en orden</summary><ol>${items}</ol></details>`;
}

export function mostrarClic(accion, r) {
	const ops = r.traza?.ops ?? [];
	const motores = ORDEN.map((m) => {
		const propias = ops.filter((o) => o.motor === m && !o.log);
		const on = propias.length > 0;
		return `<div class="motor ${on ? 'on' : ''}">
			<span class="punto m-${m}"></span>
			<div><div class="nombre">${MOTORES[m]}</div>
			<div class="frase">${on ? esc(frase(m, propias, r.cuerpo)) : `<span class="suave">${ROL[m]}</span>`}</div>
			${on ? `<div class="cuantas">${operaciones(propias.length)}</div>` : ''}</div>
		</div>`;
	}).join('');
	document.getElementById('motores').innerHTML = `
		<h4>Qué pasó con tu último clic</h4>
		<div class="accion">${esc(accion)}</div>
		${resultado(r)}
		${motores}
		${htmlSaga(r.traza?.saga)}
		${htmlDetalle(ops)}`;
}
