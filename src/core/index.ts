import { logger } from '../logger.js';
import { main } from './main.js';

// Guard: only run when executed directly, not when imported by tests
const isDirectRun = process.argv[1] && new URL(import.meta.url).pathname === new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((e) => {
    logger.error({ e }, `Something bad happened at main() level`);
    process.exit(1);
  });
}
