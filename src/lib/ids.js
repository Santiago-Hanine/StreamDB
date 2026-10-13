import { randomUUID } from 'node:crypto';

export const UUID_PATTERN = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

const uuidRegex = new RegExp(UUID_PATTERN);

export const nuevoId = () => randomUUID();

export const esId = (valor) => typeof valor === 'string' && uuidRegex.test(valor);
