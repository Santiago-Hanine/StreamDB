// Consola de motores: una pestaña por motor con su historial.
import { registrar } from './router.js';
import { esc, MOTORES } from './util.js';
import { resaltar } from './resaltado.js';

const API = '/demo/api/consola';
const LIMITE_MS = 45000; // el servidor corta a los 20 s, pero abrir la shell también tarda
const MAX_LINEAS = 200;

const SHELL = {
	mongo: { prompt: 'streamdb>', detalle: 'mongosh dentro del contenedor mongo · base streamdb', ejemplo: 'db.contenidos.findOne()' },
	cassandra: { prompt: 'cqlsh:streamdb>', detalle: 'cqlsh dentro del contenedor cassandra · keyspace streamdb', ejemplo: 'DESCRIBE TABLES' },
	neo4j: { prompt: 'neo4j@neo4j>', detalle: 'Cypher por el driver (Bolt), con la salida de cypher-shell', ejemplo: 'MATCH (g:Genero) RETURN g.nombre LIMIT 5' },
	redis: { prompt: '127.0.0.1:6379>', detalle: 'redis-cli dentro del contenedor redis', ejemplo: 'SCAN 0 COUNT 10' },
	postgres: { prompt: 'streamdb=>', detalle: 'psql dentro del contenedor postgres · base streamdb', ejemplo: '\\dt' },
};

// Se pierde al recargar
const sesiones = Object.fromEntries(Object.keys(SHELL).map((m) => [m, { lineas: [], historial: [], indice: 0, borrador: '', prompt: SHELL[m].prompt, ocupada: false }]));
let motor = 'mongo';

export function nuevoPrompt(m, comando, { salida, error }) {
	if (error) return null;
	if (m === 'mongo') return salida.match(/^switched to db (\S+)/)?.[1]?.concat('>') ?? null;
	if (m === 'cassandra') {
		const ks = comando.trim().match(/^use\s+"?(\w+)"?\s*;?$/i)?.[1];
		return ks ? `cqlsh:${ks}>` : null;
	}
	return null;
}

registrar('consola', (vista) => {
	document.body.classList.add('consola-activa');
	window.addEventListener('antes-de-pintar', () => document.body.classList.remove('consola-activa'), { once: true });
	vista.innerHTML = `<div class="consola">
		<div class="pestanas">${Object.keys(SHELL).map((m) => `<button class="pestana p-${m}" data-motor="${m}">${MOTORES[m]}</button>`).join('')}</div>
		<div class="herramientas">
			<span class="suave" id="detalle"></span>
			<span class="suave atajos">Enter ejecuta · Shift+Enter nueva línea · ↑↓ historial · Ctrl+L limpia</span>
			<button class="boton chico" id="limpiar">Limpiar</button>
			<button class="boton chico" id="reiniciar-shell" title="Cierra la shell; el próximo comando abre una nueva">Reiniciar shell</button>
		</div>
		<div class="pantalla" id="pantalla">
			<div id="lineas"></div>
			<div class="linea-input">
				<span class="prompt" id="prompt"></span>
				<div class="editor">
					<pre class="resaltado" aria-hidden="true"></pre>
					<textarea id="entrada" rows="1" spellcheck="false" autocomplete="off" autocapitalize="off" aria-label="Comando"></textarea>
				</div>
			</div>
		</div>
	</div>`;

	const pantalla = vista.querySelector('#pantalla');
	const lineas = vista.querySelector('#lineas');
	const entrada = vista.querySelector('#entrada');
	const resaltado = vista.querySelector('.resaltado');
	const s = () => sesiones[motor];

	const pintarEntrada = () => { resaltado.innerHTML = resaltar(motor, entrada.value) + '\n'; };
	const alFinal = () => { pantalla.scrollTop = pantalla.scrollHeight; };

	const htmlLinea = (m, l) => {
		if (l.nota) return `<div class="bloque"><pre class="salida suave">${esc(l.nota)}</pre></div>`;
		return `<div class="bloque">
			<div class="cmd"><span class="prompt">${esc(l.prompt)}</span><pre>${resaltar(m, l.comando)}</pre>${l.ms !== undefined ? `<span class="ms">${l.ms} ms</span>` : ''}</div>
			${l.pendiente ? '<pre class="salida suave">…</pre>' : l.salida ? `<pre class="salida ${l.error ? 'error' : ''}">${esc(l.salida)}</pre>` : ''}
		</div>`;
	};

	const pintarLineas = () => {
		const ses = s();
		lineas.innerHTML = ses.lineas.length ? ses.lineas.map((l) => htmlLinea(motor, l)).join('')
			: `<p class="suave">${esc(SHELL[motor].detalle)}. Probá con <code>${esc(SHELL[motor].ejemplo)}</code></p>`;
		vista.querySelector('#prompt').textContent = ses.prompt;
		entrada.readOnly = ses.ocupada;
		alFinal();
	};

	const elegir = (m) => {
		s().borrador = entrada.value;
		motor = m;
		vista.querySelectorAll('.pestana').forEach((b) => b.classList.toggle('activa', b.dataset.motor === m));
		vista.querySelector('#detalle').textContent = SHELL[m].detalle;
		entrada.value = s().borrador;
		pintarEntrada();
		pintarLineas();
		entrada.focus();
	};

	async function ejecutar() {
		const m = motor, ses = s(), comando = entrada.value;
		if (!comando.trim() || ses.ocupada) return;
		if (ses.historial.at(-1) !== comando) ses.historial.push(comando);
		ses.indice = ses.historial.length;
		ses.borrador = '';
		const linea = { prompt: ses.prompt, comando, pendiente: true };
		ses.lineas.push(linea);
		if (ses.lineas.length > MAX_LINEAS) ses.lineas.shift();
		ses.ocupada = true;
		entrada.value = '';
		pintarEntrada();
		pintarLineas();
		try {
			const r = await fetch(`${API}/${m}`, {
				method: 'POST', headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ comando }), signal: AbortSignal.timeout(LIMITE_MS),
			});
			const cuerpo = await r.json().catch(() => ({}));
			if (!r.ok) Object.assign(linea, { salida: cuerpo.error ?? `Error ${r.status}`, error: true });
			else {
				Object.assign(linea, cuerpo);
				ses.prompt = /Se reinició la shell/.test(cuerpo.salida) ? SHELL[m].prompt : nuevoPrompt(m, comando, cuerpo) ?? ses.prompt;
			}
		} catch (e) {
			Object.assign(linea, { salida: `No se pudo conectar con el servidor: ${e.message}`, error: true });
		}
		linea.pendiente = false;
		ses.ocupada = false;
		if (motor === m && document.body.contains(lineas)) {
			pintarLineas();
			entrada.focus();
		}
	}

	// ↑↓ recorren el historial solo desde la primera / última línea
	function navegar(paso) {
		const ses = s();
		const nuevo = ses.indice + paso;
		if (nuevo < 0 || nuevo > ses.historial.length) return false;
		if (ses.indice === ses.historial.length) ses.borrador = entrada.value;
		ses.indice = nuevo;
		entrada.value = nuevo === ses.historial.length ? ses.borrador : ses.historial[nuevo];
		pintarEntrada();
		const fin = entrada.value.length;
		entrada.setSelectionRange(fin, fin);
		return true;
	}

	entrada.addEventListener('input', pintarEntrada);
	entrada.addEventListener('keydown', (e) => {
		const antes = entrada.value.slice(0, entrada.selectionStart);
		const despues = entrada.value.slice(entrada.selectionEnd);
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			ejecutar();
		} else if (e.key === 'ArrowUp' && !antes.includes('\n')) {
			if (navegar(-1)) e.preventDefault();
		} else if (e.key === 'ArrowDown' && !despues.includes('\n')) {
			if (navegar(1)) e.preventDefault();
		} else if (e.key === 'l' && e.ctrlKey) {
			e.preventDefault();
			s().lineas = [];
			pintarLineas();
		} else if (e.key === 'Tab') {
			e.preventDefault();
			entrada.setRangeText('  ', entrada.selectionStart, entrada.selectionEnd, 'end');
			pintarEntrada();
		}
	});

	// Sin robar el foco si se está seleccionando texto
	pantalla.addEventListener('click', () => { if (!getSelection().toString()) entrada.focus(); });
	vista.querySelectorAll('.pestana').forEach((b) => b.onclick = () => elegir(b.dataset.motor));
	vista.querySelector('#limpiar').onclick = () => { s().lineas = []; pintarLineas(); entrada.focus(); };
	vista.querySelector('#reiniciar-shell').onclick = async () => {
		const m = motor;
		await fetch(`${API}/${m}/reiniciar`, { method: 'POST' }).catch(() => {});
		sesiones[m].prompt = SHELL[m].prompt;
		sesiones[m].lineas.push({ nota: `Shell de ${MOTORES[m]} reiniciada.` });
		if (motor === m) pintarLineas();
		entrada.focus();
	};

	elegir(motor);
});
