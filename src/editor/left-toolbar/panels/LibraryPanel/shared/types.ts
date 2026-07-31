// LibraryPanel preset category type definitions. Extracted as part
// of the LibraryPanel folder split. Pure types — no runtime.

import type { PresetToken } from '@/shared/types';

export type TokenCategory = PresetToken['category'];

export interface CategoryConfig {
  key: TokenCategory;
  label: string;
  prefix: string;
  defaultValue: string;
  emptyLabel?: string;
}

export interface DisplayCategory {
  label: string;
  emptyLabel: string;
  display: true;
}

export type AnyCategory = CategoryConfig | DisplayCategory;

export function isDisplayOnly(c: AnyCategory): c is DisplayCategory {
  return 'display' in c && c.display === true;
}
