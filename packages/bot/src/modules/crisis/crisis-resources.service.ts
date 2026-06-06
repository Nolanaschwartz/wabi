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

const RESOURCES: Record<string, CrisisResourceLocale> = {
  'en-US': {
    name: 'United States',
    resources: [
      { name: '988 Suicide & Crisis Lifeline', phone: '988', type: 'phone' },
      { name: 'Crisis Text Line', phone: 'Text HOME to 741741', type: 'text' },
      { name: 'Trevor Project Lifeline', phone: '1-866-488-7386', type: 'phone' },
    ],
  },
  'en-GB': {
    name: 'United Kingdom',
    resources: [
      { name: 'Shout (Crisis Text)', phone: 'Text SHOUT to 85258', type: 'text' },
      { name: 'Samaritans', phone: '116 123', type: 'phone' },
    ],
  },
  'en-CA': {
    name: 'Canada',
    resources: [
      { name: 'Talk Suicide Canada', phone: '1-833-456-4566', type: 'phone' },
      { name: 'Text4Hope', phone: 'Text 4HOPE to 55555', type: 'text' },
    ],
  },
  'en-AU': {
    name: 'Australia',
    resources: [
      { name: 'Lifeline Australia', phone: '13 11 14', type: 'phone' },
      { name: 'Beyond Blue', phone: '1300 22 4636', type: 'phone' },
    ],
  },
  'en-IE': {
    name: 'Ireland',
    resources: [
      { name: 'Samaritans of Ireland', phone: '116 123', type: 'phone' },
      { name: 'TextHome', phone: 'Text HOME to 50808', type: 'text' },
    ],
  },
  '__fallback__': {
    name: 'International',
    resources: [
      { name: 'Find A Helpline', url: 'https://findahelpline.com', type: 'web' },
      { name: 'Befrienders Worldwide', url: 'https://www.befrienders.org', type: 'web' },
      { name: 'Contact your local emergency services', type: 'info' },
    ],
  },
};

@Injectable()
export class CrisisResourcesService {
  resourcesFor(locale: string): CrisisResourceLocale {
    return RESOURCES[locale] ?? RESOURCES['__fallback__'];
  }
}
