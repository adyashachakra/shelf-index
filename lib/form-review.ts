import { CATEGORIES } from './categories';

// The audit form has two steps: choose a brand and a category, then review and start. This is the
// rule for moving from the first to the second. It is a plain function so it can be tested without a browser.

export interface FormFields {
  brand: string;
  /** A category id, or "" when none has been chosen. No category is ever preselected. */
  category: string;
  customCategory: string;
}

export type ReviewResult = { ok: true; brand: string; categoryName: string } | { ok: false; message: string };

/**
 * Whether the details can be shown for confirmation. Nothing here starts an audit, uses a daily slot or
 * calls an API: this only decides whether the review step may open, and what it will say.
 */
export function reviewAuditDetails(fields: FormFields): ReviewResult {
  const brand = fields.brand.trim();
  if (brand === '') return { ok: false, message: 'Enter a brand name.' };
  const chosen = CATEGORIES.find((c) => c.id === fields.category);
  if (!chosen) return { ok: false, message: 'Choose a category.' };
  if (chosen.id === 'other') {
    const custom = fields.customCategory.trim();
    if (custom === '') return { ok: false, message: 'Describe the category.' };
    return { ok: true, brand, categoryName: custom };
  }
  return { ok: true, brand, categoryName: chosen.label };
}
