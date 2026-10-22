import { Router } from 'express';
import type { ModuleFactory } from '../../../../src/module-host/types.js';

// The smallest optional module (src/module-host/types.ts), for the loader's tests.
const createExampleModule: ModuleFactory = (host) => ({
  id: 'example',
  capabilities: ['example_feature'],
  routes: [{ path: '/example', router: Router().get('/', (_req, res) => res.json({ stateDir: host.stateDir })) }],
});

export default createExampleModule;
