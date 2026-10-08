import 'dotenv/config';
import db, { client } from '../db/mongo.js';
import { UUID_PATTERN } from '../lib/ids.js';

const uuid = {
	bsonType: 'string',
	pattern: UUID_PATTERN,
	description: 'UUID compartido entre motores, generado con nuevoId() de src/lib/ids.js',
};
const fecha = { bsonType: 'date' };
const edad = { bsonType: 'int', enum: [0, 7, 13, 16, 18] };

const colecciones = {
	contenidos: {
		schema: {
			bsonType: 'object',
			required: ['_id', 'titulo', 'tipo', 'estado', 'clasificacionEdad', 'plataforma'],
			properties: {
				_id: uuid,
				titulo: { bsonType: 'string', minLength: 1 },
				descripcion: { bsonType: 'string' },
				tipo: { enum: ['pelicula', 'serie'] },

				estado: { enum: ['borrador', 'publicado', 'retirado'] },
				anioEstreno: { bsonType: 'int', minimum: 1888 },
				duracionSeg: { bsonType: 'int', minimum: 1, description: 'Solo películas' },
				clasificacionEdad: edad,
				plataforma: {
					bsonType: 'object',
					required: ['id', 'nombre'],
					properties: { id: uuid, nombre: { bsonType: 'string' }, paisOrigen: { bsonType: 'string' } },
				},
				generos: { bsonType: 'array', items: { bsonType: 'string' } },
				elenco: {
					bsonType: 'array',
					items: {
						bsonType: 'object',
						required: ['idActor', 'nombre'],
						properties: { idActor: uuid, nombre: { bsonType: 'string' }, personaje: { bsonType: 'string' } },
					},
				},
				temporadas: {
					bsonType: 'array',
					items: {
						bsonType: 'object',
						required: ['numero', 'episodios'],
						properties: {
							numero: { bsonType: 'int', minimum: 1 },
							episodios: {
								bsonType: 'array',
								items: {
									bsonType: 'object',
									required: ['id', 'numero', 'titulo', 'duracionSeg'],
									properties: {
										id: uuid,
										numero: { bsonType: 'int', minimum: 1 },
										titulo: { bsonType: 'string' },
										duracionSeg: { bsonType: 'int', minimum: 1 },
									},
								},
							},
						},
					},
				},
				retiro: {
					bsonType: 'object',
					required: ['idLicencia', 'fecha'],
					properties: { idLicencia: uuid, fecha, idSaga: uuid },
				},
			},
		},
		indices: [
			{ key: { estado: 1, generos: 1 }, name: 'estado_genero' },
			{ key: { estado: 1, 'elenco.idActor': 1 }, name: 'estado_actor' },
			{ key: { estado: 1, 'plataforma.id': 1 }, name: 'estado_plataforma' },
			{
				key: { 'temporadas.episodios.id': 1 },
				name: 'episodio_id',
				unique: true,
				partialFilterExpression: { tipo: 'serie' },
			},
		],
	},
	cuentas: {
		schema: {
			bsonType: 'object',
			required: ['_id', 'email', 'estado', 'limiteSesiones', 'fechaAlta', 'perfiles'],
			properties: {
				_id: uuid,
				email: { bsonType: 'string', pattern: '^[^@\\s]+@[^@\\s]+$' },
				estado: { enum: ['activa', 'suspendida', 'cancelada'] },
				limiteSesiones: { bsonType: 'int', minimum: 1, maximum: 10 },
				fechaAlta: fecha,
				perfiles: {
					bsonType: 'array',
					maxItems: 5,
					items: {
						bsonType: 'object',
						required: ['id', 'nombre', 'clasificacionEdad'],
						properties: {
							id: uuid,
							nombre: { bsonType: 'string', minLength: 1 },
							idioma: { bsonType: 'string' },
							clasificacionEdad: edad,
							fechaCreacion: fecha,
						},
					},
				},
			},
		},
		indices: [
			{ key: { email: 1 }, name: 'email_unico', unique: true },
			{
				key: { 'perfiles.id': 1 },
				name: 'perfil_id',
				unique: true,
				partialFilterExpression: { 'perfiles.id': { $exists: true } },
			},
		],
	},
	dispositivos: {
		schema: {
			bsonType: 'object',
			required: ['_id', 'tipo', 'fechaRegistro'],
			properties: {
				_id: uuid,
				tipo: { enum: ['tv', 'movil', 'tablet', 'web', 'consola'] },
				modelo: { bsonType: 'string' },
				sistemaOperativo: { bsonType: 'string' },
				fechaRegistro: fecha,
			},
		},
		indices: [],
	},
	sagas: {
		schema: {
			bsonType: 'object',
			required: ['_id', 'tipo', 'estado', 'pasos', 'creadaEn', 'actualizadaEn'],
			properties: {
				_id: uuid,
				tipo: { bsonType: 'string', description: 'Ej: alta_serie, inicio_reproduccion' },
				estado: { enum: ['en_curso', 'completada', 'compensando', 'compensada', 'fallida'] },
				pasos: {
					bsonType: 'array',
					items: {
						bsonType: 'object',
						required: ['nombre', 'estado'],
						properties: {
							nombre: { bsonType: 'string' },
							estado: { enum: ['pendiente', 'hecho', 'compensado', 'fallido'] },
							datos: { bsonType: 'object' },
							error: { bsonType: 'string' },
						},
					},
				},
				creadaEn: fecha,
				actualizadaEn: fecha,
			},
		},
		indices: [
			{ key: { estado: 1, actualizadaEn: 1 }, name: 'estado_actualizada' },
		],
	},
};

for (const [nombre, { schema, indices }] of Object.entries(colecciones)) {
	const validacion = {
		validator: { $jsonSchema: schema },
		validationLevel: 'strict',
		validationAction: 'error',
	};

	const existe = await db.listCollections({ name: nombre }).hasNext();
	if (existe) {
		await db.command({ collMod: nombre, ...validacion });
	} else {
		await db.createCollection(nombre, validacion);
	}

	if (indices.length) await db.collection(nombre).createIndexes(indices);
	console.log(`✓ ${nombre} (${existe ? 'actualizada' : 'creada'}, ${indices.length} índices)`);
}

await client.close();
