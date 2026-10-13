import db from '../db/mongo.js';
import { esId } from '../lib/ids.js';
import { pedidoInvalido, noEncontrado } from '../lib/errores.js';

const LIMITE_POR_DEFECTO = 20;
const LIMITE_MAXIMO = 50;

export async function explorar({ genero, idActor, idPlataforma, idPerfil, limite, pagina } = {}) {

	// 1. Validar la entrada (los query params llegan siempre como texto)
	for (const [nombre, valor] of Object.entries({ idActor, idPlataforma, idPerfil })) {
		if (valor !== undefined && !esId(valor)) throw pedidoInvalido(`${nombre} no es un id válido`);
	}
	limite = Math.min(Math.max(parseInt(limite) || LIMITE_POR_DEFECTO, 1), LIMITE_MAXIMO);
	pagina = Math.max(parseInt(pagina) || 1, 1);

	// 2. Armar el filtro: solo lo publicado, más los filtros que vengan
	const filtro = { estado: 'publicado' };
	if (genero) filtro.generos = genero;
	if (idActor) filtro['elenco.idActor'] = idActor;
	if (idPlataforma) filtro['plataforma.id'] = idPlataforma;

	// 3. Si hay perfil, solo lo apto para su edad
	let perfil = null;
	if (idPerfil) {
		const cuenta = await db.collection('cuentas').findOne(
			{ 'perfiles.id': idPerfil },
			{ projection: { 'perfiles.$': 1 } }, // trae solo el perfil que coincide
		);
		if (!cuenta) throw noEncontrado(`No existe el perfil ${idPerfil}`);
		perfil = cuenta.perfiles[0];
		filtro.clasificacionEdad = { $lte: perfil.clasificacionEdad };
	}

	// 4. Consultar: una sola ida a Mongo trae el total y la página pedida
	const [resultado] = await db.collection('contenidos').aggregate([
		{ $match: filtro },
		{ $sort: { anioEstreno: -1, _id: 1 } },
		{
			$facet: {
				total: [{ $count: 'n' }],
				contenidos: [
					{ $skip: (pagina - 1) * limite },
					{ $limit: limite },
					{
						$project: {
							titulo: 1, tipo: 1, anioEstreno: 1, clasificacionEdad: 1, generos: 1,
							plataforma: '$plataforma.nombre',
							// se cuenta acá: no se guarda en ningún lado ni se traen los episodios
							cantidadEpisodios: {
								$cond: [
									{ $eq: ['$tipo', 'serie'] },
									{ $sum: { $map: { input: '$temporadas', as: 't', in: { $size: '$$t.episodios' } } } },
									null,
								],
							},
						},
					},
				],
			},
		},
	]).toArray();

	// 5. Completar con los otros motores (solo para los contenidos de esta página)
	// TODO Redis: si hay idPerfil, leer cv:{idPerfil}:{idContenido} de cada uno → progreso
	// TODO Neo4j: un solo MATCH con todos los ids de la página → vinculados

	return {
		pagina,
		limite,
		total: resultado.total[0]?.n ?? 0,
		perfil: perfil && { nombre: perfil.nombre, clasificacionEdad: perfil.clasificacionEdad },
		contenidos: resultado.contenidos,
	};
}