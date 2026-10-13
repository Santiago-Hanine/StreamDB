import 'dotenv/config';
import db, { client } from '../db/mongo.js';
import { ejecutarSaga } from '../lib/saga.js';

const col = db.collection('prueba_saga');

// Un paso que inserta un documento y su compensación que lo borra
const paso = (n) => ({
	nombre: `paso${n}`,
	ejecutar: async () => {
		await col.updateOne({ _id: `doc${n}` }, { $set: { n } }, { upsert: true });
		return { creado: `doc${n}` };
	},
	compensar: async ({ creado }) => {
		await col.deleteOne({ _id: creado });
	},
});

async function probar(titulo, opciones) {
	console.log(`\n${titulo}`);
	let idSaga;
	try {
		({ idSaga } = await ejecutarSaga({ tipo: 'prueba', pasos: [paso(1), paso(2), paso(3)], ...opciones }));
		console.log('  respuesta: completada');
	} catch (error) {
		idSaga = error.idSaga;
		console.log(`  respuesta: ${error.status} ${error.message}`);
	}
	const saga = await db.collection('sagas').findOne({ _id: idSaga });
	console.log(`  saga: ${saga.estado} | ${saga.pasos.map((p) => `${p.nombre}=${p.estado}`).join(' ')}`);
	console.log(`  documentos que quedaron: ${await col.countDocuments()}`);
	await col.deleteMany({});
}

try {
	await probar('1. Sin falla (esperado: completada, 3 documentos)', {});
	await probar('2. Falla en paso3 (esperado: compensada, 0 documentos)', { fallarEn: 'paso3' });
} finally {
	await col.drop().catch(() => { });
	await db.collection('sagas').deleteMany({ tipo: 'prueba' });
	await client.close();
}