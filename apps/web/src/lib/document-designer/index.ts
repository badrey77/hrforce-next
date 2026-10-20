/**
 * The document template designer package (docs/contracts/document-templates.md › Web › Designer package). It imports
 * nothing from the app (`src/app/**`), so it can move to its own app later; `boundary.spec.ts` enforces it.
 */
export { DocumentDesigner } from './document-designer';
export { FieldsEditor, fieldKeyError, freeFieldKey } from './fields-editor';
export { InlineEditor, type PlaceholderOption, type SelectedChip } from './inline-editor';
export { DEFAULT_DESIGNER_LABELS, DESIGNER_LABELS, type DesignerLabels } from './labels';
export * from './layout.model';
export { History } from './layout-ops';
export { docToInlines, inlinesToDoc } from './inline-schema';
