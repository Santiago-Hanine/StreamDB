import { Router } from 'express';
import { esId } from '../lib/ids.js';
import { pedidoInvalido, conflicto } from '../lib/errores.js';
import { altaSerie } from '../problemas/p1-alta-serie.js';
import { explorar } from '../problemas/p7-exploracion.js';
import { retirarContenido, trazabilidad } from '../problemas/p8-retiro-trazabilidad.js';

const router = Router();

// Valida :id en TODAS las rutas de este router que lo usen, antes de llegar a los motores
router.param('id', (req, res, next, id) => {
	if (!esId(id)) throw pedidoInvalido(`"${id}" no es un id válido`);
	next();
});


router.post('/series', async (req, res) => {
	res.status(201).json(await altaSerie(req.body, { fallarEn: req.query.fallarEn }));
});


// P7: exploración (por ahora solo responde lo que recibió)
router.get('/', async (req, res) => {
	res.json(await explorar(req.query));
});

// Ficha de un contenido: sirve para probar router.param
router.get('/:id', async (req, res) => {
	res.json({ id: req.params.id });
});

// P8: retiro por fin de licencia (?fallarEn=continuar_viendo|marcar_nodo|retirar_ficha|vencer_licencias)
router.post('/:id/retiro', async (req, res) => {
	res.json(await retirarContenido(req.params.id, { fecha: req.body?.fecha, fallarEn: req.query.fallarEn }));
});

// P8: trazabilidad en una sola consulta (ficha, vínculos, viendo ahora, historial y licencias)
router.get('/:id/trazabilidad', async (req, res) => {
	res.json(await trazabilidad(req.params.id, req.query));
});

export default router;