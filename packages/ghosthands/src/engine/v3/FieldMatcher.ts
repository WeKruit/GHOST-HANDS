/**
 * FieldMatcher — deterministic field-to-data matching for the v2 hybrid engine.
 *
 * Matches page fields to user data and Q&A answers using a prioritized
 * cascade of strategies: automation_id, name attribute, exact label,
 * fuzzy Q&A match, fuzzy userData match, placeholder, and default value.
 *
 * Only fields that are empty, visible, and not disabled are matched.
 */

import type {
  PageModel,
  FieldModel,
  FieldMatch,
  MatchMethod,
  PlatformHandler,
} from './v2types';
import { getLogger } from '../../monitoring/logger';

// ── Static name-attribute-to-key map ──────────────────────────────────

const NAME_TO_KEY: Record<string, string> = {
  firstname: 'first_name',
  first_name: 'first_name',
  lastname: 'last_name',
  last_name: 'last_name',
  email: 'email',
  emailaddress: 'email',
  phone: 'phone',
  phonenumber: 'phone',
  addressline1: 'street',
  street: 'street',
  city: 'city',
  state: 'state',
  province: 'state',
  postalcode: 'zip',
  zip: 'zip',
  zipcode: 'zip',
  country: 'country',
};

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Normalize a label for matching: strip `*`, `Required`, `(optional)`,
 * extra whitespace, and convert to lowercase.
 */
function normalizeLabel(label: string): string {
  return label
    .replace(/\*/g, '')
    .replace(/\brequired\b/gi, '')
    .replace(/\(optional\)/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Stem a word by stripping common English suffixes.
 * Used in pass 5 so that "relocating" matches "relocate", etc.
 */
function stem(word: string): string {
  return word.replace(
    /(ating|ting|ing|tion|sion|ment|ness|able|ible|ed|ly|er|est|ies|es|s)$/i,
    '',
  );
}

/**
 * 5-pass fuzzy match of `needle` (a label) against the keys of `haystack`.
 * Returns the value associated with the best matching key, or null.
 *
 * Pass 1: Exact match (case-insensitive, stripped)
 * Pass 2: Label contains a key (key length >= 60% of label length)
 * Pass 3: Key contains label (label length >= 50% of key length, label > 3 chars)
 * Pass 4: Significant word overlap (all distinguishing words in label appear in key, >= 2 overlap)
 * Pass 5: Stem-based overlap (strip common suffixes, >= 2 stem overlap)
 */
function fuzzyLookup(
  rawLabel: string,
  haystack: Record<string, string>,
): { key: string; value: string } | null {
  const label = normalizeLabel(rawLabel);
  if (label.length < 2) return null;

  // Pass 1: Exact match
  for (const [k, v] of Object.entries(haystack)) {
    if (normalizeLabel(k) === label) {
      return { key: k, value: v };
    }
  }

  // Pass 2: Label contains a key (key length >= 60% of label length)
  for (const [k, v] of Object.entries(haystack)) {
    const kNorm = normalizeLabel(k);
    if (kNorm.length >= label.length * 0.6 && label.includes(kNorm)) {
      return { key: k, value: v };
    }
  }

  // Pass 3: Key contains label (label length >= 50% of key length, label > 3 chars)
  if (label.length > 3) {
    for (const [k, v] of Object.entries(haystack)) {
      const kNorm = normalizeLabel(k);
      if (label.length >= kNorm.length * 0.5 && kNorm.includes(label)) {
        return { key: k, value: v };
      }
    }
  }

  // Pass 4: Significant word overlap
  // All "distinguishing" words (> 3 chars) in the label must appear in the key,
  // and there must be at least 2 overlapping words.
  const labelWords = label.split(/\s+/).filter((w) => w.length > 3);
  if (labelWords.length >= 2) {
    let bestOverlap = 0;
    let bestResult: { key: string; value: string } | null = null;

    for (const [k, v] of Object.entries(haystack)) {
      const kWords = new Set(
        normalizeLabel(k)
          .split(/\s+/)
          .filter((w) => w.length > 3),
      );
      const overlapping = labelWords.filter((w) => kWords.has(w));
      if (
        overlapping.length >= 2 &&
        overlapping.length === labelWords.length &&
        overlapping.length > bestOverlap
      ) {
        bestOverlap = overlapping.length;
        bestResult = { key: k, value: v };
      }
    }
    if (bestResult) return bestResult;
  }

  // Pass 5: Stem-based overlap (>= 2 stem overlap)
  const labelStems = new Set(labelWords.map(stem));
  if (labelStems.size >= 2) {
    let bestOverlap = 0;
    let bestResult: { key: string; value: string } | null = null;

    for (const [k, v] of Object.entries(haystack)) {
      const kStems = normalizeLabel(k)
        .split(/\s+/)
        .filter((w) => w.length > 3)
        .map(stem);
      const overlap = kStems.filter((s) => labelStems.has(s)).length;
      if (overlap >= 2 && overlap > bestOverlap) {
        bestOverlap = overlap;
        bestResult = { key: k, value: v };
      }
    }
    if (bestResult) return bestResult;
  }

  return null;
}

// ── FieldMatcher ──────────────────────────────────────────────────────

export class FieldMatcher {
  private logger = getLogger({ service: 'FieldMatcher' });

  constructor(
    private userData: Record<string, string>,
    private qaAnswers: Record<string, string>,
    private platformHandler: PlatformHandler | null,
  ) {}

  /**
   * Match all eligible fields in a PageModel to user data / Q&A answers.
   *
   * Returns the list of successful matches and the list of unmatched fields
   * (unmatched means no strategy produced a value for that field).
   */
  match(pageModel: PageModel): { matches: FieldMatch[]; unmatched: FieldModel[] } {
    const matches: FieldMatch[] = [];
    const unmatched: FieldModel[] = [];

    for (const field of pageModel.fields) {
      // Skip fields that are already filled, invisible, or disabled
      if (!field.isEmpty || !field.isVisible || field.isDisabled) {
        continue;
      }

      const result = this.findBestMatch(field);
      if (result) {
        matches.push(result);
        this.logger.debug('Field matched', {
          fieldId: field.id,
          label: field.label,
          method: result.matchMethod,
          confidence: result.confidence,
          key: result.userDataKey,
        });
      } else {
        unmatched.push(field);
        if (field.isRequired) {
          this.logger.warn('Required field unmatched', {
            fieldId: field.id,
            label: field.label,
            fieldType: field.fieldType,
            automationId: field.automationId,
          });
        }
      }
    }

    return { matches, unmatched };
  }

  /**
   * Try each matching strategy in priority order. Return the first match
   * that resolves to a non-empty value, or null if nothing matches.
   */
  private findBestMatch(field: FieldModel): FieldMatch | null {
    // Strategy 1: automation_id via platform handler (confidence 0.95)
    const automationIdMatch = this.matchByAutomationId(field);
    if (automationIdMatch) return automationIdMatch;

    // Strategy 2: HTML name attribute (confidence 0.95)
    const nameAttrMatch = this.matchByNameAttr(field);
    if (nameAttrMatch) return nameAttrMatch;

    // Strategy 3: Exact label match against userData or qaAnswers (confidence 0.90)
    const labelExactMatch = this.matchByLabelExact(field);
    if (labelExactMatch) return labelExactMatch;

    // Strategy 4: Fuzzy Q&A match (confidence 0.85)
    const qaMatch = this.matchByQA(field);
    if (qaMatch) return qaMatch;

    // Strategy 5: Fuzzy userData match (confidence 0.75)
    const labelFuzzyMatch = this.matchByLabelFuzzy(field);
    if (labelFuzzyMatch) return labelFuzzyMatch;

    // Strategy 6: Placeholder text match (confidence 0.70)
    const placeholderMatch = this.matchByPlaceholder(field);
    if (placeholderMatch) return placeholderMatch;

    // Strategy 7: Default value from Q&A (confidence 0.60)
    const defaultMatch = this.matchByDefault(field);
    if (defaultMatch) return defaultMatch;

    return null;
  }

  // ── Strategy implementations ──────────────────────────────────────

  /**
   * Strategy 1: automation_id
   * If the field has an automationId and the platform handler maps it to a userData key.
   */
  private matchByAutomationId(field: FieldModel): FieldMatch | null {
    if (!field.automationId || !this.platformHandler) return null;

    const automationMap = this.platformHandler.getAutomationIdMap();
    const dataKey = automationMap[field.automationId];
    if (!dataKey) return null;

    const value = this.userData[dataKey] ?? this.qaAnswers[dataKey];
    if (!value) return null;

    return {
      field,
      userDataKey: dataKey,
      value,
      confidence: 0.95,
      matchMethod: 'automation_id',
    };
  }

  /**
   * Strategy 2: name_attr
   * Lowercase the HTML name attribute and look it up in the static NAME_TO_KEY map.
   */
  private matchByNameAttr(field: FieldModel): FieldMatch | null {
    if (!field.name) return null;

    const nameNorm = field.name.toLowerCase().replace(/[-_\s]/g, '');
    const dataKey = NAME_TO_KEY[nameNorm];
    if (!dataKey) return null;

    const value = this.userData[dataKey] ?? this.qaAnswers[dataKey];
    if (!value) return null;

    return {
      field,
      userDataKey: dataKey,
      value,
      confidence: 0.95,
      matchMethod: 'name_attr',
    };
  }

  /**
   * Strategy 3: label_exact
   * Normalized label exactly matches a key in userData or qaAnswers.
   */
  private matchByLabelExact(field: FieldModel): FieldMatch | null {
    if (!field.label) return null;

    const labelNorm = normalizeLabel(field.label);

    // Check userData keys
    for (const [k, v] of Object.entries(this.userData)) {
      if (normalizeLabel(k) === labelNorm && v) {
        return {
          field,
          userDataKey: k,
          value: v,
          confidence: 0.90,
          matchMethod: 'label_exact',
        };
      }
    }

    // Check qaAnswers keys
    for (const [k, v] of Object.entries(this.qaAnswers)) {
      if (normalizeLabel(k) === labelNorm && v) {
        return {
          field,
          userDataKey: k,
          value: v,
          confidence: 0.90,
          matchMethod: 'label_exact',
        };
      }
    }

    return null;
  }

  /**
   * Strategy 4: qa_match
   * Fuzzy-match the field label against qaAnswers keys using the 5-pass algorithm.
   */
  private matchByQA(field: FieldModel): FieldMatch | null {
    const label = field.label || field.ariaLabel;
    if (!label) return null;

    const result = fuzzyLookup(label, this.qaAnswers);
    if (!result || !result.value) return null;

    return {
      field,
      userDataKey: result.key,
      value: result.value,
      confidence: 0.85,
      matchMethod: 'qa_match',
    };
  }

  /**
   * Strategy 5: label_fuzzy
   * Fuzzy-match the field label against userData keys using the 5-pass algorithm.
   */
  private matchByLabelFuzzy(field: FieldModel): FieldMatch | null {
    const label = field.label || field.ariaLabel;
    if (!label) return null;

    const result = fuzzyLookup(label, this.userData);
    if (!result || !result.value) return null;

    return {
      field,
      userDataKey: result.key,
      value: result.value,
      confidence: 0.75,
      matchMethod: 'label_fuzzy',
    };
  }

  /**
   * Strategy 6: placeholder
   * Match the placeholder text against userData keys.
   */
  private matchByPlaceholder(field: FieldModel): FieldMatch | null {
    if (!field.placeholder) return null;

    const placeholderNorm = normalizeLabel(field.placeholder);

    // Try exact match against userData keys first
    for (const [k, v] of Object.entries(this.userData)) {
      if (normalizeLabel(k) === placeholderNorm && v) {
        return {
          field,
          userDataKey: k,
          value: v,
          confidence: 0.70,
          matchMethod: 'placeholder',
        };
      }
    }

    // Try fuzzy match against userData
    const result = fuzzyLookup(field.placeholder, this.userData);
    if (result && result.value) {
      return {
        field,
        userDataKey: result.key,
        value: result.value,
        confidence: 0.70,
        matchMethod: 'placeholder',
      };
    }

    return null;
  }

  /**
   * Strategy 7: default_value
   * For fields where we have a known default answer in qaAnswers
   * but the label didn't match via earlier strategies.
   * Falls back to matching on the ariaLabel or platformMeta hints.
   */
  private matchByDefault(field: FieldModel): FieldMatch | null {
    // Try ariaLabel against qaAnswers if label didn't match
    if (field.ariaLabel && field.ariaLabel !== field.label) {
      const result = fuzzyLookup(field.ariaLabel, this.qaAnswers);
      if (result && result.value) {
        return {
          field,
          userDataKey: result.key,
          value: result.value,
          confidence: 0.60,
          matchMethod: 'default_value',
        };
      }
    }

    // Try platform-specific metadata hints
    if (field.platformMeta) {
      for (const metaValue of Object.values(field.platformMeta)) {
        if (metaValue) {
          const result = fuzzyLookup(metaValue, this.qaAnswers);
          if (result && result.value) {
            return {
              field,
              userDataKey: result.key,
              value: result.value,
              confidence: 0.60,
              matchMethod: 'default_value',
            };
          }
        }
      }
    }

    return null;
  }
}
