// Punto de entrada: cada vista se registra al importarse y después se pinta la ruta actual.
import { arrancar, registrar } from './router.js';

registrar('inicio', (vista) => { vista.innerHTML = '<h1>StreamDB</h1>'; });

arrancar();
