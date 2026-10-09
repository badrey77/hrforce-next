/** Public surface of the Branding module (the only file other modules may import). */
export { BrandingModule } from './branding.module.js';
export { BrandingService } from './application/branding.service.js';
export type { BrandingSettingsView, CompanyBrandingView, InstallationBrandingView, LogoView, PublicBranding } from './application/branding-views.js';
export {
  BRAND_COLORS,
  BRANDING_LIMITS,
  BRANDING_LOGO_MAX_BYTES,
  BRANDING_PERMISSION,
  type BrandColor,
  type EffectiveBranding,
  type Lang3,
  type LogoRef,
} from './domain/types.js';
export { DEMO_BRANDING, moveBrandingOwner, seedBrandingDefaults, seedDemoBranding, type OwnerMove } from './infra/branding-seed.js';
