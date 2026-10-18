import db from '../db/mongo.js';
import { redis } from '../db/redis.js';
import { cypher } from '../db/neo4j.js';

import { esId } from '../lib/ids.js';
import { pedidoInvalido, noEncontrado } from '../lib/errores.js';
import { claves } from './p2-inicio-reproduccion-sesiones.js';

const LIMITE_POR_DEFECTO = 10;
const LIMITE_MAXIMO = 20;
const SEMILLAS_VISTAS = 10;   // últimos contenidos terminados que se usan como punto de partida
const SEMILLAS_EN_CURSO = 5;  // y los que está viendo ahora

// Cuánto suma cada camino del grafo entre lo visto (semilla) y un candidato
const PESOS = { secuela: 5, mismo_universo: 4, precuela: 3, similar: 3, elenco: 2, genero: 1 };

// Neo4j consultas (los números de JavaScript llegan como decimales: LIMIT necesita toInteger):

// Semillas: los últimos contenidos que el perfil terminó de ver (una VIO por visualización)
const VISTOS_RECIENTES = `
  MATCH (:Perfil {id: $idPerfil})-[v:VIO]->(c:Contenido)
  WITH c, max(v.fecha) AS ultima
  ORDER BY ultima DESC LIMIT toInteger($cantidad)
  RETURN c.id AS id`;

// Recorrido desde cada semilla por los tres tipos de vínculo. Cada fila es un camino
// semilla → candidato con su peso; después se suman por candidato.
// Se filtra acá mismo lo ya visto, lo no publicado y lo que no es apto para la edad del perfil
// (estado y clasificación están desnormalizados en Neo4j justamente para esto).
const RECORRER = `
  UNWIND $semillas AS sem
  MATCH (s:Contenido {id: sem.id})
  CALL (s) {
    MATCH (s)-[r:RELACIONADO]-(c:Contenido)
    // (A)-[secuela]->(B) significa "A es secuela de B": desde la semilla B, A es su secuela
    RETURN c, CASE WHEN r.tipo <> 'secuela' THEN r.tipo
                   WHEN endNode(r) = s THEN 'secuela' ELSE 'precuela' END AS motivo, null AS via
    UNION
    MATCH (s)<-[:ACTUA_EN]-(a:Actor)-[:ACTUA_EN]->(c:Contenido)
    RETURN c, 'elenco' AS motivo, a.nombre + ' ' + a.apellido AS via
    UNION
    MATCH (s)-[:DE_GENERO]->(g:Genero)<-[:DE_GENERO]-(c:Contenido)
    RETURN c, 'genero' AS motivo, g.nombre AS via
  }
  WITH sem, s, c, motivo, via
  WHERE c.id <> s.id AND NOT c.id IN $excluir
    AND c.estado = 'publicado' AND c.clasificacionEdad <= $edad
    AND NOT EXISTS { MATCH (:Perfil {id: $idPerfil})-[:VIO]->(c) }
  WITH c, collect({ motivo: motivo, via: via, idSemilla: s.id, semilla: s.titulo,
                    enCurso: sem.enCurso, peso: $pesos[motivo] * sem.factor }) AS caminos
  WITH c, caminos, reduce(total = 0.0, x IN caminos | total + x.peso) AS puntaje
  ORDER BY puntaje DESC, c.id
  LIMIT toInteger($cantidad)
  RETURN c.id AS id, puntaje, caminos`;

// Para un perfil sin historial (o si faltan resultados): lo más visto de la plataforma
const POPULARES = `
  MATCH (c:Contenido)<-[v:VIO]-()
  WHERE c.estado = 'publicado' AND c.clasificacionEdad <= $edad AND NOT c.id IN $excluir
    AND NOT EXISTS { MATCH (:Perfil {id: $idPerfil})-[:VIO]->(c) }
  WITH c, count(v) AS vistas
  ORDER BY vistas DESC, c.id
  LIMIT toInteger($cantidad)
  RETURN c.id AS id, vistas`;

const DESCRIPCION = {
	secuela: () => 'es su secuela',
	precuela: () => 'es su precuela',
	mismo_universo: () => 'es del mismo universo',
	similar: () => 'es similar',
	elenco: (via) => `actúa ${via}`,
	genero: (via) => `también es de ${via}`,
};

// El "porque viste X" sale del camino de más peso hacia ese candidato
function explicar(caminos) {
	const mejor = caminos.reduce((a, b) => (b.peso > a.peso ? b : a));
	const verbo = mejor.enCurso ? 'estás viendo' : 'viste';
	return {
		texto: `Porque ${verbo} "${mejor.semilla}": ${DESCRIPCION[mejor.motivo](mejor.via)}`,
		motivo: mejor.motivo,
		idContenidoOrigen: mejor.idSemilla,
	};
}

export async function recomendar(idPerfil, { limite } = {}) {

	// 1. Validar
	if (!esId(idPerfil)) throw pedidoInvalido('idPerfil no es un id válido');
	limite = Math.min(Math.max(parseInt(limite) || LIMITE_POR_DEFECTO, 1), LIMITE_MAXIMO);

	// 2. Mongo: la clasificación por edad del perfil (fuente de verdad)
	const cuenta = await db.collection('cuentas').findOne(
		{ 'perfiles.id': idPerfil },
		{ projection: { 'perfiles.$': 1 } },
	);
	if (!cuenta) throw noEncontrado(`No existe el perfil ${idPerfil}`);
	const edad = cuenta.perfiles[0].clasificacionEdad;

	// 3. Consumo reciente: lo que está viendo ahora (Redis) y lo último que terminó (Neo4j).
	//    Lo que está viendo no se recomienda: ya aparece en "continuar viendo".
	const [enCurso, vistos] = await Promise.all([
		redis.zRange(claves.continuar(idPerfil), 0, SEMILLAS_EN_CURSO - 1, { REV: true }),
		cypher(VISTOS_RECIENTES, { idPerfil, cantidad: SEMILLAS_VISTAS }),
	]);
	// Lo más reciente pesa más: factor 1 para lo que está viendo y la última vista, y baja de a 5 %
	const semillas = [
		...enCurso.map((id) => ({ id, factor: 1, enCurso: true })),
		...vistos.filter((v) => !enCurso.includes(v.id)).map((v, i) => ({ id: v.id, factor: 1 - i * 0.05, enCurso: false })),
	];

	// 4. Neo4j: recorrido por vínculos, elenco y género. Se piden de más porque Mongo vuelve a filtrar.
	const cantidad = limite * 3;
	const candidatos = semillas.length
		? await cypher(RECORRER, { idPerfil, semillas, excluir: enCurso, edad, pesos: PESOS, cantidad })
		: [];

	// 5. Mongo: las fichas, y se vuelve a verificar publicado y apto (Neo4j tiene una copia de esos datos)
	const fichas = async (ids) => {
		const docs = await db.collection('contenidos').find(
			{ _id: { $in: ids }, estado: 'publicado', clasificacionEdad: { $lte: edad } },
			{ projection: { titulo: 1, tipo: 1, anioEstreno: 1, clasificacionEdad: 1, generos: 1, 'plataforma.nombre': 1 } },
		).toArray();
		return new Map(docs.map((d) => [d._id, d]));
	};
	const porId = await fichas(candidatos.map((c) => c.id));

	const recomendaciones = [];
	for (const c of candidatos) {
		const ficha = porId.get(c.id);
		if (!ficha || recomendaciones.length === limite) continue;
		recomendaciones.push({
			idContenido: c.id, titulo: ficha.titulo, tipo: ficha.tipo, anioEstreno: ficha.anioEstreno,
			clasificacionEdad: ficha.clasificacionEdad, generos: ficha.generos, plataforma: ficha.plataforma?.nombre,
			puntaje: Math.round(c.puntaje * 100) / 100,
			porque: explicar(c.caminos),
		});
	}

	// 6. Si no alcanzó (perfil nuevo o con poco historial), se completa con lo más visto
	if (recomendaciones.length < limite) {
		const excluir = [...enCurso, ...recomendaciones.map((r) => r.idContenido)];
		const populares = await cypher(POPULARES, { idPerfil, edad, excluir, cantidad: (limite - recomendaciones.length) * 3 });
		const porIdPopulares = await fichas(populares.map((p) => p.id));
		for (const p of populares) {
			const ficha = porIdPopulares.get(p.id);
			if (!ficha || recomendaciones.length === limite) continue;
			recomendaciones.push({
				idContenido: p.id, titulo: ficha.titulo, tipo: ficha.tipo, anioEstreno: ficha.anioEstreno,
				clasificacionEdad: ficha.clasificacionEdad, generos: ficha.generos, plataforma: ficha.plataforma?.nombre,
				puntaje: 0,
				porque: { texto: `Popular en la plataforma (${p.vistas} visualizaciones)`, motivo: 'popular', idContenidoOrigen: null },
			});
		}
	}

	return { idPerfil, clasificacionEdad: edad, semillas: semillas.length, recomendaciones };
}
