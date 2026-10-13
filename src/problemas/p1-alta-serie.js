import db from '../db/mongo.js';
import { nuevoId, esId } from '../lib/ids.js';
import { pedidoInvalido } from '../lib/errores.js';
import { ejecutarSaga } from '../lib/saga.js';

const EDADES = [0, 7, 13, 16, 18];
const esEntero = (v, min = 1) => Number.isInteger(v) && v >= min;

// Valida TODO antes de empezar la saga: si la entrada es inválida, no se escribe nada
async function validar(serie) {
	if (!serie || typeof serie !== 'object') throw pedidoInvalido('Falta el body con la serie');

	const errores = [];
	if (!serie.titulo?.trim()) errores.push('titulo es obligatorio');
	if (!EDADES.includes(serie.clasificacionEdad)) errores.push(`clasificacionEdad debe ser una de ${EDADES.join(', ')}`);
	if (serie.anioEstreno !== undefined && !esEntero(serie.anioEstreno, 1888)) errores.push('anioEstreno debe ser un año entero');
	if (!Array.isArray(serie.generos) || !serie.generos.length) errores.push('generos debe tener al menos uno');
	if (!esId(serie.idPlataforma)) errores.push('idPlataforma no es un id válido');
	if (!Array.isArray(serie.elenco)) errores.push('elenco debe ser una lista');
	else if (serie.elenco.some((a) => !esId(a.idActor))) errores.push('hay un idActor inválido en elenco');

	if (!Array.isArray(serie.temporadas) || !serie.temporadas.length) {
		errores.push('temporadas debe tener al menos una');
	} else {
		serie.temporadas.forEach((t, i) => {
			if (!esEntero(t.numero)) errores.push(`temporadas[${i}].numero debe ser un entero >= 1`);
			if (!Array.isArray(t.episodios) || !t.episodios.length) {
				errores.push(`temporadas[${i}] no tiene episodios`);
				return;
			}
			t.episodios.forEach((e, j) => {
				if (!e.titulo?.trim()) errores.push(`temporadas[${i}].episodios[${j}].titulo es obligatorio`);
				if (!esEntero(e.duracionSeg)) errores.push(`temporadas[${i}].episodios[${j}].duracionSeg debe ser un entero > 0`);
			});
		});
	}
	if (errores.length) throw pedidoInvalido('La serie no es válida', errores);

	const contenidos = db.collection('contenidos');

	// La plataforma existe si algún contenido la usa (no hay colección de plataformas)
	const conPlataforma = await contenidos.findOne(
		{ 'plataforma.id': serie.idPlataforma },
		{ projection: { plataforma: 1 } },
	);
	if (!conPlataforma) throw pedidoInvalido(`No existe la plataforma ${serie.idPlataforma}`);

	// Los actores existen y se trae su nombre para la copia del elenco.
	// TODO: cuando esté Neo4j, validar contra Neo4j, que es el dueño de los actores.
	const ids = [...new Set(serie.elenco.map((a) => a.idActor))];
	const actores = await contenidos.aggregate([
		{ $match: { 'elenco.idActor': { $in: ids } } },
		{ $unwind: '$elenco' },
		{ $match: { 'elenco.idActor': { $in: ids } } },
		{ $group: { _id: '$elenco.idActor', nombre: { $first: '$elenco.nombre' } } },
	]).toArray();
	const nombres = new Map(actores.map((a) => [a._id, a.nombre]));
	const faltan = ids.filter((id) => !nombres.has(id));
	if (faltan.length) throw pedidoInvalido('Hay actores que no existen', faltan);

	return { plataforma: conPlataforma.plataforma, nombres };
}

export async function altaSerie(serie, { fallarEn } = {}) {
	const { plataforma, nombres } = await validar(serie);

	// Los IDs se generan UNA vez, antes de la saga: reintentar no crea duplicados
	const id = nuevoId();
	const temporadas = serie.temporadas.map((t) => ({
		numero: t.numero,
		episodios: t.episodios.map((e, i) => ({
			id: nuevoId(),
			numero: i + 1,
			titulo: e.titulo,
			duracionSeg: e.duracionSeg,
		})),
	}));

	const ficha = {
		tipo: 'serie',
		estado: 'borrador', // no aparece en la exploración hasta el paso "publicar"
		titulo: serie.titulo.trim(),
		clasificacionEdad: serie.clasificacionEdad,
		plataforma,
		generos: serie.generos,
		elenco: serie.elenco.map((a) => ({
			idActor: a.idActor,
			nombre: nombres.get(a.idActor),
			...(a.personaje && { personaje: a.personaje }),
		})),
		...(serie.descripcion && { descripcion: serie.descripcion }),
		...(serie.anioEstreno && { anioEstreno: serie.anioEstreno }),
	};

	const contenidos = db.collection('contenidos');

	const { idSaga } = await ejecutarSaga({
		tipo: 'alta_serie',
		fallarEn,
		datos: { idContenido: id, titulo: ficha.titulo },
		pasos: [
			{
				nombre: 'ficha',
				// upsert + $setOnInsert: si se reintenta, no duplica ni pisa nada
				ejecutar: async () => {
					await contenidos.updateOne({ _id: id }, { $setOnInsert: ficha }, { upsert: true });
				},
				compensar: async () => {
					await contenidos.deleteOne({ _id: id, estado: 'borrador' });
				},
			},
			{
				nombre: 'episodios',
				ejecutar: async () => {
					await contenidos.updateOne({ _id: id }, { $set: { temporadas } });
				},
				compensar: async () => {
					await contenidos.updateOne({ _id: id }, { $unset: { temporadas: '' } });
				},
			},
			// TODO Neo4j: pasos "nodo", "elenco" y "vinculos" van acá, antes de publicar
			{
				nombre: 'publicar',
				ejecutar: async () => {
					await contenidos.updateOne({ _id: id }, { $set: { estado: 'publicado' } });
				},
				compensar: async () => {
					await contenidos.updateOne({ _id: id }, { $set: { estado: 'borrador' } });
				},
			},
		],
	});

	const episodios = temporadas.reduce((total, t) => total + t.episodios.length, 0);
	return { idContenido: id, idSaga, estado: 'publicado', episodios };
}