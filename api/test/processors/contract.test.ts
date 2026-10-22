import { describe, expect, it } from 'vitest';
import { PROCESSOR_FAILURE_CODES } from '../../src/contract/processor.js';
import { RECAP_ERROR_CODES } from '../../src/contract/recap.js';

describe('processor contract v1', () => {
  it('fails with recap\'s codes, word for word, so recap maps onto it one to one', () => {
    expect([...PROCESSOR_FAILURE_CODES]).toEqual([...RECAP_ERROR_CODES]);
  });
});
