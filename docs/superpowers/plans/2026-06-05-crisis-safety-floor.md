# Crisis Safety Floor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the zero-dependency crisis safety floor — tripwire keyword matching, locale-aware resource surfacing, and escalation event logging — wired into the message flow before coaching.

**Architecture:** Pure TS service for tripwire (sync, no deps). File-based CrisisResources service (reads `crisis-resources.json` at startup). EscalationEvent persisted via Prisma. All wired into NestJS as a module, injected into EchoController.

**Tech Stack:** NestJS, Prisma, Jest, TypeScript

---

### Task 1: EscalationEvent Prisma Model

**Files:**
- Modify: `packages/shared/prisma/schema.prisma`
- Modify: `packages/shared/prisma/migrations/` (generate migration)

- [ ] **Step 1: Add EscalationEvent model to schema**

Append to `packages/shared/prisma/schema.prisma`:

```prisma
model EscalationEvent {
  id        String   @id @default(uuid())
  userId    String?
  timestamp DateTime @default(now())
  layer     String   @default("tripwire")

  @@index([userId])
  @@index([timestamp])
}
```

- [ ] **Step 2: Generate and apply migration**

Run:
```bash
cd packages/shared
npx prisma migrate dev --name add_escalation_event
```

Expected: Migration created, schema applied.

- [ ] **Step 3: Regenerate Prisma client**

Run:
```bash
cd packages/shared
npx prisma generate
```

Expected: Client regenerated at `packages/shared/generated/prisma`.

- [ ] **Step 4: Commit**

```bash
git add packages/shared/prisma/schema.prisma packages/shared/prisma/migrations/ packages/shared/generated/prisma/
git commit -m "feat: add EscalationEvent model for crisis escalation logging"
```

### Task 2: crisis-resources.json

**Files:**
- Create: `packages/bot/src/modules/crisis/crisis-resources.json`

- [ ] **Step 1: Write crisis-resources.json**

```json
{
  "en-US": {
    "name": "United States",
    "resources": [
      { "name": "988 Suicide & Crisis Lifeline", "phone": "988", "type": "phone" },
      { "name": "Crisis Text Line", "phone": "Text HOME to 741741", "type": "text" },
      { "name": "Trevor Project Lifeline", "phone": "1-866-488-7386", "type": "phone" }
    ]
  },
  "en-GB": {
    "name": "United Kingdom",
    "resources": [
      { "name": "Shout (Crisis Text)", "phone": "Text SHOUT to 85258", "type": "text" },
      { "name": "Samaritans", "phone": "116 123", "type": "phone" }
    ]
  },
  "en-CA": {
    "name": "Canada",
    "resources": [
      { "name": "Talk Suicide Canada", "phone": "1-833-456-4566", "type": "phone" },
      { "name": "Text4Hope", "phone": "Text 4HOPE to 55555", "type": "text" }
    ]
  },
  "en-AU": {
    "name": "Australia",
    "resources": [
      { "name": "Lifeline Australia", "phone": "13 11 14", "type": "phone" },
      { "name": "Beyond Blue", "phone": "1300 22 4636", "type": "phone" }
    ]
  },
  "en-IE": {
    "name": "Ireland",
    "resources": [
      { "name": "Samaritans of Ireland", "phone": "116 123", "type": "phone" },
      { "name": "TextHome", "phone": "Text HOME to 50808", "type": "text" }
    ]
  },
  "__fallback__": {
    "name": "International",
    "resources": [
      { "name": "Find A Helpline", "url": "https://findahelpline.com", "type": "web" },
      { "name": "Befrienders Worldwide", "url": "https://www.befrienders.org", "type": "web" },
      { "name": "Contact your local emergency services", "type": "info" }
    ]
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/bot/src/modules/crisis/crisis-resources.json
git commit -m "feat: add crisis-resources.json with US/UK/CA/AU/IE + international fallback"
```

### Task 3: CrisisScreening.tripwire

**Files:**
- Create: `packages/bot/src/modules/crisis/crisis-screening.service.ts`

- [ ] **Step 1: Write the service**

```typescript
import { Injectable } from '@nestjs/common';

@Injectable()
export class CrisisScreeningService {
  private readonly explicitPatterns: RegExp[] = [
    /\bI don'?t want to live\b/i,
    /\bI don'?t want to be alive\b/i,
    /\bI don'?t want to wake up\b/i,
    /\bI want to die\b/i,
    /\bI want to kill myself\b/i,
    /\bsuicid/i,
    /\bending it all\b/i,
    /\bno reason to live\b/i,
    /\bI'?m better off dead\b/i,
    /\bI'?m going to hurt myself\b/i,
    /\bI'?m going to kill myself\b/i,
    /\bsay goodbye\b/i,
    /\bI can'?t go on\b/i,
    /\bthere'?s no point\b/i,
    /\bI want to end this\b/i,
    /\bI'?m going to end it\b/i,
    /\bI wish I were dead\b/i,
    /\bI want to go to sleep and never wake up\b/i,
    /\bI can'?t do this anymore\b/i,
    /\bI'?m so tired of living\b/i,
    /\bI'?m going to jump\b/i,
    /\bI have a plan to kill myself\b/i,
    /\bI want to overdose\b/i,
    /\bI want to slit my wrists\b/i,
    /\bI'?m going to hang myself\b/i,
  ];

  private readonly gamerSafePatterns: string[] = [
    'kys',
    'this boss wants me dead',
    'I need a break from this game',
    'I want to rage quit',
    'I give up on this level',
    'this is impossible',
    'I'?m so bad at this',
    'my team is throwing',
    'this is a lost cause',
    'I'?m so fed up with this',
    'I can'?t take this anymore',
    'I want to throw my keyboard',
    'this is killing me',
    'I'?m dying of laughter',
    'I'?m dead inside',
    'I need to log off',
    'I want to uninstall',
    'I'?m so done with this',
  ];

  tripwire(text: string): boolean {
    const lowerText = text.toLowerCase();

    for (const pattern of this.explicitPatterns) {
      if (pattern.test(lowerText)) {
        return true;
      }
    }

    return false;
  }
}
```

Note: The `gamerSafePatterns` array is documentation-only — it lists phrases that should NOT trigger. The explicit patterns are the only ones that fire. The gamer safe patterns are tested in unit tests to verify they don't match.

- [ ] **Step 2: Commit**

```bash
git add packages/bot/src/modules/crisis/crisis-screening.service.ts
git commit -m "feat: add CrisisScreeningService.tripwire with explicit crisis patterns"
```

### Task 4: CrisisResources.resourcesFor

**Files:**
- Create: `packages/bot/src/modules/crisis/crisis-resources.service.ts`
- Modify: `packages/bot/src/modules/crisis/crisis.module.ts` (create module)

- [ ] **Step 1: Create the service**

```typescript
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
```

- [ ] **Step 2: Create the NestJS module**

```typescript
import { Module } from '@nestjs/common';
import { CrisisScreeningService } from './crisis-screening.service';
import { CrisisResourcesService } from './crisis-resources.service';

@Module({
  providers: [CrisisScreeningService, CrisisResourcesService],
  exports: [CrisisScreeningService, CrisisResourcesService],
})
export class CrisisModule {}
```

- [ ] **Step 3: Commit**

```bash
git add packages/bot/src/modules/crisis/crisis-resources.service.ts packages/bot/src/modules/crisis/crisis.module.ts
git commit -m "feat: add CrisisResourcesService.resourcesFor with locale resolution"
```

### Task 5: Wire tripwire into EchoController

**Files:**
- Modify: `packages/bot/src/modules/echo/echo.controller.ts`
- Modify: `packages/bot/src/modules/echo/echo.module.ts`
- Modify: `packages/bot/src/app.module.ts`

- [ ] **Step 1: Update EchoController**

Replace the EchoController with:

```typescript
import { On } from 'necord';
import { Message } from 'discord.js';
import { Inject, forwardRef } from '@nestjs/common';
import { CrisisScreeningService } from '../crisis/crisis-screening.service';
import { CrisisResourcesService } from '../crisis/crisis-resources.service';
import { prisma } from '@wabi/shared';

@On('messageCreate')
export class EchoController {
  constructor(
    private readonly crisisScreening: CrisisScreeningService,
    private readonly crisisResources: CrisisResourcesService,
  ) {}

  async handleEcho(message: Message): Promise<void> {
    if (message.author.bot) return;
    if (!message.channel.isDMBased()) return;

    if (this.crisisScreening.tripwire(message.content)) {
      await this.handleCrisis(message);
      return;
    }

    await message.reply(`Echo: ${message.content}`);
  }

  private async handleCrisis(message: Message): Promise<void> {
    const resources = this.crisisResources.resourcesFor(message.author.locale ?? 'en-US');

    const resourceLines = resources.resources.map((r) => {
      if (r.type === 'web') return `• ${r.name}: ${r.url}`;
      if (r.type === 'info') return `• ${r.name}`;
      return `• ${r.name}: ${r.phone}`;
    });

    const embed = {
      color: 0x000000,
      title: '🚨 You matter',
      description:
        "If you're in crisis, real people are here to help. Please reach out:",
      fields: [{ name: 'Resources', value: resourceLines.join('\n'), inline: false }],
      footer: { text: 'These numbers are free and confidential' },
    };

    await message.reply({ embeds: [embed] });

    try {
      await prisma.escalationEvent.create({
        data: {
          userId: message.author.id,
          layer: 'tripwire',
        },
      });
    } catch {
      // Escalation event logging may fail if Postgres is down — that's OK.
      // The safety floor still worked: resources were surfaced.
    }
  }
}
```

- [ ] **Step 2: Update EchoModule to import CrisisModule**

```typescript
import { Module } from '@nestjs/common';
import { EchoController } from './echo.controller';
import { CrisisModule } from '../crisis/crisis.module';

@Module({
  controllers: [EchoController],
  imports: [CrisisModule],
})
export class EchoModule {}
```

- [ ] **Step 3: Commit**

```bash
git add packages/bot/src/modules/echo/echo.controller.ts packages/bot/src/modules/echo/echo.module.ts
git commit -m "feat: wire crisis tripwire into EchoController with resource surfacing"
```

### Task 6: Unit tests

**Files:**
- Create: `packages/bot/src/modules/crisis/__tests__/crisis-screening.spec.ts`
- Create: `packages/bot/src/modules/crisis/__tests__/crisis-resources.spec.ts`

- [ ] **Step 1: Write tripwire tests**

```typescript
import { CrisisScreeningService } from '../crisis-screening.service';

describe('CrisisScreeningService.tripwire', () => {
  let service: CrisisScreeningService;

  beforeEach(() => {
    service = new CrisisScreeningService();
  });

  describe('explicit crisis phrases → true', () => {
    const explicitPhrases = [
      'I want to die',
      'I don\'t want to live anymore',
      'I\'m going to kill myself',
      'I want to end this',
      'I wish I were dead',
      'I can\'t go on like this',
      'I\'m better off dead',
      'there\'s no point anymore',
      'I want to go to sleep and never wake up',
      'I have a plan to kill myself',
    ];

    it.each(explicitPhrases)('should fire on: "%s"', (phrase) => {
      expect(service.tripwire(phrase)).toBe(true);
    });
  });

  describe('gamer hyperbole → false', () => {
    const gamerPhrases = [
      'kys',
      'this boss wants me dead',
      'I give up on this level',
      'I\'m so bad at this',
      'this is killing me',
      'I\'m dying of laughter',
      'I\'m dead inside',
      'my team is throwing',
      'I want to rage quit',
      'I\'m so fed up with this',
    ];

    it.each(gamerPhrases)('should NOT fire on: "%s"', (phrase) => {
      expect(service.tripwire(phrase)).toBe(false);
    });
  });

  describe('normal conversation → false', () => {
    const normalPhrases = [
      'How are you today?',
      'I had a great day at work',
      'I\'m feeling anxious about the weather',
      'Can you help me with something?',
      'I need some advice on my skincare routine',
    ];

    it.each(normalPhrases)('should NOT fire on: "%s"', (phrase) => {
      expect(service.tripwire(phrase)).toBe(false);
    });
  });
});
```

- [ ] **Step 2: Write resources tests**

```typescript
import { CrisisResourcesService } from '../crisis-resources.service';

describe('CrisisResourcesService.resourcesFor', () => {
  let service: CrisisResourcesService;

  beforeEach(() => {
    service = new CrisisResourcesService();
  });

  it('should return US resources for en-US', () => {
    const result = service.resourcesFor('en-US');
    expect(result.name).toBe('United States');
    expect(result.resources.some((r) => r.phone === '988')).toBe(true);
  });

  it('should return UK resources for en-GB', () => {
    const result = service.resourcesFor('en-GB');
    expect(result.name).toBe('United Kingdom');
    expect(result.resources.some((r) => r.phone === '116 123')).toBe(true);
  });

  it('should return CA resources for en-CA', () => {
    const result = service.resourcesFor('en-CA');
    expect(result.name).toBe('Canada');
    expect(result.resources.some((r) => r.phone === '1-833-456-4566')).toBe(true);
  });

  it('should return AU resources for en-AU', () => {
    const result = service.resourcesFor('en-AU');
    expect(result.name).toBe('Australia');
    expect(result.resources.some((r) => r.phone === '13 11 14')).toBe(true);
  });

  it('should return IE resources for en-IE', () => {
    const result = service.resourcesFor('en-IE');
    expect(result.name).toBe('Ireland');
    expect(result.resources.some((r) => r.phone === '116 123')).toBe(true);
  });

  it('should return international fallback for unknown locale', () => {
    const result = service.resourcesFor('de-DE');
    expect(result.name).toBe('International');
    expect(result.resources.some((r) => r.url === 'https://findahelpline.com')).toBe(true);
  });

  it('should never return US-988 for non-US locale', () => {
    const result = service.resourcesFor('de-DE');
    expect(result.resources.some((r) => r.phone === '988')).toBe(false);
  });

  it('should return international fallback for empty locale', () => {
    const result = service.resourcesFor('');
    expect(result.name).toBe('International');
  });
});
```

- [ ] **Step 3: Run tests**

Run:
```bash
cd packages/bot
pnpm test
```

Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add packages/bot/src/modules/crisis/__tests__/
git commit -m "test: add crisis tripwire golden set and resources locale tests"
```

### Task 7: Build verification

- [ ] **Step 1: Build bot**

Run:
```bash
cd packages/bot
pnpm build
```

Expected: Build succeeds.

- [ ] **Step 2: Verify full test suite**

Run:
```bash
cd packages/bot
pnpm test
```

Expected: All tests pass.

- [ ] **Step 3: Update issue status**

Set `.scratch/v1-coaching-companion/issues/05-crisis-safety-floor.md` status to `done` and check all acceptance criteria.

- [ ] **Step 4: Commit**

```bash
git add .scratch/v1-coaching-companion/issues/05-crisis-safety-floor.md
git commit -m "docs: mark issue #05 crisis safety floor as done"
```

---

## Self-Review

**Spec coverage:**
- ✅ Tripwire fires on explicit crisis phrases — Task 3
- ✅ DM with explicit crisis → Resources surfaced, no coaching — Task 5
- ✅ `resourcesFor` returns locale resources; unknown → international fallback, never US-988 — Task 4
- ✅ Escalation Event persisted content-free — Task 1 + Task 5
- ✅ Tripwire path works with Postgres/Redis/LLM unavailable — Task 3 (pure TS), Task 4 (file-based), Task 5 (escalation event in try/catch)
- ✅ Unit tests: tripwire golden set + resources locale — Task 6

**Placeholder scan:** No TBD/TODO/placeholder patterns found.

**Type consistency:** `EscalationEvent.layer` is `String` in schema, passed as `'tripwire'` in code — matches.
