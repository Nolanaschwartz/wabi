import { Injectable } from '@nestjs/common';

interface CrisisResourceEntry {
  name: string;
  phone?: string;
  url?: string;
  type: 'phone' | 'text' | 'web' | 'info';
}

interface CrisisResourceLocale {
  name: string;
  resources: CrisisResourceEntry[];
}

type CrisisResourcesMap = Record<string, CrisisResourceLocale>;

@Injectable()
export class CrisisResourcesService {
  private readonly resources: CrisisResourcesMap;

  constructor() {
    this.resources = require('./crisis-resources.json');
  }

  resourcesFor(locale: string): CrisisResourceLocale {
    return this.resources[locale] ?? this.resources['__fallback__'];
  }
}
