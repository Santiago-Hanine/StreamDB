import 'dotenv/config';
import express from 'express';
import './db/mongo.js';
import contenidos from './rutas/contenido.js';
import { ErroresApp } from './lib/errores.js';

const API_PATH = process.env.API_PATH || '/api/v1';

export const app = express();
app.use(express.json());

// 1. Rutas
app.use(API_PATH + '/contenidos', contenidos);

// 2. Ruta inexistente
app.use((req, res) => {
	res.status(404).json({ error: `No existe ${req.method} ${req.path}` });
});

// 3. Manejador de errores: necesita los 4 parámetros y va siempre al final
app.use((err, req, res, next) => {
	// Errores conocidos de Mongo
	if (err.code === 11000) err = new ErroresApp('Ya existe un registro con ese valor', 409, err.keyValue);
	if (err.code === 121) err = new ErroresApp('El documento no cumple el esquema', 400, err.errInfo?.details);

	// JSON mal formado en el body
	if (err.type === 'entity.parse.failed') err = new ErroresApp('El body no es un JSON válido', 400);

	if (err instanceof ErroresApp) {
		return res.status(err.status).json({ error: err.message, detalle: err.detalle, idSaga: err.idSaga });
	}

	// Inesperado: se loguea completo, pero al cliente no se le muestran detalles internos
	console.error(err);
	res.status(500).json({ error: 'Error interno', idSaga: err.idSaga });
});

// 4. Arrancar
app.listen(process.env.PORT, () => {
	console.log(`Server is running on port ${process.env.PORT}`);
});