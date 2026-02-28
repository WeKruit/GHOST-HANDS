/**
 * SectionGrouper unit tests.
 *
 * Tests field grouping by Y-proximity and parent container.
 */

import { describe, it, expect } from 'bun:test';
import { SectionGrouper } from '../../../../src/engine/v3/SectionGrouper';
import type { FormField, ButtonInfo } from '../../../../src/engine/v3/types';

function makeField(overrides: Partial<FormField> = {}): FormField {
  return {
    id: 'field-0',
    selector: '#field-0',
    fieldType: 'text',
    label: 'Test Field',
    required: false,
    visible: true,
    disabled: false,
    boundingBox: { x: 0, y: 0, width: 200, height: 30 },
    ...overrides,
  };
}

describe('SectionGrouper', () => {
  const grouper = new SectionGrouper();

  it('returns empty array for no fields', () => {
    const sections = grouper.group([], []);
    expect(sections).toEqual([]);
  });

  it('groups a single field into one section', () => {
    const fields = [makeField({ id: 'f1', label: 'First Name' })];
    const sections = grouper.group(fields, []);
    expect(sections).toHaveLength(1);
    expect(sections[0].fields).toHaveLength(1);
    expect(sections[0].name).toBe('Personal Information');
  });

  it('groups fields close in Y into one section', () => {
    const fields = [
      makeField({ id: 'f1', label: 'First Name', boundingBox: { x: 0, y: 100, width: 200, height: 30 } }),
      makeField({ id: 'f2', label: 'Last Name', boundingBox: { x: 0, y: 140, width: 200, height: 30 } }),
      makeField({ id: 'f3', label: 'Middle Name', boundingBox: { x: 0, y: 180, width: 200, height: 30 } }),
    ];
    const sections = grouper.group(fields, []);
    expect(sections).toHaveLength(1);
    expect(sections[0].fields).toHaveLength(3);
  });

  it('splits fields with large Y gaps into separate sections', () => {
    const fields = [
      makeField({ id: 'f1', label: 'First Name', boundingBox: { x: 0, y: 100, width: 200, height: 30 } }),
      makeField({ id: 'f2', label: 'Email', boundingBox: { x: 0, y: 300, width: 200, height: 30 } }),
    ];
    const sections = grouper.group(fields, []);
    expect(sections).toHaveLength(2);
    expect(sections[0].name).toBe('Personal Information');
    expect(sections[1].name).toBe('Contact Information');
  });

  it('splits by different parentContainer', () => {
    const fields = [
      makeField({ id: 'f1', label: 'First Name', parentContainer: 'section-personal', boundingBox: { x: 0, y: 100, width: 200, height: 30 } }),
      makeField({ id: 'f2', label: 'Last Name', parentContainer: 'section-personal', boundingBox: { x: 0, y: 140, width: 200, height: 30 } }),
      makeField({ id: 'f3', label: 'Company', parentContainer: 'section-work', boundingBox: { x: 0, y: 180, width: 200, height: 30 } }),
    ];
    const sections = grouper.group(fields, []);
    expect(sections).toHaveLength(2);
  });

  it('assigns buttons to sections by Y range', () => {
    const fields = [
      makeField({ id: 'f1', label: 'First Name', boundingBox: { x: 0, y: 100, width: 200, height: 30 } }),
    ];
    const buttons: ButtonInfo[] = [
      { selector: '#next', text: 'Next', boundingBox: { x: 0, y: 150, width: 100, height: 30 } },
      { selector: '#submit', text: 'Submit', boundingBox: { x: 0, y: 500, width: 100, height: 30 } },
    ];
    const sections = grouper.group(fields, buttons);
    expect(sections[0].buttons).toHaveLength(1);
    expect(sections[0].buttons[0].text).toBe('Next');
  });

  it('marks allFilled correctly', () => {
    const fields = [
      makeField({ id: 'f1', label: 'First Name', currentValue: 'John' }),
      makeField({ id: 'f2', label: 'Last Name', currentValue: 'Doe' }),
    ];
    const sections = grouper.group(fields, []);
    expect(sections[0].allFilled).toBe(true);
  });

  it('marks allFilled false when empty', () => {
    const fields = [
      makeField({ id: 'f1', label: 'First Name', currentValue: 'John' }),
      makeField({ id: 'f2', label: 'Last Name', currentValue: '' }),
    ];
    const sections = grouper.group(fields, []);
    expect(sections[0].allFilled).toBe(false);
  });

  it('infers Work Experience label', () => {
    const fields = [
      makeField({ id: 'f1', label: 'Job Title' }),
    ];
    const sections = grouper.group(fields, []);
    expect(sections[0].name).toBe('Work Experience');
  });

  it('infers Education label', () => {
    const fields = [
      makeField({ id: 'f1', label: 'Degree Level' }),
    ];
    const sections = grouper.group(fields, []);
    expect(sections[0].name).toBe('Education');
  });

  it('falls back to Section N for unrecognized labels', () => {
    const fields = [
      makeField({ id: 'f1', label: 'Favorite Color' }),
    ];
    const sections = grouper.group(fields, []);
    expect(sections[0].name).toBe('Section 1');
  });

  it('handles fields without bounding boxes', () => {
    const fields = [
      makeField({ id: 'f1', label: 'First Name', boundingBox: undefined }),
      makeField({ id: 'f2', label: 'Last Name', boundingBox: undefined }),
    ];
    const sections = grouper.group(fields, []);
    expect(sections).toHaveLength(1);
    expect(sections[0].fields).toHaveLength(2);
  });
});
