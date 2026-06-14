import { planTool, toolAllowed, type Tool } from '../tool-access';
import type { RoutingPlan } from '../dm-router.service';

describe('tool-access (ADR-0011 gating at the tool boundary)', () => {
  describe('toolAllowed', () => {
    // Reads of the person's OWN data are allowed at any tier — a lapsed user never loses read/export
    // access to what they wrote. Coaching and any new write require ACTIVE access.
    const cases: Array<{ tool: Tool; active: boolean; allowed: boolean }> = [
      { tool: 'get_entry', active: true, allowed: true },
      { tool: 'get_entry', active: false, allowed: true }, // read survives a lapsed tier
      { tool: 'save_entry', active: true, allowed: true },
      { tool: 'save_entry', active: false, allowed: false }, // new write needs active access
      { tool: 'give_prompt', active: true, allowed: true },
      { tool: 'give_prompt', active: false, allowed: false },
      { tool: 'coach', active: true, allowed: true },
      { tool: 'coach', active: false, allowed: false },
      { tool: 'tilt', active: true, allowed: true },
      { tool: 'tilt', active: false, allowed: false }, // coaching surface — active only
      { tool: 'mood', active: true, allowed: true },
      { tool: 'mood', active: false, allowed: false }, // new logging — active only
    ];

    it.each(cases)('tool=$tool active=$active → allowed=$allowed', ({ tool, active, allowed }) => {
      expect(toolAllowed(tool, active)).toBe(allowed);
    });
  });

  describe('planTool', () => {
    const cases: Array<{ plan: RoutingPlan; tool: Tool }> = [
      { plan: { kind: 'coach' }, tool: 'coach' },
      { plan: { kind: 'journal-begin' }, tool: 'give_prompt' },
      { plan: { kind: 'journal-inline', content: 'x' }, tool: 'save_entry' },
      { plan: { kind: 'journal-capture' }, tool: 'save_entry' },
      { plan: { kind: 'journal-read' }, tool: 'get_entry' },
      { plan: { kind: 'tilt' }, tool: 'tilt' },
      { plan: { kind: 'mood' }, tool: 'mood' },
      { plan: { kind: 'mood-capture' }, tool: 'mood' },
    ];

    it.each(cases)('plan=$plan.kind → tool=$tool', ({ plan, tool }) => {
      expect(planTool(plan)).toBe(tool);
    });

    // Exhaustiveness guard: an unmapped plan kind must throw, not silently return undefined (which
    // toolAllowed would read as "no tool" and deny). Protects the gate when a new plan kind is added.
    it('throws on an unmapped plan kind rather than returning undefined', () => {
      expect(() => planTool({ kind: 'totally-new-plan' } as unknown as RoutingPlan)).toThrow();
    });
  });
});
