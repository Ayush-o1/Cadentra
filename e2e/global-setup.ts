import { execFileSync } from 'node:child_process';

export default function globalSetup(): void {
  const url =
    process.env['TEST_DATABASE_URL'] ?? 'mysql://cadentra:cadentra@127.0.0.1:3307/cadentra_test';
  const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: url };
  delete env['SHADOW_DATABASE_URL'];
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], { env, stdio: 'pipe' });
}
