import { MongoClient } from "mongodb";

const connectionString = process.env.MONGO_URL || "";
if (!connectionString) throw new Error("Falta MONGO_URL en las variables de entorno");

// Fallar rápido (por defecto espera 30 s a que aparezca el servidor), igual que en Neo4j.
// monitorCommands: emite un evento por comando, que usa el panel de demo para la traza (src/demo/traza.js)
export const client = new MongoClient(connectionString, { serverSelectionTimeoutMS: 5000, monitorCommands: true });

try {
	await client.connect();
	console.log("Connected to MongoDB");
} catch (error) {
	console.error("Error connecting to MongoDB", error);
	process.exit(1);
}

const db = client.db();

export default db;