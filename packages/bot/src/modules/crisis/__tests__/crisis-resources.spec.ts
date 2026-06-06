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
    expect(
      result.resources.some((r) => r.url === 'https://findahelpline.com'),
    ).toBe(true);
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
