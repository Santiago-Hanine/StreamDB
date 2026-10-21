// Inicio: usuario o admin, cuenta, perfil y dispositivo.
import { registrar, ir, icono } from './router.js';
import { estado, guardar } from './estado.js';
import { leer } from './api.js';
import { esc, MOTORES, aviso } from './util.js';

const COLORES_PERFIL = ['#e50914', '#4c8eda', '#3ecf6e', '#f0b429', '#a970ff', '#ff7ab6'];

registrar('inicio', async (vista) => {
	vista.innerHTML = `<div class="centro">
		<div class="logo-grande">StreamDB</div>
		<p class="suave">Una plataforma de streaming con cinco bases de datos trabajando juntas.</p>
		<div class="entradas">
			<div class="entrada" data-modo="usuario"><div class="ic">🍿</div><b>Entrar como usuario</b>
				<span class="suave">Mirar, seguir viendo, recomendaciones y sesiones en varios dispositivos</span></div>
			<div class="entrada" data-modo="admin"><div class="ic">🛠️</div><b>Entrar como admin</b>
				<span class="suave">Cargar series, licencias, sesiones activas y simular fallas</span></div>
		</div>
		<div class="estado-motores" id="estado-motores">${Object.values(MOTORES).map((m) => `<span>${m}</span>`).join('')}</div>
	</div>`;
	vista.querySelectorAll('.entrada').forEach((el) => el.onclick = () => {
		estado.modo = el.dataset.modo;
		guardar();
		ir(estado.modo === 'admin' ? 'admin/catalogo' : 'cuentas');
	});
	try {
		const conectados = await leer('/demo/api/app/motores');
		vista.querySelector('#estado-motores').innerHTML = Object.entries(MOTORES)
			.map(([m, nombre]) => `<span class="${conectados[m] ? 'on' : 'off'}" title="${conectados[m] ? 'conectado' : 'no responde'}">${nombre}</span>`).join('');
	} catch {
		vista.querySelector('#estado-motores').innerHTML = '<span class="off">La API no responde</span>';
	}
});

const filaCuenta = (c) => `<div class="fila-cuenta" data-id="${c.id}">
	<span><b>${esc(c.email)}</b> <span class="suave">· ${c.perfiles.length} perfil${c.perfiles.length === 1 ? '' : 'es'}</span></span>
	<span class="suave">${c.limiteSesiones} pantalla${c.limiteSesiones === 1 ? '' : 's'} a la vez</span></div>`;

registrar('cuentas', async (vista) => {
	estado.modo = 'usuario';
	vista.innerHTML = `<div class="centro">
		<h1>¿Con qué cuenta entrás?</h1>
		<p class="suave">Cuentas del seed. La demo tiene tres perfiles (+18, +13 y +7) y permite 2 pantallas a la vez.</p>
		<input type="search" id="buscar" placeholder="Buscar otra cuenta por email…" style="width:100%">
		<div class="lista-cuentas" id="lista"><p class="vacio">Cargando…</p></div>
	</div>`;
	let cuentas = [];
	const lista = vista.querySelector('#lista');
	const mostrar = async (email = '') => {
		try {
			({ cuentas } = await leer('/demo/api/app/cuentas' + (email ? `?email=${encodeURIComponent(email)}` : '')));
			lista.innerHTML = cuentas.map(filaCuenta).join('') || '<p class="vacio">No hay cuentas activas con ese email.</p>';
		} catch (e) {
			lista.innerHTML = `<p class="error-texto">${esc(e.message)}</p>`;
		}
	};
	lista.onclick = (e) => {
		const fila = e.target.closest('.fila-cuenta');
		if (!fila) return;
		estado.cuenta = cuentas.find((c) => c.id === fila.dataset.id);
		estado.perfil = null;
		guardar();
		ir('quien');
	};
	let espera;
	vista.querySelector('#buscar').oninput = (e) => {
		clearTimeout(espera);
		espera = setTimeout(() => mostrar(e.target.value.trim()), 300);
	};
	await mostrar();
});

registrar('quien', async (vista) => {
	if (!estado.cuenta) return ir('cuentas');
	const perfiles = estado.cuenta.perfiles.map((p, i) => `<div class="perfil ${estado.perfil?.id === p.id ? 'elegido' : ''}" data-id="${p.id}">
		<div class="avatar" style="background:${COLORES_PERFIL[i % COLORES_PERFIL.length]}">${esc(p.nombre[0])}</div>
		${esc(p.nombre)}<br><span class="suave">+${p.clasificacionEdad}</span></div>`).join('');
	vista.innerHTML = `<div class="centro">
		<h1>¿Quién está mirando?</h1>
		<p class="suave">${esc(estado.cuenta.email)} · <a href="#/cuentas"><u>cambiar de cuenta</u></a></p>
		<div class="perfiles">${perfiles}</div>
		<h2>¿Desde qué dispositivo?</h2>
		<p class="suave" id="cupo">&nbsp;</p>
		<div class="dispositivos" id="dispositivos"><p class="vacio">Cargando…</p></div>
		<button class="boton primario" id="entrar" disabled>Entrar</button>
	</div>`;

	const listo = () => { vista.querySelector('#entrar').disabled = !(estado.perfil && estado.dispositivo); };
	vista.querySelector('.perfiles').onclick = (e) => {
		const el = e.target.closest('.perfil');
		if (!el) return;
		estado.perfil = estado.cuenta.perfiles.find((p) => p.id === el.dataset.id);
		vista.querySelectorAll('.perfil').forEach((x) => x.classList.toggle('elegido', x === el));
		listo();
	};
	vista.querySelector('#entrar').onclick = () => { guardar(); ir('home'); };

	try {
		const [{ dispositivos }, sesiones] = await Promise.all([
			leer('/demo/api/app/dispositivos'),
			leer(`/api/v1/cuentas/${estado.cuenta.id}/sesiones`).catch(() => null),
		]);
		estado.dispositivos = dispositivos;
		if (!dispositivos.some((d) => d.id === estado.dispositivo?.id)) estado.dispositivo = null;
		const enUso = new Set(sesiones?.activas.map((s) => s.idDispositivo) ?? []);
		vista.querySelector('#cupo').textContent = sesiones
			? `Pantallas en uso en esta cuenta: ${sesiones.activas.length} de ${sesiones.limiteSesiones}`
			: 'No se pudieron leer las sesiones activas';
		const caja = vista.querySelector('#dispositivos');
		caja.innerHTML = dispositivos.map((d) => `<div class="dispositivo ${enUso.has(d.id) ? 'en-uso' : ''} ${estado.dispositivo?.id === d.id ? 'elegido' : ''}" data-id="${d.id}">
			<div class="ic">${icono(d.tipo)}</div><b>${esc(d.modelo)}</b><br><span class="suave">${esc(d.sistemaOperativo)}</span>
			${enUso.has(d.id) ? '<div class="en-uso-tag">● mirando ahora</div>' : ''}</div>`).join('');
		caja.onclick = (e) => {
			const el = e.target.closest('.dispositivo');
			if (!el) return;
			estado.dispositivo = dispositivos.find((d) => d.id === el.dataset.id);
			caja.querySelectorAll('.dispositivo').forEach((x) => x.classList.toggle('elegido', x === el));
			listo();
		};
		listo();
	} catch (e) {
		aviso(e.message, 'error');
	}
});
