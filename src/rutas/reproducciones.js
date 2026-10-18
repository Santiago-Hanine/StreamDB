import { Router } from 'express';
import { iniciarReproduccion } from '../problemas/p2-inicio-reproduccion-sesiones.js';
import { reportarProgreso } from '../problemas/p3-progreso.js';
import { finEpisodio } from '../problemas/p4-fin-episodio.js';
import { cerrarSesion } from '../problemas/p6-expiracion-cierre-sesiones.js';

const router = Router();

router.post('/', async (req, res) => {
	res.status(201).json(await iniciarReproduccion(req.body, { fallarEn: req.query.fallarEn }));
});

// P3: el reproductor informa el segundo actual cada pocos segundos (y al pausar o cerrar)
router.post('/:idSesion/progreso', async (req, res) => {
	res.json(await reportarProgreso(req.params.idSesion, req.body));
});

// P4: terminó el episodio (o la película). ?fallarEn=marcar_finalizado|continuar_viendo|senal_vio
router.post('/:idSesion/fin', async (req, res) => {
	res.json(await finEpisodio(req.params.idSesion, { fallarEn: req.query.fallarEn }));
});

// P6: el dispositivo cierra su sesión (libera su lugar en el cupo)
router.delete('/:idSesion', async (req, res) => {
	res.json(await cerrarSesion(req.params.idSesion));
});

export default router;