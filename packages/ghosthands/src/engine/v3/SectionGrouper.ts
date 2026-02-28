/**
 * SectionGrouper — Groups observed fields into logical FormSections.
 *
 * Uses three heuristics:
 *   1. DOM structure (fieldset, form, heading containers)
 *   2. Y-proximity (fields within 50px vertical range)
 *   3. Section labels from headings/legends
 */

import type { FormField, FormSection, ButtonInfo } from './types';

const Y_PROXIMITY_THRESHOLD = 80; // px — fields within this range are grouped

export class SectionGrouper {
  /**
   * Group fields into sections by Y-position proximity and DOM structure.
   */
  group(fields: FormField[], buttons: ButtonInfo[]): FormSection[] {
    if (fields.length === 0) return [];

    // Sort by Y position
    const sorted = [...fields].sort((a, b) => {
      const ay = a.boundingBox?.y ?? 0;
      const by = b.boundingBox?.y ?? 0;
      return ay - by;
    });

    const sections: FormSection[] = [];
    let currentFields: FormField[] = [sorted[0]];
    let currentLabel = this.inferSectionLabel(sorted[0]);

    for (let i = 1; i < sorted.length; i++) {
      const field = sorted[i];
      const prevField = sorted[i - 1];
      const gap = (field.boundingBox?.y ?? 0) - (prevField.boundingBox?.y ?? 0);

      // Check if this field belongs to a new section
      const isDifferentContainer =
        field.parentContainer &&
        prevField.parentContainer &&
        field.parentContainer !== prevField.parentContainer;

      if (gap > Y_PROXIMITY_THRESHOLD || isDifferentContainer) {
        // Close current section
        sections.push(this.buildSection(currentFields, currentLabel, buttons, sections.length));
        currentFields = [field];
        currentLabel = this.inferSectionLabel(field);
      } else {
        currentFields.push(field);
      }
    }

    // Close last section
    if (currentFields.length > 0) {
      sections.push(this.buildSection(currentFields, currentLabel, buttons, sections.length));
    }

    return sections;
  }

  private buildSection(
    fields: FormField[],
    label: string,
    allButtons: ButtonInfo[],
    index: number,
  ): FormSection {
    const yMin = Math.min(...fields.map((f) => f.boundingBox?.y ?? 0));
    const yMax = Math.max(
      ...fields.map((f) => (f.boundingBox?.y ?? 0) + (f.boundingBox?.height ?? 20)),
    );

    // Find buttons within this section's Y range
    const sectionButtons = allButtons.filter((b) => {
      const by = b.boundingBox?.y ?? 0;
      return by >= yMin - 20 && by <= yMax + 40;
    });

    const allFilled = fields.every(
      (f) => f.currentValue !== undefined && f.currentValue.trim() !== '',
    );

    return {
      id: `section-${index}`,
      name: label || `Section ${index + 1}`,
      fields,
      buttons: sectionButtons,
      yRange: { min: yMin, max: yMax },
      allFilled,
    };
  }

  private inferSectionLabel(field: FormField): string {
    // Use parent container as a hint if available
    if (field.parentContainer) {
      // Extract heading text from common container patterns
      const match = field.parentContainer.match(
        /fieldset|section|div.*(?:personal|contact|experience|education|work|address|phone|email)/i,
      );
      if (match) return match[0];
    }

    // Infer from field label
    const label = field.label.toLowerCase();
    if (label.includes('name') || label.includes('first') || label.includes('last')) {
      return 'Personal Information';
    }
    if (label.includes('email') || label.includes('phone') || label.includes('address')) {
      return 'Contact Information';
    }
    if (label.includes('company') || label.includes('title') || label.includes('experience')) {
      return 'Work Experience';
    }
    if (label.includes('school') || label.includes('degree') || label.includes('education')) {
      return 'Education';
    }

    return '';
  }
}
