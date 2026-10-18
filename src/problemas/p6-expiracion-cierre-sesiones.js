import db from '../db/mongo.js';
import { redis } from '../db/redis.js';
import { cassandraClient } from '../db/cassandra.js';

import { esId } from '../lib/ids.js';
import { pedidoInvalido, noEncontrado } from '../lib/errores.js';
import { claves } from './p2-inicio-reproduccion-sesiones.js';

// Cada cuánto corre el barrido de respaldo (por si el listener de expiraciones estuvo caído)
export const BARRIDO_CADA_MS = 30_000;
const CIERRES_PENDIENTES = 'cierres_pendientes'; // LIST: cierres que no se pudieron registrar en Cassandra

const mesDe = (fecha) => fecha.toISOString().slice(0, 7);

// Redis consultas:

// Cierra sesiones en una sola operación atómica, en tres modos:
//   'cuenta'   → todas las de la cuenta (cierre remoto): al terminar el cupo queda vacío, de inmediato
//   'ids'      → las sesiones indicadas (cierre manual desde el dispositivo)
//   'vencidas' → las indicadas, pero solo si su vida ya expiró (listener y barrido)
// Por cada una: la saca del cupo, de "viendo ahora" y del dispositivo, y borra sus datos.
// Devuelve los datos de cada sesión cerrada, para registrar el cierre en Cassandra.
// Las claves se arman acá adentro con los mismos prefijos que `claves` (un solo nodo de Redis,
// igual que el resto del TPO; en un cluster habría que agruparlas con hash tags).
const CERRAR = `
local modo = ARGV[1]
local ids = {}
if modo == 'cuenta' then ids = redis.call('ZRANGE', KEYS[1], 0, -1)
else for i = 2, #ARGV do ids[#ids + 1] = ARGV[i] end end
local cerradas = {}
for _, id in ipairs(ids) do
  local vive = redis.call('EXISTS', 'vida:' .. id) == 1
  if not (modo == 'vencidas' and vive) then
    local datos = redis.call('HGETALL', 'sesion:' .. id)
    if #datos > 0 then
      local h = {}
      for i = 1, #datos, 2 do h[datos[i]] = datos[i + 1] end
      redis.call('ZREM', 'cupo:' .. h.idCuenta, id)
      redis.call('ZREM', 'viendo:' .. h.idContenido, id)
      if redis.call('GET', 'disp:' .. h.idDispositivo) == id then redis.call('DEL', 'disp:' .. h.idDispositivo) end
      redis.call('DEL', 'sesion:' .. id, 'vida:' .. id)
      cerradas[#cerradas + 1] = { id, vive and '1' or '0', datos }
    end
  end
end
if modo == 'cuenta' then redis.call('DEL', KEYS[1]) end
return cerradas`;

// Cassandra consultas:

const REGISTRAR_SESION = `INSERT INTO sesiones_por_cuenta
  (id_cuenta, fecha_inicio, id_sesion, id_perfil, id_dispositivo, fecha_fin, motivo_cierre)
  VALUES (?, ?, ?, ?, ?, ?, ?)`;
// Checkpoint final de la visualización en curso (P3 lo hace cada N reportes: así no se pierde el último tramo)
const CHECKPOINT_POR_PERFIL = `UPDATE historial_por_perfil SET posicion_seg = ?, fecha_fin = ?
  WHERE id_perfil = ? AND mes = ? AND fecha = ? AND id_visualizacion = ?`;
const CHECKPOINT_POR_CONTENIDO = `UPDATE historial_por_contenido SET posicion_seg = ?, fecha_fin = ?
  WHERE id_contenido = ? AND fecha = ? AND id_visualizacion = ?`;
const HISTORIAL_SESIONES = `SELECT fecha_inicio, id_sesion, id_perfil, id_dispositivo, fecha_fin, motivo_cierre
  FROM sesiones_por_cuenta WHERE id_cuenta = ? LIMIT ?`;

// ─── Cierre y registro ────────────────────────────────────────────────────────

// Arma el registro de cada sesión cerrada a partir de lo que devolvió el Lua
function aRegistros(cerradas, motivo) {
	const ahora = new Date();
	return cerradas.map(([idSesion, vivia, datos]) => {
		const s = {};
		for (let i = 0; i < datos.length; i += 2) s[datos[i]] = datos[i + 1];
		// En el cierre remoto, una sesión que ya había vencido (y nadie llegó a cerrar) se registra como expirada
		const motivoReal = motivo === 'cierre_remoto' && vivia === '0' ? 'expirada' : motivo;
		// Una sesión que expiró terminó con su última actividad, no cuando se la detectó
		const fechaFin = motivoReal === 'expirada' ? (s.ultimaActividad ?? s.fechaInicio) : ahora.toISOString();
		return { idSesion, motivo: motivoReal, fechaFin, sesion: s };
	});
}

// Registra en Cassandra cada cierre (idempotente: todo es por clave exacta).
// Si Cassandra falla, el cierre ya está hecho en Redis (el cupo se liberó, que es lo que importa):
// el registro queda en una lista pendiente que el barrido reintenta, así no se pierde.
async function registrarCierre({ idSesion, motivo, fechaFin, sesion: s }) {
	const fin = new Date(fechaFin);
	const consultas = [{
		query: REGISTRAR_SESION,
		params: [s.idCuenta, new Date(s.inicioSesion ?? s.fechaInicio), idSesion, s.idPerfil, s.idDispositivo, fin, motivo],
	}];
	// Si había una visualización a medias (no terminada por P4), se guarda su último punto
	if (s.idVisualizacion && s.posicionSeg !== undefined && s.finalizada !== s.idVisualizacion) {
		const inicio = new Date(s.fechaInicio);
		const posicion = Number(s.posicionSeg);
		consultas.push(
			{ query: CHECKPOINT_POR_PERFIL, params: [posicion, fin, s.idPerfil, mesDe(inicio), inicio, s.idVisualizacion] },
			{ query: CHECKPOINT_POR_CONTENIDO, params: [posicion, fin, s.idContenido, inicio, s.idVisualizacion] },
		);
	}
	await cassandraClient.batch(consultas, { prepare: true, logged: true });
}

async function registrar(registros) {
	let pendientes = 0;
	for (const r of registros) {
		try {
			await registrarCierre(r);
		} catch (error) {
			console.error(`P6: no se pudo registrar el cierre de ${r.idSesion} en Cassandra (queda pendiente):`, error.message);
			await redis.rPush(CIERRES_PENDIENTES, JSON.stringify(r));
			pendientes++;
		}
	}
	return pendientes;
}

async function cerrar(modo, { cupo, ids = [] }, motivo) {
	const cerradas = await redis.eval(CERRAR, { keys: cupo ? [cupo] : [], arguments: [modo, ...ids] });
	const registros = aRegistros(cerradas, motivo);
	const pendientesDeRegistrar = await registrar(registros);
	return { registros, pendientesDeRegistrar };
}

const resumen = (r) => ({
	idSesion: r.idSesion, idPerfil: r.sesion.idPerfil, idDispositivo: r.sesion.idDispositivo,
	idContenido: r.sesion.idContenido, motivo: r.motivo, fechaFin: r.fechaFin,
});

// ─── Cierre manual (el dispositivo cierra su sesión) ──────────────────────────

export async function cerrarSesion(idSesion) {
	if (!esId(idSesion)) throw pedidoInvalido('idSesion no es un id válido');
	const { registros, pendientesDeRegistrar } = await cerrar('ids', { ids: [idSesion] }, 'manual');
	// Cerrar una sesión que ya no existe no es un error: el resultado es el mismo (idempotente)
	return { idSesion, cerrada: registros.length === 1, sesion: registros[0] ? resumen(registros[0]) : null, pendientesDeRegistrar };
}

// ─── Cierre remoto (el titular cierra todas las sesiones de la cuenta) ────────

async function cuentaExiste(idCuenta) {
	if (!esId(idCuenta)) throw pedidoInvalido('idCuenta no es un id válido');
	const cuenta = await db.collection('cuentas').findOne({ _id: idCuenta }, { projection: { limiteSesiones: 1 } });
	if (!cuenta) throw noEncontrado(`No existe la cuenta ${idCuenta}`);
	return cuenta;
}

export async function cerrarSesionesDeCuenta(idCuenta) {
	const cuenta = await cuentaExiste(idCuenta);
	const { registros, pendientesDeRegistrar } = await cerrar('cuenta', { cupo: claves.cupo(idCuenta) }, 'cierre_remoto');
	return {
		idCuenta,
		cerradas: registros.length,
		sesiones: registros.map(resumen),
		lugaresLibres: cuenta.limiteSesiones, // el cupo quedó vacío en la misma operación
		pendientesDeRegistrar,
	};
}

// ─── Sesiones de una cuenta: activas (Redis) + historial (Cassandra) ──────────

export async function sesionesDeCuenta(idCuenta, { limite } = {}) {
	const cuenta = await cuentaExiste(idCuenta);
	limite = Math.min(Math.max(parseInt(limite) || 20, 1), 100);

	const ids = await redis.zRange(claves.cupo(idCuenta), 0, -1);
	const activas = [];
	for (const id of ids) {
		const [s, vida] = await Promise.all([redis.hGetAll(claves.sesion(id)), redis.ttl(claves.vida(id))]);
		if (!s.idPerfil || vida < 0) continue; // vencida y todavía sin cerrar: no cuenta como activa
		activas.push({
			idSesion: id, idPerfil: s.idPerfil, idDispositivo: s.idDispositivo, idContenido: s.idContenido,
			inicioSesion: s.inicioSesion ?? s.fechaInicio, ultimaActividad: s.ultimaActividad ?? null, expiraEnSeg: vida,
		});
	}

	const { rows } = await cassandraClient.execute(HISTORIAL_SESIONES, [idCuenta, limite], { prepare: true });
	const historial = rows.map((f) => ({
		idSesion: f.id_sesion.toString(), idPerfil: f.id_perfil.toString(), idDispositivo: f.id_dispositivo.toString(),
		inicioSesion: f.fecha_inicio, fechaFin: f.fecha_fin, motivoCierre: f.motivo_cierre,
	}));

	return { idCuenta, limiteSesiones: cuenta.limiteSesiones, activas, historial };
}

// ─── Expiración automática: listener + barrido de respaldo ────────────────────

// Busca sesiones cuyos datos siguen pero su vida ya expiró, y las cierra. Reintenta registros pendientes.
export async function barrer() {
	const vencidas = [];
	for await (const lote of redis.scanIterator({ MATCH: 'sesion:*', COUNT: 500 })) {
		for (const clave of [].concat(lote)) {
			const id = clave.slice('sesion:'.length);
			if (!(await redis.exists(claves.vida(id)))) vencidas.push(id);
		}
	}
	let cerradas = 0;
	for (let i = 0; i < vencidas.length; i += 100) {
		const { registros } = await cerrar('vencidas', { ids: vencidas.slice(i, i + 100) }, 'expirada');
		cerradas += registros.length;
	}

	let reintentados = 0;
	for (let i = await redis.lLen(CIERRES_PENDIENTES); i > 0; i--) {
		const pendiente = await redis.lPop(CIERRES_PENDIENTES);
		if (!pendiente) break;
		try {
			await registrarCierre(JSON.parse(pendiente));
			reintentados++;
		} catch {
			await redis.rPush(CIERRES_PENDIENTES, pendiente); // Cassandra sigue caída: se reintenta en la próxima vuelta
			break;
		}
	}
	return { cerradas, reintentados };
}

// Redis avisa cuando expira una clave (keyspace notifications). Al expirar vida:{id}, se cierra esa sesión.
// Necesita una conexión aparte: una conexión suscripta no puede mandar otros comandos.
export async function iniciarVigilancia() {
	await redis.configSet('notify-keyspace-events', 'Ex');
	const suscriptor = redis.duplicate();
	suscriptor.on('error', (error) => console.error('Redis (suscriptor):', error.message));
	await suscriptor.connect();

	await suscriptor.subscribe('__keyevent@0__:expired', async (clave) => {
		if (!clave.startsWith('vida:')) return;
		const id = clave.slice('vida:'.length);
		try {
			const { registros } = await cerrar('vencidas', { ids: [id] }, 'expirada');
			if (registros.length) console.log(`P6: sesión ${id} expirada y cerrada`);
		} catch (error) {
			console.error(`P6: no se pudo cerrar la sesión expirada ${id} (la cierra el barrido):`, error.message);
		}
	});

	const correrBarrido = () => barrer()
		.then(({ cerradas, reintentados }) => {
			if (cerradas || reintentados) console.log(`P6 barrido: ${cerradas} sesiones vencidas cerradas, ${reintentados} registros reintentados`);
		})
		.catch((error) => console.error('P6 barrido:', error.message));
	await correrBarrido(); // al arrancar: lo que haya vencido mientras la API estaba apagada
	const intervalo = setInterval(correrBarrido, BARRIDO_CADA_MS);

	return async () => {
		clearInterval(intervalo);
		await suscriptor.quit().catch(() => { });
	};
}
