import { arrancar } from './router.js';
import './inicio.js';
import './usuario.js';
import './consola.js';
import { iniciar as iniciarAdmin } from './admin.js';
import { iniciar as iniciarPlayer } from './player.js';

iniciarPlayer();
iniciarAdmin();
arrancar();
