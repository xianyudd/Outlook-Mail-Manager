import Router from 'koa-router';
import { HealthController } from '../controllers/HealthController';

export const healthRoutes = new Router();
const ctrl = new HealthController();

healthRoutes.get('/healthz', ctrl.healthz);
healthRoutes.get('/readyz', ctrl.readyz);
