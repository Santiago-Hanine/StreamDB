import 'dotenv/config';
import { fakerES as faker } from '@faker-js/faker';
import { pool, sql } from '../db/postgres.js';
import { generarDatos, SEMILLA } from './datos.js';

const HOY = '2026-10-17';
const REGIONES = ['AR', 'UY', 'CL', 'MX', 'ES'];
const PORCENTAJE_VENCIDOS = 6; // contenidos cuya última licencia ya venció (pendientes de retirar en P8)

const fecha = (d) => d.toISOString().slice(0, 10);
const masAnios = (texto, anios) => { const d = new Date(texto); d.setUTCFullYear(d.getUTCFullYear() + anios); return fecha(d); };

const { contenidos } = generarDatos();
faker.seed(SEMILLA + 8); // semilla propia: no cambia lo que generan los otros seeds

const licencias = [];
let pendientes = 0;
contenidos.forEach((c, i) => {
	const regiones = faker.helpers.arrayElements(REGIONES, { min: 1, max: 3 });
	// Solo puede tener todas sus licencias vencidas algo estrenado hasta 2022
	const vencido = i > 0 && c.anioEstreno <= 2022 && faker.number.int({ min: 1, max: 100 }) <= PORCENTAJE_VENCIDOS;
	const desdeMin = `${Math.min(Math.max(c.anioEstreno, 2018), 2025)}-01-01`; // la licencia no empieza antes del estreno
	if (vencido) pendientes++;

	regiones.forEach((region, j) => {
		let desde, hasta;
		if (i === 0 && j === 0) {
			// Serie demo: su primera licencia sigue vigente (para retirarla en la demo, procesar con una fecha posterior)
			[desde, hasta] = ['2023-03-01', '2027-03-01'];
		} else if (vencido) {
			// Todas sus licencias ya terminaron, pero siguen "vigente": el proceso de P8 las detecta
			desde = fecha(faker.date.between({ from: desdeMin, to: '2023-01-01' }));
			hasta = fecha(faker.date.between({ from: masAnios(desde, 2), to: '2026-10-01' }));
		} else {
			desde = fecha(faker.date.between({ from: desdeMin, to: '2026-01-01' }));
			hasta = fecha(faker.date.between({ from: '2026-11-01', to: '2029-12-31' })); // cubre HOY
		}
		licencias.push([faker.string.uuid(), c._id, c.plataforma.id, region, `[${desde},${hasta})`]);
	});
});

try {
	await sql('TRUNCATE licencia');
	// Un INSERT por lote con UNNEST: una sola ida a la base cada 500 filas
	for (let i = 0; i < licencias.length; i += 500) {
		const lote = licencias.slice(i, i + 500);
		await sql(
			`INSERT INTO licencia (id_licencia, id_contenido, id_plataforma, region, vigencia)
             SELECT * FROM UNNEST($1::uuid[], $2::uuid[], $3::uuid[], $4::char(2)[], $5::daterange[])`,
			[0, 1, 2, 3, 4].map((k) => lote.map((fila) => fila[k])),
		);
	}
	const [{ n }] = await sql(`SELECT count(*)::int AS n FROM licencia WHERE estado = 'vigente' AND upper(vigencia) <= $1`, [HOY]);
	console.log(`✓ licencias: ${licencias.length}`);
	console.log(`  (${pendientes} contenidos con todas sus licencias vencidas al ${HOY}: ${n} licencias por procesar en P8, semilla ${SEMILLA})`);
} finally {
	await pool.end();
}
