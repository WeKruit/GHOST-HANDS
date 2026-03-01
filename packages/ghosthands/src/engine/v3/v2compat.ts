/**
 * v2compat — Shared conversion functions between v3 and v2 types.
 *
 * Eliminates `as any` casts when bridging v3 FormField <-> v2 FieldModel
 * and v3 observation data -> v2 PageModel.
 */

import type { FormField, V3ObservationResult } from './types';
import type { FieldModel, FieldType as V2FieldType, FillStrategy, PageModel, ButtonModel, ButtonRole } from './v2types';

/**
 * Map v3 FieldType to v2 FieldType.
 * v3 uses 'tel'/'url'/'searchable_select' which don't exist in v2.
 */
function mapV3ToV2FieldType(v3Type: FormField['fieldType']): V2FieldType {
  const map: Record<string, V2FieldType> = {
    text: 'text',
    textarea: 'textarea',
    email: 'email',
    tel: 'phone',
    url: 'text',
    number: 'number',
    password: 'password',
    select: 'select',
    searchable_select: 'custom_dropdown',
    radio: 'radio',
    checkbox: 'checkbox',
    date: 'date',
    file: 'file',
    hidden: 'unknown',
    unknown: 'unknown',
  };
  return map[v3Type] ?? 'unknown';
}

/**
 * Determine the v2 FillStrategy from a v2 FieldType.
 */
function getFillStrategy(fieldType: V2FieldType): FillStrategy {
  switch (fieldType) {
    case 'text':
    case 'email':
    case 'phone':
    case 'number':
    case 'textarea':
    case 'contenteditable':
    case 'select':
    case 'password':
      return 'native_setter';
    case 'custom_dropdown':
    case 'typeahead':
    case 'radio':
    case 'aria_radio':
      return 'click_option';
    case 'checkbox':
      return 'click';
    case 'file':
    case 'upload_button':
      return 'set_input_files';
    case 'date':
      return 'keyboard_type';
    default:
      return 'llm_act';
  }
}

/**
 * Convert a v3 FormField to a v2 FieldModel.
 */
export function toV2FieldModel(field: FormField): FieldModel {
  const v2Type = mapV3ToV2FieldType(field.fieldType);
  return {
    id: field.id,
    selector: field.selector,
    automationId: field.automationId,
    name: field.name,
    fieldType: v2Type,
    fillStrategy: getFillStrategy(v2Type),
    isRequired: field.required,
    isVisible: field.visible,
    isDisabled: field.disabled,
    label: field.label,
    placeholder: field.placeholder,
    ariaLabel: field.ariaLabel,
    currentValue: field.currentValue ?? '',
    isEmpty: !field.currentValue || field.currentValue.trim() === '',
    boundingBox: field.boundingBox ?? { x: 0, y: 0, width: 0, height: 0 },
    absoluteY: field.boundingBox?.y ?? 0,
    // Carry groupKey for radio groups — DOMActionExecutor.fillRadio() requires it
    groupKey: field.groupKey ?? field.name,
    options: field.options,
  };
}

/**
 * Convert a v3 V3ObservationResult to a v2 PageModel for the FieldMatcher.
 */
export function toV2PageModel(observation: V3ObservationResult): PageModel {
  return {
    url: observation.url,
    platform: observation.platform,
    pageType: observation.pageType,
    fields: observation.fields.map(toV2FieldModel),
    buttons: observation.buttons.map((b): ButtonModel => ({
      selector: b.selector,
      text: b.text,
      automationId: undefined,
      role: 'unknown' as ButtonRole,
      boundingBox: b.boundingBox ?? { x: 0, y: 0, width: 0, height: 0 },
      isDisabled: b.disabled ?? false,
    })),
    timestamp: observation.timestamp,
    scrollHeight: 0,
    viewportHeight: 0,
  };
}
