import db from '../db/mongo.js';
import { cypher } from '../db/neo4j.js';
import { nuevoId, esId } from '../lib/ids.js';
import { pedidoInvalido } from '../lib/errores.js';
import { ejecutarSaga } from '../lib/saga.js';

const EDADES = [0, 7, 13, 16, 18];
// "precuela" se acepta en la entrada, pero se guarda como la secuela al revés
const TIPOS_VINCULO = ['secuela', 'precuela', 'mismo_universo', 'similar'];
const esEntero = (v, min = 1) => Number.isInteger(v) && v >= min;

// Valida TODO antes de empezar la saga: si la entrada es inválida, no se escribe nada
async function validar(serie) {
	if (!serie || typeof serie !== 'object') throw pedidoInvalido('Falta el body con la serie');
	const vinculos = serie.vinculos ?? [];

	const errores = [];
	if (!serie.titulo?.trim()) errores.push('titulo es obligatorio');
	if (!EDADES.includes(serie.clasificacionEdad)) errores.push(`clasificacionEdad debe ser una de ${EDADES.join(', ')}`);
	if (serie.anioEstreno !== undefined && !esEntero(serie.anioEstreno, 1888)) errores.push('anioEstreno debe ser un año entero');
	if (!Array.isArray(serie.generos) || !serie.generos.length) errores.push('generos debe tener al menos uno');
	if (!esId(serie.idPlataforma)) errores.push('idPlataforma no es un id válido');
	if (!Array.isArray(serie.elenco)) errores.push('elenco debe ser una lista');
	else if (serie.elenco.some((a) => !esId(a.idActor))) errores.push('hay un idActor inválido en elenco');

	if (!Array.isArray(vinculos)) {
		errores.push('vinculos debe ser una lista');
	} else {
		vinculos.forEach((v, i) => {
			if (!esId(v.idContenido)) errores.push(`vinculos[${i}].idContenido no es un id válido`);
			if (!TIPOS_VINCULO.includes(v.tipo)) errores.push(`vinculos[${i}].tipo debe ser uno de ${TIPOS_VINCULO.join(', ')}`);
		});
	}

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

	// 2. Que exista todo lo que se referencia, cada cosa en su motor dueño
	// Plataforma (Mongo): existe si algún contenido la usa (no hay colección de plataformas)
	const conPlataforma = await db.collection('contenidos').findOne(
		{ 'plataforma.id': serie.idPlataforma },
		{ projection: { plataforma: 1 } },
	);
	if (!conPlataforma) throw pedidoInvalido(`No existe la plataforma ${serie.idPlataforma}`);

	// Géneros (Neo4j): solo los del catálogo, así no se crean géneros nuevos por error
	const generos = await cypher('MATCH (g:Genero) WHERE g.nombre IN $generos RETURN g.nombre AS nombre', {
		generos: serie.generos,
	});
	const generosExistentes = new Set(generos.map((g) => g.nombre));
	const generosFaltan = serie.generos.filter((g) => !generosExistentes.has(g));
	if (generosFaltan.length) throw pedidoInvalido('Hay géneros que no existen', generosFaltan);

	// Actores (Neo4j, su dueño): se trae el nombre para la copia del elenco en Mongo
	const idsActores = [...new Set(serie.elenco.map((a) => a.idActor))];
	const actores = await cypher(
		`MATCH (a:Actor) WHERE a.id IN $ids RETURN a.id AS id, a.nombre + ' ' + a.apellido AS nombre`,
		{ ids: idsActores },
	);
	const nombres = new Map(actores.map((a) => [a.id, a.nombre]));
	const actoresFaltan = idsActores.filter((id) => !nombres.has(id));
	if (actoresFaltan.length) throw pedidoInvalido('Hay actores que no existen', actoresFaltan);

	// Contenidos vinculados (Neo4j): tienen que existir y no estar retirados
	const idsVinculos = [...new Set(vinculos.map((v) => v.idContenido))];
	const destinos = await cypher(
		`MATCH (c:Contenido) WHERE c.id IN $ids AND c.estado <> 'retirado' RETURN c.id AS id`,
		{ ids: idsVinculos },
	);
	const destinosExistentes = new Set(destinos.map((c) => c.id));
	const vinculosFaltan = idsVinculos.filter((id) => !destinosExistentes.has(id));
	if (vinculosFaltan.length) {
		throw pedidoInvalido('Hay vínculos a contenidos que no existen o están retirados', vinculosFaltan);
	}

	return { plataforma: conPlataforma.plataforma, nombres };
}

export async function altaSerie(serie, { fallarEn } = {}) {
	const { plataforma, nombres } = await validar(serie);

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

	const elenco = serie.elenco.map((a) => ({ idActor: a.idActor, personaje: a.personaje ?? null }));

	// "La nueva es precuela de X" se guarda como "X es secuela de la nueva"
	const vinculos = (serie.vinculos ?? []).map((v) =>
		v.tipo === 'precuela'
			? { idOrigen: v.idContenido, idDestino: id, tipo: 'secuela' }
			: { idOrigen: id, idDestino: v.idContenido, tipo: v.tipo },
	);

	const contenidos = db.collection('contenidos');

	const { idSaga } = await ejecutarSaga({
		tipo: 'alta_serie',
		fallarEn,
		datos: { idContenido: id, titulo: ficha.titulo },
		pasos: [
			{
				nombre: 'ficha', // Mongo
				ejecutar: async () => {
					await contenidos.updateOne({ _id: id }, { $setOnInsert: ficha }, { upsert: true });
				},
				compensar: async () => {
					await contenidos.deleteOne({ _id: id, estado: 'borrador' });
				},
			},
			{
				nombre: 'episodios', // Mongo
				ejecutar: async () => {
					await contenidos.updateOne({ _id: id }, { $set: { temporadas } });
				},
				compensar: async () => {
					await contenidos.updateOne({ _id: id }, { $unset: { temporadas: '' } });
				},
			},
			{
				nombre: 'nodo', // Neo4j: el contenido y sus géneros
				ejecutar: async () => {
					await cypher(
						`MERGE (c:Contenido {id: $id})
                                               SET c.titulo = $titulo, c.tipo = 'serie', c.estado = 'borrador', c.clasificacionEdad = $edad
                                               WITH c UNWIND $generos AS nombre
                                               MATCH (g:Genero {nombre: nombre})
                                               MERGE (c)-[:DE_GENERO]->(g)`,
						{ id, titulo: ficha.titulo, edad: ficha.clasificacionEdad, generos: ficha.generos },
					);
				},
				compensar: async () => {
					await cypher('MATCH (c:Contenido {id: $id}) DETACH DELETE c', { id });
				},
			},
			{
				nombre: 'elenco', // Neo4j
				ejecutar: async () => {
					await cypher(
						`MATCH (c:Contenido {id: $id})
                                               UNWIND $elenco AS e
                                               MATCH (a:Actor {id: e.idActor})
                                               MERGE (a)-[r:ACTUA_EN]->(c) SET r.personaje = e.personaje`,
						{ id, elenco },
					);
				},
				compensar: async () => {
					await cypher('MATCH (:Actor)-[r:ACTUA_EN]->(:Contenido {id: $id}) DELETE r', { id });
				},
			},
			{
				nombre: 'vinculos', // Neo4j
				ejecutar: async () => {
					await cypher(
						`UNWIND $vinculos AS v
                                               MATCH (o:Contenido {id: v.idOrigen}), (d:Contenido {id: v.idDestino})
                                               MERGE (o)-[r:RELACIONADO]->(d) SET r.tipo = v.tipo`,
						{ vinculos },
					);
				},
				compensar: async () => {
					// Solo los vínculos de esta serie: es nueva, no tenía otros
					await cypher('MATCH (:Contenido {id: $id})-[r:RELACIONADO]-() DELETE r', { id });
				},
			},
			{
				nombre: 'publicar', // Neo4j y por último Mongo: recién acá se vuelve visible
				ejecutar: async () => {
					await cypher(`MATCH (c:Contenido {id: $id}) SET c.estado = 'publicado'`, { id });
					await contenidos.updateOne({ _id: id }, { $set: { estado: 'publicado' } });
				},
				compensar: async () => {
					await contenidos.updateOne({ _id: id }, { $set: { estado: 'borrador' } });
					await cypher(`MATCH (c:Contenido {id: $id}) SET c.estado = 'borrador'`, { id });
				},
			},
		],
	});

	const episodios = temporadas.reduce((total, t) => total + t.episodios.length, 0);
	return { idContenido: id, idSaga, estado: 'publicado', episodios, actores: elenco.length, vinculos: vinculos.length };
}