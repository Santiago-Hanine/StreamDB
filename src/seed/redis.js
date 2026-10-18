import 'dotenv/config';
import { redis } from '../db/redis.js';
import { client as mongo } from '../db/mongo.js';
import { cassandraClient } from '../db/cassandra.js';
import { generarDatos, SEMILLA } from './datos.js';
// Las mismas claves que usan los problemas (este import también abre Mongo y Cassandra: se cierran al final)
import { claves } from '../problemas/p2-inicio-reproduccion-sesiones.js';

// "Continuar viendo" a partir del mismo historial que carga el seed de Cassandra, así los dos motores
// arrancan coherentes (si no, P2 no retomaría y P7 mostraría todo sin progreso).
// Misma regla que P3 y P4, por perfil y contenido según su última visualización:
//   a medias               → ese episodio (o la película) en el segundo donde quedó
//   terminada, hay siguiente → el episodio siguiente en el segundo 0
//   terminada, no hay más  → no queda en "continuar viendo"
// Las sesiones no se cargan: son estado en vivo y nacen con P2.

const LOTE = 1000;
const { contenidos, visualizaciones } = generarDatos();

// Episodio siguiente de cada episodio, en orden de temporada y número
const siguiente = new Map();
for (const c of contenidos) {
	if (c.tipo !== 'serie') continue;
	const episodios = [...c.temporadas].sort((a, b) => a.numero - b.numero)
		.flatMap((t) => [...t.episodios].sort((a, b) => a.numero - b.numero));
	episodios.forEach((e, i) => siguiente.set(e.id, episodios[i + 1]?.id ?? null));
}

// La última visualización de cada perfil en cada contenido
const ultimas = new Map();
for (const v of visualizaciones) {
	const clave = `${v.idPerfil}:${v.idContenido}`;
	if (!ultimas.has(clave) || ultimas.get(clave).fechaInicio < v.fechaInicio) ultimas.set(clave, v);
}

const entradas = [];
for (const v of ultimas.values()) {
	let unidad = v.idEpisodio ?? v.idContenido; // película: la unidad es el contenido
	let segundo = v.posicionSeg;
	if (v.finalizado) {
		unidad = v.idEpisodio ? siguiente.get(v.idEpisodio) : null;
		segundo = 0;
	}
	if (unidad) entradas.push({ ...v, unidad, segundo });
}

try {
	await redis.flushDb(); // desde cero, igual que los TRUNCATE de los otros seeds
	for (let i = 0; i < entradas.length; i += LOTE) {
		const lote = redis.multi();
		for (const e of entradas.slice(i, i + LOTE)) {
			lote.hSet(claves.cv(e.idPerfil, e.idContenido), {
				idEpisodio: e.unidad, segundo: String(e.segundo), actualizado: e.fechaFin.toISOString(),
			});
			lote.zAdd(claves.continuar(e.idPerfil), { score: e.fechaFin.getTime(), value: e.idContenido });
			lote.sAdd(claves.perfilesConCv(e.idContenido), e.idPerfil);
		}
		await lote.execAsPipeline(); // una sola ida por lote, sin transacción (no hace falta)
	}
	const perfiles = new Set(entradas.map((e) => e.idPerfil)).size;
	console.log(`✓ continuar viendo: ${entradas.length} (${perfiles} perfiles, de ${ultimas.size} pares perfil-contenido; semilla ${SEMILLA})`);
} finally {
	await Promise.allSettled([redis.quit(), mongo.close(), cassandraClient.shutdown()]);
}
