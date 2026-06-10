import { Prisma } from '@wabi/shared';
import { DataRightsService } from '../data-rights.service';

// This spec deliberately does NOT mock @wabi/shared — it reads the real Prisma DMMF (the schema) and
// asserts the delete path covers every model that holds a person's data. When a new userId/discordId
// model is added to the schema, this test goes red until a source is added for it — turning the
// "someone forgot a store" failure (which orphaned CoachingSession once) into a build failure.
describe('Data Rights deletion completeness (ADR-0004/0011)', () => {
  // The User row is the identity anchor, not per-person child data — deletion of the User itself is a
  // separate decision (anonymise vs drop), so it is intentionally excluded from the child-data sweep.
  const EXCLUDED: string[] = ['User'];

  it('covers every userId/discordId-bearing Prisma model', () => {
    const userScopedModels = Prisma.dmmf.datamodel.models
      .filter((m) =>
        m.fields.some((f) => f.name === 'userId' || f.name === 'discordId'),
      )
      .map((m) => m.name)
      .filter((name) => !EXCLUDED.includes(name));

    // coveredModels() reads only the static source list — the injected stores are never touched.
    const service = new DataRightsService(
      undefined as any,
      undefined as any,
      undefined as any,
    );
    const covered = service.coveredModels();

    const missing = userScopedModels.filter((m) => !covered.includes(m as Prisma.ModelName));
    expect(missing).toEqual([]);
  });
});
