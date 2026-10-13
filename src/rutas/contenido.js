import { Router } from 'express';
import { esId } from '../lib/ids.js';
import { pedidoInvalido, conflicto } from '../lib/errores.js';
import { explorar } from '../problemas/p7-exploracion.js';

const router = Router();

// Valida :id en TODAS las rutas de este router que lo usen, antes de llegar a los motores
router.param('id', (req, res, next, id) => {
	if (!esId(id)) throw pedidoInvalido(`"${id}" no es un id válido`);
	next();
});

// P7: exploración (por ahora solo responde lo que recibió)
router.get('/', async (req, res) => {
	res.json(await explorar(req.query));
});

// Ficha de un contenido: sirve para probar router.param
router.get('/:id', async (req, res) => {
	res.json({ id: req.params.id });
});

export default router;