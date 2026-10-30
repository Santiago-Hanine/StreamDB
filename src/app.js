import 'dotenv/config';
import express from 'express';
import { fileURLToPath } from 'node:url';
import './db/mongo.js';
import { client as mongo } from './db/mongo.js';
import { driver as neo4j } from './db/neo4j.js';
import { redis } from './db/redis.js';
import { cassandraClient } from './db/cassandra.js';
import { pool as postgres } from './db/postgres.js';

import reproducciones from './rutas/reproducciones.js';
import contenidos from './rutas/contenido.js';
import perfiles from './rutas/perfiles.js';
import cuentas from './rutas/cuentas.js';
import licencias from './rutas/licencias.js';
import { iniciarVigilancia } from './problemas/p6-expiracion-cierre-sesiones.js';
import { ErroresApp } from './lib/errores.js';
import * as traza from './demo/traza.js';
import demo from './demo/rutas.js';
import appDemo from './demo/app-rutas.js';
import consola from './demo/consola.js';

const API_PATH = process.env.API_PATH || '/api/v1';

export const app = express();
app.use(express.json());
// Traza para el panel de demo (pedidos con x-traza)
app.use(traza.middleware);

// Rutas
app.use(API_PATH + '/contenidos', contenidos);
app.use(API_PATH + '/reproducciones', reproducciones);
app.use(API_PATH + '/perfiles', perfiles);
app.use(API_PATH + '/cuentas', cuentas);
app.use(API_PATH + '/licencias', licencias);
app.use('/app', express.static(fileURLToPath(new URL('./demo/app', import.meta.url)))); // app de demo (http://localhost:PORT/app)
app.use('/demo/api/app', appDemo);
app.use('/demo/api/consola', consola);
app.use('/demo', demo); // panel para ejecutar cada problema y cada falla (http://localhost:PORT/demo)
app.use((req, res) => {
	res.status(404).json({ error: `No existe ${req.method} ${req.path}` });
});

// Manejador de errores (necesita los 4 parámetros)
app.use((err, req, res, next) => {
	if (err.code === 11000) err = new ErroresApp('Ya existe un registro con ese valor', 409, err.keyValue);
	if (err.code === 121) err = new ErroresApp('El documento no cumple el esquema', 400, err.errInfo?.details);

	if (err.type === 'entity.parse.failed') err = new ErroresApp('El body no es un JSON válido', 400);

	if (err instanceof ErroresApp) {
		return res.status(err.status).json({ error: err.message, detalle: err.detalle, idSaga: err.idSaga });
	}

	console.error(err);
	res.status(500).json({ error: 'Error interno', idSaga: err.idSaga });
});

app.listen(process.env.PORT, () => {
	console.log(`Server is running on port ${process.env.PORT}`);
});

// P6: listener de expiraciones de Redis + barrido de respaldo
const detenerVigilancia = await iniciarVigilancia();

process.on('SIGINT', async () => {
	await detenerVigilancia();
	await Promise.allSettled([mongo.close(), neo4j.close(), redis.quit(), cassandraClient.shutdown(), postgres.end()]);
	process.exit(0);
});