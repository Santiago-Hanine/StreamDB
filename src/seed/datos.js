import { fakerES as faker } from '@faker-js/faker';

export const SEMILLA = 2026;
const FECHA_REFERENCIA = '2026-10-01T00:00:00.000Z';

export const VOLUMEN = {
	actores: 2000,
	contenidos: 500,
	cuentas: 1000,
	dispositivos: 3000,
	vinculos: 1500,
	visualizaciones: 50000
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

const compartenGenero = (a, b) => a.generos.some((g) => b.generos.includes(g));

// Vínculos entre contenidos. La precuela no se guarda: es la secuela al revés.
function generarVinculos(contenidos) {
	const vinculos = [];
	const usados = new Set();
	const clave = (a, b) => [a._id, b._id].sort().join('|');
	const agregar = (origen, destino, tipo) => {
		if (!origen || !destino || origen._id === destino._id || usados.has(clave(origen, destino))) return;
		usados.add(clave(origen, destino));
		vinculos.push({ idOrigen: origen._id, idDestino: destino._id, tipo });
	};

	// La serie demo siempre tiene una secuela, uno del mismo universo y uno similar
	const [demo, ...resto] = contenidos;
	const mismaPlataforma = resto.filter((c) => c.plataforma.id === demo.plataforma.id);
	agregar(mismaPlataforma.find((c) => c.tipo === demo.tipo && c.anioEstreno >= demo.anioEstreno), demo, 'secuela');
	agregar(mismaPlataforma.find((c) => !usados.has(clave(c, demo))), demo, 'mismo_universo');
	agregar(demo, resto.find((c) => compartenGenero(c, demo) && !usados.has(clave(c, demo))), 'similar');

	const reglas = {
		similar: (a, b) => compartenGenero(a, b),
		secuela: (a, b) => a.tipo === b.tipo && a.plataforma.id === b.plataforma.id,
		mismo_universo: (a, b) => a.plataforma.id === b.plataforma.id,
	};

	while (vinculos.length < VOLUMEN.vinculos) {
		const [a, b] = faker.helpers.arrayElements(contenidos, 2);
		const tipo = faker.helpers.weightedArrayElement([
			{ weight: 20, value: 'secuela' },
			{ weight: 15, value: 'mismo_universo' },
			{ weight: 65, value: 'similar' },
		]);
		if (!reglas[tipo](a, b)) continue;
		// la secuela no puede ser anterior a la original
		if (tipo === 'secuela' && a.anioEstreno < b.anioEstreno) agregar(b, a, tipo);
		else agregar(a, b, tipo);
	}
	return vinculos;
}

function numerarTitulosRepetidos(contenidos) {
	const ROMANOS = ['II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
	const vistos = new Map();
	for (const c of contenidos) {
		const veces = vistos.get(c.titulo) ?? 0;
		vistos.set(c.titulo, veces + 1);
		if (veces > 0) c.titulo = `${c.titulo} ${ROMANOS[veces - 1]}`;
	}
}

const DESDE = new Date('2026-04-01T00:00:00.000Z').getTime();
const HASTA = new Date(FECHA_REFERENCIA).getTime();

function generarVisualizaciones(contenidos, cuentas, dispositivos) {
	const aptos = new Map(); // edad del perfil → contenidos que puede ver
	for (const edad of [0, 7, 13, 16, 18]) aptos.set(edad, contenidos.filter((c) => c.clasificacionEdad <= edad));
	const perfiles = cuentas.filter((c) => c.estado === 'activa').flatMap((c) => c.perfiles);

	const visualizaciones = [];
	while (visualizaciones.length < VOLUMEN.visualizaciones) {
		const perfil = faker.helpers.arrayElement(perfiles);
		const contenido = faker.helpers.arrayElement(aptos.get(perfil.clasificacionEdad));
		const dispositivo = faker.helpers.arrayElement(dispositivos);

		// En una serie, varios episodios seguidos
		const unidades = contenido.tipo === 'serie'
			? contenido.temporadas.flatMap((t) => t.episodios).slice(0, entre(1, 8))
			: [{ id: null, duracionSeg: contenido.duracionSeg }];

		let fecha = entre(DESDE, HASTA - 7 * 86400000);
		const idSesion = id();
		unidades.forEach((unidad, i) => {
			const esLaUltima = i === unidades.length - 1;
			const finalizado = !esLaUltima || faker.datatype.boolean({ probability: 0.6 });
			const posicionSeg = finalizado ? unidad.duracionSeg : entre(60, unidad.duracionSeg - 60);
			const fechaFin = new Date(fecha + posicionSeg * 1000);
			visualizaciones.push({
				idVisualizacion: id(),
				idPerfil: perfil.id,
				idContenido: contenido._id,
				idEpisodio: unidad.id, // null en películas
				idSesion,
				idDispositivo: dispositivo._id,
				fechaInicio: new Date(fecha),
				fechaFin,
				posicionSeg,
				finalizado,
			});
			fecha = fechaFin.getTime() + entre(1, 72) * 3600000; // el siguiente episodio, horas después
		});
	}
	return visualizaciones.slice(0, VOLUMEN.visualizaciones);
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

	// Datos fijos para las demos, siempre con los mismos ids
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
	numerarTitulosRepetidos(contenidos);
	const cuentas = [
		cuentaDemo,
		...Array.from({ length: VOLUMEN.cuentas - 1 }, (_, i) => generarCuenta(i + 1)),
	];
	const dispositivos = Array.from({ length: VOLUMEN.dispositivos }, generarDispositivo);

	const vinculos = generarVinculos(contenidos);

	const visualizaciones = generarVisualizaciones(contenidos, cuentas, dispositivos);

	return {
		plataformas,
		generos: GENEROS,
		actores,
		contenidos,
		cuentas,
		dispositivos,
		vinculos,
		demo: { serie: serieDemo, cuenta: cuentaDemo },
		visualizaciones
	};
}
