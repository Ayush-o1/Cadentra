import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import { Prisma, PrismaClient } from '../generated/prisma/client.js';

export type Db = PrismaClient;
export type Tx = Prisma.TransactionClient;

/**
 * Every pooled connection runs at READ COMMITTED. Under MySQL's default REPEATABLE READ,
 * the queue's locking reads take gap locks and concurrent workers deadlock. Prisma's
 * per-transaction `isolationLevel` option is not applied by the MariaDB driver adapter,
 * so the level is set when each connection is opened.
 */
export function createDb(databaseUrl: string): Db {
  const url = new URL(databaseUrl);
  const adapter = new PrismaMariaDb({
    host: url.hostname,
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.slice(1),
    connectionLimit: 10,
    // Hosted MySQL-compatible services close idle connections after a few minutes (TiDB Cloud
    // Starter: 340 s on public endpoints). Recycling idle ones sooner avoids handing out a dead one.
    idleTimeout: 240,
    minimumIdle: 2,
    initSql: 'SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED',
    ssl: url.searchParams.get('ssl') === 'true' ? { rejectUnauthorized: true } : undefined,
  });
  return new PrismaClient({ adapter });
}

export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
