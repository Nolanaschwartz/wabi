import { Injectable, Controller, Get, HttpException, HttpStatus, Inject } from '@nestjs/common';
import { Client } from 'discord.js';
import { prisma } from '@wabi/shared';
import { SchedulerService } from '../scheduler/scheduler.service';

@Injectable()
export class HealthService {
  constructor(
    @Inject(Client) private readonly client: Client,
    private readonly scheduler: SchedulerService,
  ) {}

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
    // The job buckets are surfaced for an operator but do NOT gate `status`: a failed registration
    // doesn't stop the bot serving DMs, and a 503 here would only bounce the process pointlessly.
    return {
      status: allOk ? 'ok' : 'degraded',
      checks: { gateway, db },
      jobs: this.scheduler.jobStatus,
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
