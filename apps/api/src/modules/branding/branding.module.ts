import { Module } from '@nestjs/common';
import { BrandingController, BrandingLogoUploadInterceptor } from './api/branding.controller.js';
import { BrandingService } from './application/branding.service.js';
import { BrandingRepository } from './infra/branding.repository.js';

/**
 * Branding settings (docs/contracts/branding.md): the app title, welcome texts, logos, brand colour code, sign-in
 * message and footer — per company, plus one installation default used before sign-in and inherited by a company
 * that set nothing. Imports only `platform/**`; BrandingService is exported for Identity (`GET /api/me` → `branding`).
 */
@Module({
  controllers: [BrandingController],
  providers: [BrandingRepository, BrandingService, BrandingLogoUploadInterceptor],
  exports: [BrandingService],
})
export class BrandingModule {}
