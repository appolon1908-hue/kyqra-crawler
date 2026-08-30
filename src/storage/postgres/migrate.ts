import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runner } from 'node-pg-migrate';

export type MigrationDirection = 'up' | 'down';

const migrationDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../migrations',
);

export const migrateDatabase = async (
  databaseUrl: string,
  direction: MigrationDirection,
  count = direction === 'up' ? Number.POSITIVE_INFINITY : 1,
): Promise<void> => {
  await runner({
    databaseUrl,
    direction,
    count,
    dir: migrationDirectory,
    migrationsTable: 'kyqra_migrations',
    checkOrder: true,
    singleTransaction: true,
  });
};

const parseCount = (value: string | undefined, direction: MigrationDirection): number => {
  if (!value) return direction === 'up' ? Number.POSITIVE_INFINITY : 1;
  if (value === 'all') return Number.POSITIVE_INFINITY;
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 1)
    throw new Error('migration_count_must_be_positive');
  return count;
};

const runCommand = async (): Promise<void> => {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const directionArgument = process.argv[2] ?? 'up';
  if (directionArgument !== 'up' && directionArgument !== 'down') {
    throw new Error('migration_direction_must_be_up_or_down');
  }
  await migrateDatabase(
    databaseUrl,
    directionArgument,
    parseCount(process.argv[3], directionArgument),
  );
};

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  runCommand().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`migration_failed: ${message}`);
    process.exitCode = 1;
  });
}
