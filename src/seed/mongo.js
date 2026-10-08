// Carga los datos de prueba en MongoDB desde cero.
// Borra lo que haya en las colecciones y vuelve a insertar, así siempre queda el mismo estado.
// Requiere haber corrido antes: npm run setup:mongo
// Uso: npm run seed:mongo
import 'dotenv/config';
import db, { client } from '../db/mongo.js';
import { generarDatos, SEMILLA } from './datos.js';

const LOTE = 1000;

async function cargar(nombre, documentos) {
	const coleccion = db.collection(nombre);
	await coleccion.deleteMany({});
	for (let i = 0; i < documentos.length; i += LOTE) {
		await coleccion.insertMany(documentos.slice(i, i + LOTE), { ordered: false });
	}
	console.log(`✓ ${nombre}: ${await coleccion.countDocuments()} documentos`);
}

const datos = generarDatos();

try {
	await cargar('contenidos', datos.contenidos);
	await cargar('cuentas', datos.cuentas);
	await cargar('dispositivos', datos.dispositivos);
	await db.collection('sagas').deleteMany({});

	const episodios = datos.contenidos.reduce(
		(total, c) => total + (c.temporadas ?? []).reduce((t, temp) => t + temp.episodios.length, 0),
		0,
	);
	const perfiles = datos.cuentas.reduce((total, c) => total + c.perfiles.length, 0);
	console.log(`  (${episodios} episodios, ${perfiles} perfiles, semilla ${SEMILLA})`);

	const { serie, cuenta } = datos.demo;
	console.log('\nDatos fijos para demos:');
	console.log(`  Serie "${serie.titulo}": ${serie._id}`);
	console.log(`  Cuenta ${cuenta.email} (límite ${cuenta.limiteSesiones} sesiones): ${cuenta._id}`);
	for (const p of cuenta.perfiles) console.log(`    Perfil ${p.nombre} (+${p.clasificacionEdad}): ${p.id}`);
} catch (error) {
	// Si un documento no cumple la validación del esquema, Mongo explica qué campo falla
	console.error('Error cargando datos:', error.errInfo?.details ?? error.message);
	process.exitCode = 1;
} finally {
	await client.close();
}
