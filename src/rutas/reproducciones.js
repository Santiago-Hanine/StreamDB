import { Router } from 'express';
import { iniciarReproduccion } from '../problemas/p2-inicio-reproduccion-sesiones.js';
import { reportarProgreso } from '../problemas/p3-progreso.js';
import { finEpisodio } from '../problemas/p4-fin-episodio.js';
import { cerrarSesion } from '../problemas/p6-expiracion-cierre-sesiones.js';

const router = Router();

router.post('/', async (req, res) => {
	res.status(201).json(await iniciarReproduccion(req.body, { fallarEn: req.query.fallarEn }));
});

// P3: progreso
router.post('/:idSesion/progreso', async (req, res) => {
	res.json(await reportarProgreso(req.params.idSesion, req.body));
});

// P4: fin de episodio (?fallarEn=marcar_finalizado|continuar_viendo|senal_vio)
router.post('/:idSesion/fin', async (req, res) => {
	res.json(await finEpisodio(req.params.idSesion, { fallarEn: req.query.fallarEn }));
});

// P6: cierre manual
router.delete('/:idSesion', async (req, res) => {
	res.json(await cerrarSesion(req.params.idSesion));
});

export default router;