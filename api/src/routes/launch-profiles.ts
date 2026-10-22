import { Router } from 'express';
import type { LaunchOptionCatalog } from '../contract/index.js';
import { getLaunchProfileCatalog, janusErrorMessage, launchOptionOf } from '../launch-profiles.js';

export const launchProfilesRouter = Router();

launchProfilesRouter.get('/', async (_req, res) => {
  res.json(publicCatalog(await getLaunchProfileCatalog()));
});

launchProfilesRouter.post('/refresh', async (_req, res) => {
  res.json(publicCatalog(await getLaunchProfileCatalog(true)));
});

function publicCatalog(catalog: Awaited<ReturnType<typeof getLaunchProfileCatalog>>): LaunchOptionCatalog {
  return {
    ...catalog,
    profiles: catalog.profiles.map(launchOptionOf),
    // Cached with the catalog; worded in the asking app's language.
    janus: catalog.janus.error ? { ...catalog.janus, error: { ...catalog.janus.error, message: janusErrorMessage(catalog.janus.error.code) } } : catalog.janus,
  };
}
