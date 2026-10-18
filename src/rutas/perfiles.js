import { Router } from 'express';
import { esId } from '../lib/ids.js';
import { pedidoInvalido } from '../lib/errores.js';
import { continuarViendo, historial } from '../problemas/p3-progreso.js';
import { recomendar } from '../problemas/p5-recomendaciones.js';

const router = Router();

router.param('idPerfil', (req, res, next, idPerfil) => {
	if (!esId(idPerfil)) throw pedidoInvalido(`"${idPerfil}" no es un id válido`);
	next();
});

// P3: "continuar viendo" (Redis; si se perdió, se reconstruye desde Cassandra)
router.get('/:idPerfil/continuar-viendo', async (req, res) => {
	res.json(await continuarViendo(req.params.idPerfil, req.query));
});

// P3: historial de visualizaciones por período (?desde=AAAA-MM&hasta=AAAA-MM)
router.get('/:idPerfil/historial', async (req, res) => {
	res.json(await historial(req.params.idPerfil, req.query));
});

// P5: 10 recomendaciones con su "porque viste X"
router.get('/:idPerfil/recomendaciones', async (req, res) => {
	res.json(await recomendar(req.params.idPerfil, req.query));
});

export default router;
