import { Router } from 'express';
import { iniciarReproduccion } from '../problemas/p2-inicio-reproduccion-sesiones.js';

const router = Router();

router.post('/', async (req, res) => {
	res.status(201).json(await iniciarReproduccion(req.body, { fallarEn: req.query.fallarEn }));
});

export default router;