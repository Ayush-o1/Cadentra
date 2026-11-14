import { execFileSync } from 'node:child_process';
import { TEST_DATABASE_URL } from './helpers.js';

export default function setup(): void {
  const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: TEST_DATABASE_URL };
  delete env['SHADOW_DATABASE_URL'];
  try {
    execFileSync('npx', ['prisma', 'migrate', 'deploy'], { env, encoding: 'utf8', stdio: 'pipe' });
  } catch (error) {
    const output = error as { stdout?: string; stderr?: string };
    throw new Error(
      `Could not migrate the test database. Is MySQL running (npm run db:up)?\n${output.stdout ?? ''}${output.stderr ?? ''}`,
      { cause: error },
    );
  }
}
