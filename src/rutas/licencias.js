import { Router } from 'express';
import { procesarVencimientos } from '../problemas/p8-retiro-trazabilidad.js';

const router = Router();

// P8: retira los contenidos cuyas licencias vencieron (?fecha=AAAA-MM-DD para simular otro día)
router.post('/procesar-vencimientos', async (req, res) => {
	res.json(await procesarVencimientos(req.query));
});

export default router;
