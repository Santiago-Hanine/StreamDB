import express from 'express';
import 'dotenv/config';
import db from './db/mongo.js';

export const app = express();

app.use(express.json());

app.listen(process.env.PORT, () => {
	console.log(`Server is running on port ${process.env.PORT}`);
});