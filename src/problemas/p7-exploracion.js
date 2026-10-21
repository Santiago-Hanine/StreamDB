import db from '../db/mongo.js';
import { cypher } from '../db/neo4j.js';
import { redis } from '../db/redis.js';
import { claves } from './p2-inicio-reproduccion-sesiones.js';
import { esId } from '../lib/ids.js';
import { pedidoInvalido, noEncontrado } from '../lib/errores.js';

const LIMITE_POR_DEFECTO = 20;
const LIMITE_MAXIMO = 50;

async function buscarVinculados(ids, edadMaxima) {
	const filas = await cypher(
		`MATCH (c:Contenido) WHERE c.id IN $ids
               OPTIONAL MATCH (c)-[r:RELACIONADO]-(o:Contenido)
               WHERE o.estado = 'publicado' AND ($edad IS NULL OR o.clasificacionEdad <= $edad)
               RETURN c.id AS id, collect(CASE WHEN o IS NULL THEN null ELSE {
                 id: o.id,
                 titulo: o.titulo,
                 relacion: CASE WHEN r.tipo = 'secuela' AND startNode(r) = c THEN 'precuela' ELSE r.tipo END
               } END) AS vinculados`,
		{ ids, edad: edadMaxima ?? null },
	);
	return new Map(filas.map((f) => [f.id, f.vinculados]));
}

export async function explorar({ genero, idActor, idPlataforma, idPerfil, limite, pagina } = {}) {
	// Los query params llegan como texto
	for (const [nombre, valor] of Object.entries({ idActor, idPlataforma, idPerfil })) {
		if (valor !== undefined && !esId(valor)) throw pedidoInvalido(`${nombre} no es un id válido`);
	}
	limite = Math.min(Math.max(parseInt(limite) || LIMITE_POR_DEFECTO, 1), LIMITE_MAXIMO);
	pagina = Math.max(parseInt(pagina) || 1, 1);

	const filtro = { estado: 'publicado' };
	if (genero) filtro.generos = genero;
	if (idActor) filtro['elenco.idActor'] = idActor;
	if (idPlataforma) filtro['plataforma.id'] = idPlataforma;

	let perfil = null;
	if (idPerfil) {
		const cuenta = await db.collection('cuentas').findOne(
			{ 'perfiles.id': idPerfil },
			{ projection: { 'perfiles.$': 1 } }, // solo el perfil que coincide
		);
		if (!cuenta) throw noEncontrado(`No existe el perfil ${idPerfil}`);
		perfil = cuenta.perfiles[0];
		filtro.clasificacionEdad = { $lte: perfil.clasificacionEdad };
	}

	// Una sola consulta trae el total y la página
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
							// se cuenta acá, no se guarda
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

	const ids = resultado.contenidos.map((c) => c._id);
	const [vinculados, progresos] = await Promise.all([
		buscarVinculados(ids, perfil?.clasificacionEdad),
		// Redis: continuar viendo de cada contenido, en paralelo (el cliente los manda juntos)
		idPerfil ? Promise.all(ids.map((id) => redis.hGetAll(claves.cv(idPerfil, id)))) : [],
	]);

	const progreso = (i) => {
		const cv = progresos[i];
		if (!cv?.idEpisodio) return null;
		return {
			idEpisodio: cv.idEpisodio === ids[i] ? null : cv.idEpisodio, // en películas la unidad es el contenido
			posicionSeg: Number(cv.segundo),
			actualizado: cv.actualizado,
		};
	};

	return {
		pagina,
		limite,
		total: resultado.total[0]?.n ?? 0,
		perfil: perfil && { nombre: perfil.nombre, clasificacionEdad: perfil.clasificacionEdad },
		contenidos: resultado.contenidos.map((c, i) => ({
			...c,
			vinculados: vinculados.get(c._id) ?? [],
			...(idPerfil && { progreso: progreso(i) }),
		})),
	};
}