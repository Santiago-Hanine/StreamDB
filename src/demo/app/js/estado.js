// Estado de la app. Se guarda en localStorage salvo la sesión de reproducción.
const CLAVE = 'streamdb-app';

export const estado = {
	modo: null,         // 'usuario' | 'admin'
	cuenta: null,       // { id, email, limiteSesiones, perfiles }
	perfil: null,       // { id, nombre, clasificacionEdad }
	dispositivo: null,  // { id, tipo, modelo, sistemaOperativo }
	dispositivos: [],
	sesion: null, // reproducción en curso
	conservarColumna: false, // la próxima vista no pisa la columna de motores
};

export function guardar() {
	const { sesion, conservarColumna, ...resto } = estado;
	try { localStorage.setItem(CLAVE, JSON.stringify(resto)); } catch { /* sin almacenamiento: se vuelve a elegir */ }
}

export function cargar() {
	try {
		Object.assign(estado, JSON.parse(localStorage.getItem(CLAVE)) ?? {});
	} catch { /* datos viejos o sin acceso: se arranca de cero */ }
}

export function salir() {
	Object.assign(estado, { modo: null, cuenta: null, perfil: null, dispositivo: null, sesion: null });
	guardar();
}
