import { defineConfig } from 'prisma/config';

try {
  process.loadEnvFile('.env');
} catch {
  // No .env file: rely on variables already present in the environment.
}

/**
 * The application reads `?ssl=true` from DATABASE_URL, but Prisma's migration engine only
 * understands `sslaccept`. Translate, so one connection string works for both and a TLS-only host
 * (TiDB Cloud, most managed MySQL) does not reject `migrate deploy` for connecting without TLS.
 */
function forMigrationEngine(raw: string | undefined): string {
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (url.searchParams.get('ssl') === 'true' && !url.searchParams.has('sslaccept')) {
      url.searchParams.delete('ssl');
      url.searchParams.set('sslaccept', 'strict');
    }
    return url.toString();
  } catch {
    return raw;
  }
}

const shadowDatabaseUrl = process.env['SHADOW_DATABASE_URL'];

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations', seed: 'tsx --env-file-if-exists=.env prisma/seed.ts' },
  datasource: {
    url: forMigrationEngine(process.env['DATABASE_URL']),
    ...(shadowDatabaseUrl ? { shadowDatabaseUrl } : {}),
  },
});
