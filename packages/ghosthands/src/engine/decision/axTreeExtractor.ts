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

/** CDP Accessibility.AXNode shape (subset we use) */
interface CDPAXNode {
  nodeId: string;
  role: { type: string; value?: string };
  name?: { type: string; value?: string };
  description?: { type: string; value?: string };
  value?: { type: string; value?: string | number };
  properties?: Array<{ name: string; value: { type: string; value?: string | boolean | number } }>;
  childIds?: string[];
}

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

// ── CDP-based AX extraction ─────────────────────────────────

function cdpPropertyValue(
  props: CDPAXNode['properties'],
  name: string,
): string | boolean | number | undefined {
  const prop = props?.find((p) => p.name === name);
  return prop?.value?.value;
}

function cdpNodeToPlaywright(
  node: CDPAXNode,
  nodeMap: Map<string, CDPAXNode>,
): PlaywrightAXNode {
  const role = node.role?.value ?? '';
  const name = node.name?.value ?? '';
  const description = node.description?.value ?? '';
  const value = node.value?.value;

  const props = node.properties;
  const disabled = cdpPropertyValue(props, 'disabled');
  const expanded = cdpPropertyValue(props, 'expanded');
  const focused = cdpPropertyValue(props, 'focused');
  const required = cdpPropertyValue(props, 'required');
  const checked = cdpPropertyValue(props, 'checked');
  const readonly = cdpPropertyValue(props, 'readonly');
  const multiselectable = cdpPropertyValue(props, 'multiselectable');

  const children: PlaywrightAXNode[] = [];
  for (const childId of node.childIds ?? []) {
    const child = nodeMap.get(childId);
    if (child) {
      children.push(cdpNodeToPlaywright(child, nodeMap));
    }
  }

  const result: PlaywrightAXNode = {
    role: typeof role === 'string' ? role : String(role),
    name: typeof name === 'string' ? name : String(name),
    description: typeof description === 'string' ? description : undefined,
    value: value != null ? String(value) : undefined,
    disabled: disabled === true ? true : undefined,
    expanded: expanded === true ? true : expanded === false ? false : undefined,
    focused: focused === true ? true : undefined,
    required: required === true ? true : undefined,
    readonly: readonly === true ? true : undefined,
    multiselectable: multiselectable === true ? true : undefined,
    checked:
      checked === 'mixed' ? 'mixed' :
      checked === true ? 'true' :
      checked === false ? 'false' :
      undefined,
    children: children.length > 0 ? children : undefined,
  };

  return result;
}

async function extractAXFieldsViaCDP(page: Page): Promise<AXFieldNode[]> {
  // Get CDP session from the page's browser context
  const context = page.context();
  if (typeof (context as any).newCDPSession !== 'function') {
    return [];
  }

  const cdp = await (context as any).newCDPSession(page);
  try {
    const result = await cdp.send('Accessibility.getFullAXTree');
    const nodes: CDPAXNode[] = result.nodes ?? [];

    if (nodes.length === 0) return [];

    // Build node map for parent→child resolution
    const nodeMap = new Map<string, CDPAXNode>();
    for (const node of nodes) {
      nodeMap.set(node.nodeId, node);
    }

    // Find the root node and convert to PlaywrightAXNode tree
    const root = nodes[0];
    if (!root) return [];

    const pwRoot = cdpNodeToPlaywright(root, nodeMap);

    // Flatten into AXFieldNode[] using the same logic
    const results: AXFieldNode[] = [];
    flattenAXTree(pwRoot, 0, null, results);
    return results;
  } finally {
    await cdp.detach().catch(() => {});
  }
}

// ── Public API ───────────────────────────────────────────────

export async function extractAXFields(page: Page): Promise<AXFieldNode[]> {
  // Strategy 1: Playwright's native accessibility API
  const castPage = page as PageWithAccessibility;
  if (castPage.accessibility?.snapshot) {
    try {
      const snapshot = await castPage.accessibility.snapshot({
        interestingOnly: false,
      });
      if (snapshot) {
        const results: AXFieldNode[] = [];
        flattenAXTree(snapshot, 0, null, results);
        console.log(`[axTreeExtractor] Playwright AX: ${results.length} interactive fields`);
        return results;
      }
    } catch {
      // Fall through to CDP
    }
  }

  // Strategy 2: CDP-based extraction (works with patchright/magnitude)
  try {
    const results = await extractAXFieldsViaCDP(page);
    if (results.length > 0) {
      console.log(`[axTreeExtractor] CDP AX: ${results.length} interactive fields`);
      return results;
    }
    console.log('[axTreeExtractor] CDP AX returned 0 fields');
    return [];
  } catch (err) {
    console.log(`[axTreeExtractor] CDP AX failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}
