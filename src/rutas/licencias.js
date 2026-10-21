import { Router } from 'express';
import { procesarVencimientos } from '../problemas/p8-retiro-trazabilidad.js';

const router = Router();

// P8: proceso de vencimientos (?fecha=AAAA-MM-DD)
router.post('/procesar-vencimientos', async (req, res) => {
	res.json(await procesarVencimientos(req.query));
});

export default router;
