import { fakerES as faker } from '@faker-js/faker';

export const SEMILLA = 2026;
const FECHA_REFERENCIA = '2026-10-01T00:00:00.000Z';

export const VOLUMEN = {
	actores: 2000,
	contenidos: 500,
	cuentas: 1000,
	dispositivos: 3000,
};

const id = () => faker.string.uuid();
const entre = (min, max) => faker.number.int({ min, max });

const PLATAFORMAS = [
	['Andes Films', 'AR'], ['Pampa Studios', 'AR'], ['Iberia Media', 'ES'], ['Azteca Visión', 'MX'],
	['Northlight Pictures', 'US'], ['Bluebird Originals', 'US'], ['Rheingold TV', 'DE'],
	['Lumière Productions', 'FR'], ['Seoul Wave', 'KR'], ['Thames Drama', 'GB'],
];

const GENEROS = [
	'Acción', 'Aventura', 'Animación', 'Comedia', 'Crimen', 'Documental', 'Drama', 'Familiar',
	'Fantasía', 'Historia', 'Terror', 'Musical', 'Misterio', 'Romance', 'Ciencia ficción',
	'Suspenso', 'Bélico', 'Western', 'Deportes', 'Biografía',
];

const SUJETOS = [
	'La sombra', 'El secreto', 'Los hijos', 'La casa', 'El último viaje', 'La noche', 'El silencio',
	'Las voces', 'El jardín', 'La herencia', 'El regreso', 'La frontera', 'Los guardianes',
	'El laberinto', 'La promesa', 'El faro', 'Las cenizas', 'El círculo', 'La memoria', 'El pacto',
];
const COMPLEMENTOS = [
	'del invierno', 'de la ciudad', 'del río', 'perdida', 'sin nombre', 'del norte', 'de cristal',
	'del tiempo', 'en llamas', 'de medianoche', 'del abismo', 'de papel', 'del desierto',
	'infinito', 'de la montaña', 'del puerto', 'olvidado', 'de hierro', 'del sur', 'eterno',
];

const titulo = () => `${faker.helpers.arrayElement(SUJETOS)} ${faker.helpers.arrayElement(COMPLEMENTOS)}`;

const edadContenido = () =>
	faker.helpers.weightedArrayElement([
		{ weight: 15, value: 0 },
		{ weight: 15, value: 7 },
		{ weight: 30, value: 13 },
		{ weight: 25, value: 16 },
		{ weight: 15, value: 18 },
	]);

function generarEpisodios(cantidadTemporadas) {
	return Array.from({ length: cantidadTemporadas }, (_, t) => ({
		numero: t + 1,
		episodios: Array.from({ length: entre(6, 12) }, (_, e) => ({
			id: id(),
			numero: e + 1,
			titulo: titulo(),
			duracionSeg: entre(20, 60) * 60,
		})),
	}));
}

function generarContenido({ plataformas, actores, forzar = {} }) {
	const tipo = forzar.tipo ?? (faker.datatype.boolean({ probability: 0.4 }) ? 'serie' : 'pelicula');
	const plataforma = faker.helpers.arrayElement(plataformas);

	const contenido = {
		_id: id(),
		titulo: forzar.titulo ?? titulo(),
		descripcion: faker.lorem.sentences(2),
		tipo,
		estado: 'publicado',
		anioEstreno: entre(1975, 2026),
		clasificacionEdad: forzar.clasificacionEdad ?? edadContenido(),
		plataforma: { id: plataforma.id, nombre: plataforma.nombre, paisOrigen: plataforma.paisOrigen },
		generos: faker.helpers.arrayElements(GENEROS, { min: 1, max: 3 }),
		elenco: faker.helpers.arrayElements(actores, { min: 3, max: 8 }).map((a) => ({
			idActor: a.id,
			nombre: `${a.nombre} ${a.apellido}`,
			personaje: faker.person.fullName(),
		})),
	};

	if (tipo === 'serie') contenido.temporadas = generarEpisodios(forzar.temporadas ?? entre(1, 4));
	else contenido.duracionSeg = entre(80, 180) * 60;

	return contenido;
}

function generarCuenta(i, forzar = {}) {
	const cantidadPerfiles = forzar.perfiles?.length ?? entre(1, 4);
	const fechaAlta = faker.date.past({ years: 5 });

	const perfiles =
		forzar.perfiles ??
		Array.from({ length: cantidadPerfiles }, (_, p) => ({
			nombre: faker.person.firstName(),
			clasificacionEdad: p === 0 ? 18 : faker.helpers.arrayElement([7, 13, 16, 18]),
		}));

	return {
		_id: id(),
		email: forzar.email ?? `${faker.internet.username().toLowerCase()}.${i}@ejemplo.com`,
		estado:
			forzar.estado ??
			faker.helpers.weightedArrayElement([
				{ weight: 95, value: 'activa' },
				{ weight: 3, value: 'suspendida' },
				{ weight: 2, value: 'cancelada' },
			]),
		limiteSesiones: forzar.limiteSesiones ?? faker.helpers.arrayElement([1, 2, 2, 4]),
		fechaAlta,
		perfiles: perfiles.map((p) => ({
			id: id(),
			nombre: p.nombre,
			idioma: faker.helpers.weightedArrayElement([
				{ weight: 85, value: 'es' },
				{ weight: 10, value: 'en' },
				{ weight: 5, value: 'pt' },
			]),
			clasificacionEdad: p.clasificacionEdad,
			fechaCreacion: faker.date.between({ from: fechaAlta, to: FECHA_REFERENCIA }),
		})),
	};
}

function generarDispositivo() {
	const tipo = faker.helpers.weightedArrayElement([
		{ weight: 35, value: 'tv' },
		{ weight: 35, value: 'movil' },
		{ weight: 10, value: 'tablet' },
		{ weight: 15, value: 'web' },
		{ weight: 5, value: 'consola' },
	]);
	const opciones = {
		tv: [['Samsung QN90', 'Tizen'], ['LG C3', 'webOS'], ['Sony Bravia', 'Google TV']],
		movil: [['iPhone 15', 'iOS'], ['Galaxy S24', 'Android'], ['Moto G84', 'Android']],
		tablet: [['iPad Air', 'iPadOS'], ['Galaxy Tab S9', 'Android']],
		web: [['Chrome', 'Windows'], ['Safari', 'macOS'], ['Firefox', 'Linux']],
		consola: [['PlayStation 5', 'PS5 OS'], ['Xbox Series X', 'Xbox OS']],
	};
	const [modelo, sistemaOperativo] = faker.helpers.arrayElement(opciones[tipo]);
	return { _id: id(), tipo, modelo, sistemaOperativo, fechaRegistro: faker.date.past({ years: 3 }) };
}

export function generarDatos() {
	faker.seed(SEMILLA);
	faker.setDefaultRefDate(FECHA_REFERENCIA);

	const plataformas = PLATAFORMAS.map(([nombre, paisOrigen]) => ({ id: id(), nombre, paisOrigen }));

	const actores = Array.from({ length: VOLUMEN.actores }, () => ({
		id: id(),
		nombre: faker.person.firstName(),
		apellido: faker.person.lastName(),
		fechaNacimiento: faker.date.birthdate({ min: 18, max: 85, mode: 'age' }),
	}));

	// Datos fijos para las demos: siempre existen y tienen los mismos IDs
	const serieDemo = generarContenido({
		plataformas,
		actores,
		forzar: { tipo: 'serie', titulo: 'El faro del norte', clasificacionEdad: 16, temporadas: 3 },
	});
	const cuentaDemo = generarCuenta(0, {
		email: 'demo@streamdb.test',
		estado: 'activa',
		limiteSesiones: 2,
		perfiles: [
			{ nombre: 'Titular', clasificacionEdad: 18 },
			{ nombre: 'Adolescente', clasificacionEdad: 13 },
			{ nombre: 'Niños', clasificacionEdad: 7 },
		],
	});

	const contenidos = [
		serieDemo,
		...Array.from({ length: VOLUMEN.contenidos - 1 }, () => generarContenido({ plataformas, actores })),
	];
	const cuentas = [
		cuentaDemo,
		...Array.from({ length: VOLUMEN.cuentas - 1 }, (_, i) => generarCuenta(i + 1)),
	];
	const dispositivos = Array.from({ length: VOLUMEN.dispositivos }, generarDispositivo);

	return {
		plataformas,
		generos: GENEROS,
		actores,
		contenidos,
		cuentas,
		dispositivos,
		demo: { serie: serieDemo, cuenta: cuentaDemo },
	};
}
