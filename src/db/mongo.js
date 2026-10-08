import { MongoClient } from "mongodb";

const connectionString = process.env.MONGO_URL || "";
if (!connectionString) throw new Error("Falta MONGO_URL en las variables de entorno");

export const client = new MongoClient(connectionString);

try {
	await client.connect();
	console.log("Connected to MongoDB");
} catch (error) {
	console.error("Error connecting to MongoDB", error);
	process.exit(1);
}

const db = client.db();

process.on('SIGINT', async () => {
	await client.close();
	process.exit(0);
});

export default db;