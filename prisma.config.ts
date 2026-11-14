import { defineConfig } from 'prisma/config';

try {
  process.loadEnvFile('.env');
} catch {
  // No .env file: rely on variables already present in the environment.
}

const shadowDatabaseUrl = process.env['SHADOW_DATABASE_URL'];

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations', seed: 'tsx --env-file-if-exists=.env prisma/seed.ts' },
  datasource: {
    url: process.env['DATABASE_URL'] ?? '',
    ...(shadowDatabaseUrl ? { shadowDatabaseUrl } : {}),
  },
});
