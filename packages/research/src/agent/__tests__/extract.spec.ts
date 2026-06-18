// extract.ts now holds the source-derived evidence helpers (the per-paper extract() moved to
// extractWithLenses, slice 03). These tests cover the tag/tier mapping.
import { evidenceTag, evidenceTier } from '../extract';
import { Paper } from '../../types';

const paper: Paper = {
  sourceId: 'PMID:1', sourceKind: 'pubmed', title: 'PMR and anxiety',
  abstract: 'In this trial, progressive muscle relaxation reduced state anxiety.',
  url: 'https://pubmed.ncbi.nlm.nih.gov/1', pubTypes: ['Randomized Controlled Trial'], isPreprint: false,
};

describe('evidenceTag', () => {
  it('tags peer-reviewed study types', () => {
    expect(evidenceTag(paper)).toBe('peer-reviewed: Randomized Controlled Trial');
  });
  it('tags observational when no high-tier type present', () => {
    expect(evidenceTag({ ...paper, pubTypes: ['Journal Article'] })).toBe('peer-reviewed: observational');
  });
  it('tags preprints', () => {
    expect(evidenceTag({ ...paper, isPreprint: true, pubTypes: [] })).toBe('preprint: not peer-reviewed');
  });
});

describe('evidenceTier', () => {
  it('maps each high-tier pub type to its structured tier', () => {
    expect(evidenceTier({ ...paper, pubTypes: ['Meta-Analysis'] })).toBe('meta-analysis');
    expect(evidenceTier({ ...paper, pubTypes: ['Systematic Review'] })).toBe('systematic-review');
    expect(evidenceTier({ ...paper, pubTypes: ['Randomized Controlled Trial'] })).toBe('rct');
  });
  it('falls back to observational for peer-reviewed work with no high-tier type', () => {
    expect(evidenceTier({ ...paper, pubTypes: ['Journal Article'] })).toBe('observational');
  });
  it('maps preprints to preprint regardless of pubTypes', () => {
    expect(evidenceTier({ ...paper, isPreprint: true, pubTypes: ['Randomized Controlled Trial'] })).toBe('preprint');
  });
});
