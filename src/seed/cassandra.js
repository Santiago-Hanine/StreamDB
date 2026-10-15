import 'dotenv/config';
import cassandra from 'cassandra-driver';
import { cassandraClient as cliente } from '../db/cassandra.js';
import { generarDatos, SEMILLA } from './datos.js';

const { executeConcurrent } = cassandra.concurrent;
const mes = (fecha) => fecha.toISOString().slice(0, 7); // '2026-10': parte de la clave de partición

const { visualizaciones } = generarDatos();

try {
	await cliente.execute('TRUNCATE historial_por_perfil');
	await cliente.execute('TRUNCATE historial_por_contenido');

	// executeConcurrent manda muchas inserciones en paralelo (64 a la vez), ya preparadas
	await executeConcurrent(
		cliente,
		`INSERT INTO historial_por_perfil
                 (id_perfil, mes, fecha, id_visualizacion, id_contenido, id_episodio, id_sesion, fecha_fin, posicion_seg, finalizado)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		visualizaciones.map((v) => [
			v.idPerfil, mes(v.fechaInicio), v.fechaInicio, v.idVisualizacion, v.idContenido,
			v.idEpisodio, v.idSesion, v.fechaFin, v.posicionSeg, v.finalizado,
		]),
		{ concurrencyLevel: 64 },
	);
	console.log(`✓ historial_por_perfil: ${visualizaciones.length}`);

	// Los mismos datos, con la clave pensada para la consulta por contenido (P8)
	await executeConcurrent(
		cliente,
		`INSERT INTO historial_por_contenido
                 (id_contenido, fecha, id_visualizacion, id_perfil, id_episodio, id_sesion, fecha_fin, posicion_seg, finalizado)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		visualizaciones.map((v) => [
			v.idContenido, v.fechaInicio, v.idVisualizacion, v.idPerfil,
			v.idEpisodio, v.idSesion, v.fechaFin, v.posicionSeg, v.finalizado,
		]),
		{ concurrencyLevel: 64 },
	);
	console.log(`✓ historial_por_contenido: ${visualizaciones.length}`);
	console.log(`  (semilla ${SEMILLA})`);
} finally {
	await cliente.shutdown();
}