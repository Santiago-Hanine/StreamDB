// Corta una promesa que tarda demasiado (ej. un ping a un motor caído que el cliente deja en cola)
export function conLimite(promesa, ms) {
	let temporizador;
	const limite = new Promise((_, rechazar) => {
		temporizador = setTimeout(() => rechazar(new Error(`tardó más de ${ms} ms`)), ms);
	});
	return Promise.race([promesa, limite]).finally(() => clearTimeout(temporizador));
}
