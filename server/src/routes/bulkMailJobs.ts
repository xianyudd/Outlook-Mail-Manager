import Router from 'koa-router';
import { BulkMailJobController } from '../controllers/BulkMailJobController';

export const bulkMailJobRoutes = new Router();
const ctrl = new BulkMailJobController();

bulkMailJobRoutes.post('/', ctrl.create);
bulkMailJobRoutes.get('/:jobId', ctrl.detail);
bulkMailJobRoutes.get('/:jobId/items', ctrl.items);
