import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApi } from '../../src/api/app.js';
import { migrateDatabase } from '../../src/storage/postgres/migrate.js';
import type { Runtime } from '../../src/types.js';

const POSTGRES_IMAGE =
  'postgres:17-alpine@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73';

const legacyTables = ['job_requests', 'jobs', 'results'];
const targetTables = [
  'audit_log',
  'credentials',
  'dead_letters',
  'deliveries',
  'domains',
  'extractions',
  'frontier',
  'job_requests',
  'jobs',
  'pages',
  'results',
  'robots_cache',
  'schemas',
  'service_principals',
  'sessions',
  'tenants',
];

describe('PostgreSQL migrations', () => {
  let postgres: StartedPostgreSqlContainer;
  let db: pg.Pool;

  const applicationTables = async (): Promise<string[]> => {
    const result = await db.query<{ table_name: string }>(
      `select table_name
         from information_schema.tables
        where table_schema='public'
          and table_type='BASE TABLE'
          and table_name <> 'kyqra_migrations'
        order by table_name`,
    );
    return result.rows.map(({ table_name }) => table_name);
  };

  const jobColumns = async (): Promise<string[]> => {
    const result = await db.query<{ column_name: string }>(
      `select column_name
         from information_schema.columns
        where table_schema='public' and table_name='jobs'
        order by column_name`,
    );
    return result.rows.map(({ column_name }) => column_name);
  };

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer(POSTGRES_IMAGE)
      .withDatabase('crawler')
      .withUsername('crawler')
      .withPassword('fixture-only-not-production')
      .start();
    db = new pg.Pool({ connectionString: postgres.getConnectionUri() });
  });

  afterAll(async () => {
    await db?.end();
    await postgres?.stop();
  });

  it('does not execute DDL while constructing the API', async () => {
    const runtime = { db } as unknown as Runtime;
    const app = await buildApi(runtime);
    await app.close();
    expect(await applicationTables()).toEqual([]);
  });

  it('applies and reverses every migration, then reapplies the full schema', async () => {
    const databaseUrl = postgres.getConnectionUri();

    await migrateDatabase(databaseUrl, 'up', 1);
    expect(await applicationTables()).toEqual(legacyTables);
    expect(await jobColumns()).toContain('payload');

    await migrateDatabase(databaseUrl, 'down', 1);
    expect(await applicationTables()).toEqual([]);

    await migrateDatabase(databaseUrl, 'up', 1);
    await migrateDatabase(databaseUrl, 'up', 1);
    expect(await applicationTables()).toEqual(targetTables);
    expect(await jobColumns()).toEqual(
      expect.arrayContaining(['budget', 'finished_at', 'spec', 'started_at', 'tenant_id']),
    );

    await migrateDatabase(databaseUrl, 'down', 1);
    expect(await applicationTables()).toEqual(legacyTables);
    expect(await jobColumns()).toContain('payload');
    expect(await jobColumns()).not.toContain('spec');

    await migrateDatabase(databaseUrl, 'down', 1);
    expect(await applicationTables()).toEqual([]);

    await migrateDatabase(databaseUrl, 'up');
    expect(await applicationTables()).toEqual(targetTables);

    await migrateDatabase(databaseUrl, 'down', 1);
    const legacyJobId = '00000000-0000-4000-8000-000000000002';
    await db.query("insert into jobs(id,status,payload) values($1,'queued',$2)", [
      legacyJobId,
      { startUrls: ['https://fixture.test'] },
    ]);
    await db.query(
      'insert into job_requests(job_id,idempotency_key,request_hash,correlation_id,tenant_id) values($1,$2,$3,$4,$5)',
      [legacyJobId, 'legacy-request', 'legacy-hash', 'legacy-correlation', 'legacy-tenant'],
    );
    await db.query('truncate table kyqra_migrations');

    await migrateDatabase(databaseUrl, 'up');
    const adopted = await db.query<{ spec: { startUrls: string[] }; tenant_id: string }>(
      'select spec,tenant_id from jobs where id=$1',
      [legacyJobId],
    );
    expect(adopted.rows[0]).toEqual({
      spec: { startUrls: ['https://fixture.test'] },
      tenant_id: 'legacy-tenant',
    });
    expect(await applicationTables()).toEqual(targetTables);
  });
});
