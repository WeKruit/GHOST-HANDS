import type { Page } from 'playwright';
import type { AXFieldNode } from './mergedObserverTypes';
import type { FieldType } from '../v3/v2types';

export interface PlaywrightAXNode {
  role: string;
  name: string;
  value?: string;
  description?: string;
  keyshortcuts?: string;
  roledescription?: string;
  valuetext?: string;
  disabled?: boolean;
  expanded?: boolean;
  focused?: boolean;
  modal?: boolean;
  multiline?: boolean;
  multiselectable?: boolean;
  readonly?: boolean;
  required?: boolean;
  selected?: boolean;
  checked?: 'true' | 'false' | 'mixed';
  pressed?: 'true' | 'false' | 'mixed';
  level?: number;
  valuemin?: number;
  valuemax?: number;
  autocomplete?: string;
  haspopup?: string;
  invalid?: string;
  orientation?: string;
  children?: PlaywrightAXNode[];
}

type PageWithAccessibility = Page & {
  accessibility: {
    snapshot(options?: { interestingOnly?: boolean }): Promise<PlaywrightAXNode | null>;
  };
};

const INTERACTIVE_AX_ROLES = new Set([
  'textbox',
  'combobox',
  'listbox',
  'checkbox',
  'radio',
  'spinbutton',
  'slider',
  'searchbox',
  'switch',
]);

const SECTION_AX_ROLES = new Set(['group', 'region', 'form', 'landmark']);

function normalizeText(value: string | null | undefined): string {
  return (value || '').replace(/\s+/g, ' ').trim();
}

function extractOptionLabels(children: PlaywrightAXNode[] | undefined): string[] {
  if (!children || children.length === 0) return [];

  const options: string[] = [];
  const visit = (node: PlaywrightAXNode): void => {
    if (node.role === 'option') {
      const label = normalizeText(node.name);
      if (label) options.push(label);
    }

    for (const child of node.children || []) {
      visit(child);
    }
  };

  for (const child of children) {
    visit(child);
  }

  return options;
}

function normalizeAXValue(node: PlaywrightAXNode): string {
  if (node.role === 'checkbox' || node.role === 'radio' || node.role === 'switch') {
    if (node.checked === 'mixed') return 'mixed';
    if (node.checked === 'true') return 'checked';
    if (node.checked === 'false') return 'unchecked';
    return '';
  }

  return normalizeText(node.value ?? node.valuetext ?? '');
}

export function mapAXRoleToFieldType(role: string, name: string): FieldType {
  const normalizedRole = normalizeText(role).toLowerCase();
  const normalizedName = normalizeText(name).toLowerCase();

  switch (normalizedRole) {
    case 'textbox':
      if (/\b(e-?mail|mail)\b/.test(normalizedName)) return 'email';
      if (/\b(phone|telephone|tel|mobile|cell)\b/.test(normalizedName)) return 'phone';
      return 'text';
    case 'combobox':
      return 'custom_dropdown';
    case 'listbox':
      return 'select';
    case 'checkbox':
    case 'switch':
      return 'checkbox';
    case 'radio':
      return 'radio';
    case 'spinbutton':
    case 'slider':
      return 'number';
    case 'searchbox':
      return 'typeahead';
    default:
      return 'unknown';
  }
}

export function flattenAXTree(
  node: PlaywrightAXNode,
  depth: number,
  section: string | null,
  results: AXFieldNode[],
): void {
  const nodeName = normalizeText(node.name);
  const nextSection =
    SECTION_AX_ROLES.has(node.role) && nodeName.length > 0
      ? nodeName
      : section;

  if (INTERACTIVE_AX_ROLES.has(node.role)) {
    const inferredFieldType = mapAXRoleToFieldType(node.role, nodeName);
    if (inferredFieldType !== 'unknown') {
      const fieldNode: AXFieldNode = {
        role: node.role,
        name: nodeName,
        description: normalizeText(node.description),
        value: normalizeAXValue(node),
        required: node.required === true,
        disabled: node.disabled === true,
        focused: node.focused === true,
        options:
          node.role === 'combobox' || node.role === 'listbox'
            ? extractOptionLabels(node.children)
            : [],
        expanded:
          node.role === 'combobox' || node.role === 'listbox'
            ? node.expanded ?? null
            : null,
        checked: node.checked ?? null,
        inferredFieldType,
        depth,
        sectionName: nextSection,
        ordinalIndex: results.length,
      };
      results.push(fieldNode);
    }
  }

  for (const child of node.children || []) {
    flattenAXTree(child, depth + 1, nextSection, results);
  }
}

export async function extractAXFields(page: Page): Promise<AXFieldNode[]> {
  const castPage = page as PageWithAccessibility;
  if (!castPage.accessibility?.snapshot) {
    return [];
  }

  try {
    const snapshot = await castPage.accessibility.snapshot({
      interestingOnly: false,
    });
    if (!snapshot) return [];

    const results: AXFieldNode[] = [];
    flattenAXTree(snapshot, 0, null, results);
    return results;
  } catch {
    return [];
  }
}
