import db from '../db/mongo.js';
import { nuevoId } from './ids.js';
import { ErroresApp } from './errores.js';

const ahora = () => new Date();
const esObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export async function ejecutarSaga({ tipo, pasos, fallarEn, datos = {} }) {
	const nombres = pasos.map((p) => p.nombre);
	if (fallarEn && !nombres.includes(fallarEn)) {
		throw new ErroresApp(`fallarEn="${fallarEn}" no es un paso de ${tipo}`, 400, { pasos: nombres });
	}

	const sagas = db.collection('sagas');
	const idSaga = nuevoId();

	// 1. Registrar la saga ANTES de escribir nada
	await sagas.insertOne({
		_id: idSaga, tipo, estado: 'en_curso', datos,
		pasos: nombres.map((nombre) => ({ nombre, estado: 'pendiente' })),
		creadaEn: ahora(), actualizadaEn: ahora(),
	});

	const actualizar = (cambios) =>
		sagas.updateOne({ _id: idSaga }, { $set: { ...cambios, actualizadaEn: ahora() } });

	const marcarPaso = (i, estado, extra = {}) => {
		const cambios = { [`pasos.${i}.estado`]: estado };
		for (const [campo, valor] of Object.entries(extra)) cambios[`pasos.${i}.${campo}`] = valor;
		return actualizar(cambios);
	};

	// 2. Ejecutar los pasos en orden
	const hechos = []; // { i, resultado } de cada paso completado
	let i = 0;
	try {
		for (; i < pasos.length; i++) {
			if (fallarEn === pasos[i].nombre) {
				throw new ErroresApp(`Falla provocada en "${pasos[i].nombre}"`, 500);
			}
			// Lo que devuelve ejecutar() se guarda y después se le pasa a compensar()
			// (ej. en P4: el "continuar viendo" anterior, para poder restaurarlo)
			const resultado = await pasos[i].ejecutar();
			hechos.push({ i, resultado });
			await marcarPaso(i, 'hecho', esObjeto(resultado) ? { datos: resultado } : {});
		}

		await actualizar({ estado: 'completada' });
		return { idSaga, estado: 'completada' };
	} catch (error) {
		// 3. Falló el paso i: compensar los completados, en orden inverso
		await marcarPaso(i, 'fallido', { error: error.message });
		await actualizar({ estado: 'compensando' });

		const compensados = [];
		const sinCompensar = [];
		for (const { i: j, resultado } of hechos.reverse()) {
			try {
				await pasos[j].compensar(resultado);
				await marcarPaso(j, 'compensado');
				compensados.push(pasos[j].nombre);
			} catch (errorCompensacion) {
				// Se sigue con las demás: mejor dejar el menor desorden posible
				await marcarPaso(j, 'fallido', { error: `compensación: ${errorCompensacion.message}` });
				sinCompensar.push(pasos[j].nombre);
			}
		}

		const detalle = { pasoFallido: pasos[i].nombre, motivo: error.message, compensados };
		let errorFinal;

		if (sinCompensar.length) {
			// El peor caso: quedó inconsistente y hay que revisarlo a mano
			await actualizar({ estado: 'fallida' });
			errorFinal = new ErroresApp(
				`${tipo} falló en "${pasos[i].nombre}" y NO se pudo revertir del todo: revisar la saga`,
				500, { ...detalle, sinCompensar });
		} else {
			await actualizar({ estado: 'compensada' });
			errorFinal = error instanceof ErroresApp && error.status < 500
				? Object.assign(error, { detalle: { ...error.detalle, ...detalle } })
				: new ErroresApp(`${tipo} falló en "${pasos[i].nombre}" y se revirtió`, error.status ?? 500, detalle);
		}

		errorFinal.idSaga = idSaga;
		throw errorFinal;
	}
}