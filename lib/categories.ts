// Category list shared by the form (browser) and the audit engine (server).
import type { CategoryId } from './types';

export interface CategoryDef {
  id: CategoryId;
  label: string;
  /** How the category reads inside a search query, e.g. "skincare". */
  noun: string;
  /** How its brands are referred to in a question, e.g. "skincare brands". */
  plural: string;
}

export const CATEGORIES: readonly CategoryDef[] = [
  { id: 'skincare', label: 'Skincare', noun: 'skincare', plural: 'skincare brands' },
  { id: 'fashion', label: 'Clothing and fashion', noun: 'clothing', plural: 'clothing brands' },
  { id: 'homeware', label: 'Homeware', noun: 'homeware', plural: 'homeware brands' },
  { id: 'cookware', label: 'Cookware', noun: 'cookware', plural: 'cookware brands' },
  { id: 'beverages', label: 'Beverages', noun: 'beverage', plural: 'beverage brands' },
  { id: 'agencies', label: 'Marketing agencies', noun: 'marketing agency', plural: 'marketing agencies' },
  { id: 'other', label: 'Other', noun: '', plural: '' },
];

export function getCategory(id: string): CategoryDef | undefined {
  return CATEGORIES.find((c) => c.id === id);
}

export const BRAND_MAX_LENGTH = 60;
export const CUSTOM_CATEGORY_MAX_LENGTH = 40;
