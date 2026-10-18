import { Router } from 'express';
import { esId } from '../lib/ids.js';
import { pedidoInvalido } from '../lib/errores.js';
import { cerrarSesionesDeCuenta, sesionesDeCuenta } from '../problemas/p6-expiracion-cierre-sesiones.js';

const router = Router();

router.param('idCuenta', (req, res, next, idCuenta) => {
	if (!esId(idCuenta)) throw pedidoInvalido(`"${idCuenta}" no es un id válido`);
	next();
});

// P6: el titular cierra de forma remota todas las sesiones de la cuenta (el cupo se libera de inmediato)
router.post('/:idCuenta/cerrar-sesiones', async (req, res) => {
	res.json(await cerrarSesionesDeCuenta(req.params.idCuenta));
});

// P6: sesiones activas (Redis) e historial de sesiones cerradas (Cassandra)
router.get('/:idCuenta/sesiones', async (req, res) => {
	res.json(await sesionesDeCuenta(req.params.idCuenta, req.query));
});

export default router;
