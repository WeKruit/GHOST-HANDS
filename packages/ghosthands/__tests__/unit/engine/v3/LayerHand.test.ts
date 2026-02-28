/**
 * LayerHand abstract class tests.
 *
 * Tests shared utilities: classifyError, generateFieldId.
 */

import { describe, it, expect } from 'bun:test';
import { LayerHand } from '../../../../src/engine/v3/LayerHand';
import type {
  LayerContext,
  V3ObservationResult,
  FieldMatch,
  PlannedAction,
  ExecutionResult,
  ReviewResult,
  LayerError,
} from '../../../../src/engine/v3/types';

// Concrete test implementation
class TestLayerHand extends LayerHand {
  readonly id = 'dom' as const;
  readonly displayName = 'Test';
  readonly costPerAction = 0;
  readonly requiresLLM = false;

  async observe(_ctx: LayerContext): Promise<V3ObservationResult> {
    return {} as V3ObservationResult;
  }
  async process(_obs: V3ObservationResult, _ctx: LayerContext): Promise<FieldMatch[]> {
    return [];
  }
  async execute(_actions: PlannedAction[], _ctx: LayerContext): Promise<ExecutionResult[]> {
    return [];
  }
  async review(_actions: PlannedAction[], _results: ExecutionResult[], _ctx: LayerContext): Promise<ReviewResult[]> {
    return [];
  }
  throwError(error: unknown, _ctx: LayerContext): LayerError {
    return {
      category: this.classifyError(error),
      message: String(error),
      layer: 'dom',
      recoverable: true,
    };
  }

  // Expose protected methods for testing
  public testClassifyError(error: unknown) {
    return this.classifyError(error);
  }
  public testGenerateFieldId(selector: string, label: string) {
    return this.generateFieldId(selector, label);
  }
}

describe('LayerHand', () => {
  const hand = new TestLayerHand();

  describe('classifyError', () => {
    it('classifies element_not_found', () => {
      expect(hand.testClassifyError(new Error('No element found'))).toBe('element_not_found');
      expect(hand.testClassifyError(new Error('no such element'))).toBe('element_not_found');
    });

    it('classifies element_not_visible', () => {
      expect(hand.testClassifyError(new Error('Element not visible'))).toBe('element_not_visible');
      expect(hand.testClassifyError(new Error('display: none'))).toBe('element_not_visible');
    });

    it('classifies element_not_interactable', () => {
      expect(hand.testClassifyError(new Error('Element not interactable'))).toBe('element_not_interactable');
      expect(hand.testClassifyError(new Error('Element disabled'))).toBe('element_not_interactable');
    });

    it('classifies timeout', () => {
      expect(hand.testClassifyError(new Error('Timeout'))).toBe('timeout');
      expect(hand.testClassifyError(new Error('timed out waiting'))).toBe('timeout');
    });

    it('classifies navigation_failed', () => {
      expect(hand.testClassifyError(new Error('Navigation failed'))).toBe('navigation_failed');
    });

    it('classifies budget_exceeded', () => {
      expect(hand.testClassifyError(new Error('Budget exceeded'))).toBe('budget_exceeded');
    });

    it('classifies browser_disconnected', () => {
      expect(hand.testClassifyError(new Error('Browser disconnected'))).toBe('browser_disconnected');
      expect(hand.testClassifyError(new Error('Target closed'))).toBe('browser_disconnected');
    });

    it('defaults to unknown', () => {
      expect(hand.testClassifyError(new Error('Something weird'))).toBe('unknown');
    });

    it('handles non-Error objects', () => {
      expect(hand.testClassifyError('timeout string')).toBe('timeout');
      expect(hand.testClassifyError(42)).toBe('unknown');
    });
  });

  describe('generateFieldId', () => {
    it('generates deterministic IDs', () => {
      const id1 = hand.testGenerateFieldId('#field', 'Label');
      const id2 = hand.testGenerateFieldId('#field', 'Label');
      expect(id1).toBe(id2);
    });

    it('generates different IDs for different inputs', () => {
      const id1 = hand.testGenerateFieldId('#field1', 'Label');
      const id2 = hand.testGenerateFieldId('#field2', 'Label');
      expect(id1).not.toBe(id2);
    });

    it('starts with f_ prefix', () => {
      const id = hand.testGenerateFieldId('#x', 'Y');
      expect(id.startsWith('f_')).toBe(true);
    });
  });
});
