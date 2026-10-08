export class ErroresApp extends Error {

	constructor(mensaje, status = 500, detalle) {
		super(mensaje)
		this.name = 'ErroresApp'
		this.status = status
		this.detalle = detalle
	}
}

export const pedidoInvalido = (mensaje, detalle) => new ErroresApp(mensaje, 400, detalle);
export const noEncontrado = (mensaje, detalle) => new ErroresApp(mensaje, 404, detalle);
export const conflicto = (mensaje, detalle) => new ErroresApp(mensaje, 409, detalle);