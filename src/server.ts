import type { Server } from 'node:http';
import { createApp } from './app.js';
import { ConfigError, loadConfig } from './config/env.js';
import { createDb } from './lib/db.js';
import { createLogger } from './lib/logger.js';

const SHUTDOWN_TIMEOUT_MS = 15_000;

function main(): void {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }

  const logger = createLogger(config);
  const db = createDb(config.databaseUrl);
  const app = createApp({ config, logger, db });
  const server: Server = app.listen(config.port, () => {
    logger.info({ port: config.port, env: config.env }, 'Cadentra is listening');
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down');

    const forceExit = setTimeout(() => {
      logger.error('Shutdown timed out, exiting');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    server.close((error) => {
      if (error) {
        logger.error({ err: error }, 'Error while closing the HTTP server');
        process.exit(1);
      }
      db.$disconnect().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    });
    server.closeIdleConnections();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main();
