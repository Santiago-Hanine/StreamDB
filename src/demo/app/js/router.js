// Enrutado por hash (#/inicio, #/home, #/admin/licencias…) y barra superior.
import { estado, cargar, guardar, salir } from './estado.js';
import { esc } from './util.js';

const rutas = new Map(); // nombre → { render, requiere }

// requiere: 'usuario' (cuenta, perfil y dispositivo elegidos) | 'admin' | null
export function registrar(nombre, render, requiere = null) {
	rutas.set(nombre, { render, requiere });
}

export function ir(ruta) {
	if (location.hash === '#/' + ruta) pintar();
	else location.hash = '#/' + ruta;
}

const listo = {
	usuario: () => estado.modo === 'usuario' && estado.cuenta && estado.perfil && estado.dispositivo,
	admin: () => estado.modo === 'admin',
};

export async function pintar() {
	const [nombre, ...params] = location.hash.replace(/^#\/?/, '').split('/');
	const ruta = rutas.get(nombre === 'admin' ? `admin/${params[0] ?? 'catalogo'}` : nombre);
	if (!ruta || (ruta.requiere && !listo[ruta.requiere]())) return ir('inicio');
	pintarBarra(nombre === 'admin' ? `admin/${params[0] ?? 'catalogo'}` : nombre);
	const vista = document.getElementById('vista');
	vista.innerHTML = '';
	vista.scrollTop = 0;
	await ruta.render(vista, params);
}

// ─── Barra superior ───────────────────────────────────────────────────────────

const ICONO = { tv: '📺', movil: '📱', web: '💻', consola: '🎮', tablet: '📲' };
export const icono = (tipo) => ICONO[tipo] ?? '🖥️';

function pintarBarra(actual) {
	const barra = document.getElementById('barra');
	const link = (ruta, texto) => `<a href="#/${ruta}" class="${actual === ruta ? 'activo' : ''}">${texto}</a>`;
	const logo = '<a href="#/inicio" class="logo">StreamDB</a>';

	if (estado.modo === 'usuario' && listo.usuario()) {
		const perfiles = estado.cuenta.perfiles.map((p) =>
			`<option value="${p.id}" ${p.id === estado.perfil.id ? 'selected' : ''}>${esc(p.nombre)} · +${p.clasificacionEdad}</option>`).join('');
		const dispositivos = estado.dispositivos.map((d) =>
			`<option value="${d.id}" ${d.id === estado.dispositivo.id ? 'selected' : ''}>${icono(d.tipo)} ${esc(d.modelo)}</option>`).join('');
		barra.innerHTML = `${logo}<nav>${link('home', 'Inicio')}${link('explorar', 'Explorar')}${link('actividad', 'Mi actividad')}</nav>
			<div class="selectores">
				<label title="Perfil">👤 <select id="sel-perfil">${perfiles}</select></label>
				<label title="Dispositivo"><select id="sel-dispositivo">${dispositivos}</select></label>
				<span class="cuenta" title="Cuenta">${esc(estado.cuenta.email)}</span>
				<button class="boton chico" id="a-admin">Admin</button>
				<button class="boton chico" id="salir">Salir</button>
			</div>`;
		barra.querySelector('#a-admin').onclick = () => { estado.modo = 'admin'; guardar(); ir('admin/catalogo'); };
		barra.querySelector('#sel-perfil').onchange = (e) => {
			estado.perfil = estado.cuenta.perfiles.find((p) => p.id === e.target.value);
			guardar(); pintar();
		};
		barra.querySelector('#sel-dispositivo').onchange = (e) => {
			estado.dispositivo = estado.dispositivos.find((d) => d.id === e.target.value);
			guardar(); pintar();
		};
	} else if (estado.modo === 'admin') {
		barra.innerHTML = `${logo}<span class="etiqueta-admin">Admin</span>
			<nav>${link('admin/catalogo', 'Catálogo')}${link('admin/licencias', 'Licencias')}${link('admin/sesiones', 'Sesiones activas')}${link('admin/fallas', 'Fallas')}</nav>
			<div class="selectores"><button class="boton chico" id="reiniciar">Reiniciar demo</button>
				<button class="boton chico" id="a-usuario">Vista usuario ↩</button><button class="boton chico" id="salir">Salir</button></div>`;
		// Vuelve con la cuenta, el perfil y el dispositivo que se habían elegido (si los hay)
		barra.querySelector('#a-usuario').onclick = () => {
			estado.modo = 'usuario';
			guardar();
			ir(estado.cuenta && estado.perfil && estado.dispositivo ? 'home' : 'cuentas');
		};
	} else {
		barra.innerHTML = logo;
	}
	barra.querySelector('#salir')?.addEventListener('click', () => { salir(); ir('inicio'); });
}

export function arrancar() {
	cargar();
	window.addEventListener('hashchange', pintar);
	pintar();
}
