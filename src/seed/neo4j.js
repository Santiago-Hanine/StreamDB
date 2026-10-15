import 'dotenv/config';
import { driver, cypher } from '../db/neo4j.js';
import { generarDatos, SEMILLA } from './datos.js';

const LOTE = 1000;

// Manda las filas de a lotes: una consulta por lote, no una por fila
async function cargar(descripcion, filas, query) {
	for (let i = 0; i < filas.length; i += LOTE) {
		await cypher(query, { filas: filas.slice(i, i + LOTE) });
	}
	console.log(`✓ ${descripcion}: ${filas.length}`);
}

async function vaciar() {
	let borrados;
	do {
		[{ borrados }] = await cypher('MATCH (n) WITH n LIMIT 10000 DETACH DELETE n RETURN count(*) AS borrados');
	} while (borrados > 0);
}

const datos = generarDatos();

try {
	await vaciar();

	await cargar('géneros', datos.generos.map((nombre) => ({ nombre })),
		'UNWIND $filas AS f MERGE (:Genero {nombre: f.nombre})');

	// Solo lo que Neo4j necesita: la ficha completa vive en Mongo
	await cargar('contenidos', datos.contenidos.map((c) => ({
		id: c._id, titulo: c.titulo, tipo: c.tipo, estado: c.estado,
		clasificacionEdad: c.clasificacionEdad, generos: c.generos,
	})), `UNWIND $filas AS f
            MERGE (c:Contenido {id: f.id})
            SET c.titulo = f.titulo, c.tipo = f.tipo, c.estado = f.estado, c.clasificacionEdad = f.clasificacionEdad
            WITH c, f UNWIND f.generos AS nombre
            MATCH (g:Genero {nombre: nombre})
            MERGE (c)-[:DE_GENERO]->(g)`);

	// Un Date de JavaScript no se convierte solo en date de Neo4j: se manda como 'AAAA-MM-DD'
	await cargar('actores', datos.actores.map((a) => ({
		id: a.id, nombre: a.nombre, apellido: a.apellido,
		fechaNacimiento: a.fechaNacimiento.toISOString().slice(0, 10),
	})), `UNWIND $filas AS f
            MERGE (a:Actor {id: f.id})
            SET a.nombre = f.nombre, a.apellido = f.apellido, a.fechaNacimiento = date(f.fechaNacimiento)`);

	await cargar('actuaciones', datos.contenidos.flatMap((c) => c.elenco.map((e) => ({
		idActor: e.idActor, idContenido: c._id, personaje: e.personaje,
	}))), `UNWIND $filas AS f
            MATCH (a:Actor {id: f.idActor}), (c:Contenido {id: f.idContenido})
            MERGE (a)-[r:ACTUA_EN]->(c) SET r.personaje = f.personaje`);

	await cargar('vínculos entre contenidos', datos.vinculos,
		`UNWIND $filas AS f
               MATCH (o:Contenido {id: f.idOrigen}), (d:Contenido {id: f.idDestino})
               MERGE (o)-[r:RELACIONADO]->(d) SET r.tipo = f.tipo`);

	// Los perfiles, como punto de partida de las señales VIO (que se cargan con el historial)
	await cargar('perfiles', datos.cuentas.flatMap((c) => c.perfiles.map((p) => ({ id: p.id }))),
		'UNWIND $filas AS f MERGE (:Perfil {id: f.id})');

	await cargar('señales VIO', datos.visualizaciones.filter((v) => v.finalizado).map((v) => ({
		idVisualizacion: v.idVisualizacion, idPerfil: v.idPerfil, idContenido: v.idContenido,
		fecha: v.fechaFin.toISOString(),
	})), `UNWIND $filas AS f
            MATCH (p:Perfil {id: f.idPerfil}), (c:Contenido {id: f.idContenido})
            MERGE (p)-[r:VIO {idVisualizacion: f.idVisualizacion}]->(c) SET r.fecha = datetime(f.fecha)`);

	console.log(`  (semilla ${SEMILLA})`);
} finally {
	await driver.close();
}