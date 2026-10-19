// Punto de entrada: cada vista se registra al importarse y después se pinta la ruta actual.
import { arrancar } from './router.js';
import './inicio.js';
import './usuario.js';
import { iniciar as iniciarAdmin } from './admin.js';

iniciarAdmin();
arrancar();
