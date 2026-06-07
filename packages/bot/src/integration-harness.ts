import { GenericContainer, Wait } from 'testcontainers';
import { PrismaClient } from '@wabi/shared';
import { execSync } from 'child_process';
import { randomUUID } from 'crypto';
import { resolve } from 'path';

const POSTGRES_IMAGE = 'postgres:17-alpine';
const REDIS_IMAGE = 'redis:7-alpine';
const QDRANT_IMAGE = 'qdrant/qdrant:v1.18.0';

export interface IntegrationEnv {
  postgresUrl: string;
  redisUrl: string;
  qdrantUrl: string;
}

export async function startInfra(): Promise<IntegrationEnv & { stop: () => Promise<void> }> {
  const postgres = await new GenericContainer(POSTGRES_IMAGE)
    .withEnvironment({
      POSTGRES_USER: 'test',
      POSTGRES_PASSWORD: 'test',
      POSTGRES_DB: 'wabi_test',
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forListeningPorts())
    .start();

  const redis = await new GenericContainer(REDIS_IMAGE)
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forListeningPorts())
    .start();

  const qdrant = await new GenericContainer(QDRANT_IMAGE)
    .withEnvironment({
      QDRANT__SERVICE__GRPC_PORT: '6334',
    })
    .withExposedPorts(6333, 6334)
    .withWaitStrategy(Wait.forListeningPorts())
    .start();

  const postgresHost = postgres.getHost();
  const postgresPort = postgres.getMappedPort(5432);
  const postgresUrl = `postgresql://test:test@${postgresHost}:${postgresPort}/wabi_test`;

  const redisHost = redis.getHost();
  const redisPort = redis.getMappedPort(6379);
  const redisUrl = `redis://${redisHost}:${redisPort}`;

  const qdrantHost = qdrant.getHost();
  const qdrantPort = qdrant.getMappedPort(6333);
  const qdrantUrl = `http://${qdrantHost}:${qdrantPort}`;

  // Push schema to the test database. Resolve the shared package dir from this
  // file's location so it works regardless of the process working directory.
  const sharedDir = resolve(__dirname, '../../shared');
  const tmpEnv = { DATABASE_URL: postgresUrl };
  execSync('npx prisma db push --accept-data-loss --skip-generate', {
    cwd: sharedDir,
    env: { ...process.env, ...tmpEnv },
  });

  return {
    postgresUrl,
    redisUrl,
    qdrantUrl,
    async stop() {
      await Promise.all([postgres.stop(), redis.stop(), qdrant.stop()]);
    },
  };
}

/**
 * Creates a Prisma client pointed at the test database. Always close it after use.
 */
export function createTestPrisma(postgresUrl: string): PrismaClient {
  return new PrismaClient({
    datasources: { db: { url: postgresUrl } },
  });
}

/**
 * Generate a random Discord ID for isolation between tests.
 */
export function randomDiscordId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 17);
}
