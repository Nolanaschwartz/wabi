import { Injectable, Controller, Get, HttpException, HttpStatus, Inject } from '@nestjs/common';
import { Client } from 'discord.js';
import { prisma } from '@wabi/shared';

@Injectable()
export class HealthService {
  constructor(@Inject(Client) private readonly client: Client) {}

  async checkGateway(): Promise<boolean> {
    return this.client.isReady();
  }

  async checkDb(): Promise<boolean> {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }

  async healthCheck() {
    const [gateway, db] = await Promise.all([
      this.checkGateway(),
      this.checkDb(),
    ]);
    const allOk = gateway && db;
    return {
      status: allOk ? 'ok' : 'degraded',
      checks: { gateway, db },
    };
  }
}

@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get()
  async check() {
    const result = await this.health.healthCheck();
    if (result.status === 'degraded') {
      throw new HttpException(result, HttpStatus.SERVICE_UNAVAILABLE);
    }
    return result;
  }
}
