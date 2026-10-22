import { resolve } from 'node:path';
import { reconcileDialogueArchive } from '../src/dialogue-reconciliation.js';

const args = process.argv.slice(2);
const sourceIndex = args.indexOf('--source');
const source = sourceIndex >= 0 ? args[sourceIndex + 1] : undefined;
const apply = args.includes('--apply');
if (!source || args.some((arg, index) => arg === '--source' && index !== sourceIndex) || args.some((arg) => !['--source', source, '--apply'].includes(arg))) {
  console.error('Usage: npm run reconcile-dialogue-archive -- --source <UUID-layout-jsonl> [--apply]');
  console.error('Default is dry-run; --apply copies one fully validated source and never deletes it.');
  process.exitCode = 2;
} else {
  const result = await reconcileDialogueArchive(resolve(source), { apply });
  console.log(JSON.stringify(result, null, 2));
  if (result.status === 'rejected') process.exitCode = 1;
}
