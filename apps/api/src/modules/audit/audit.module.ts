import { Global, Module } from '@nestjs/common';
import { AuditEvents } from '../../platform/audit/audit-events.js';
import { AuditController } from './api/audit.controller.js';
import { TimelineService } from './application/timeline.service.js';
import { AuditRepository } from './infra/audit.repository.js';
import { PgAuditEvents } from './infra/pg-audit-events.js';

/**
 * Audit (docs/contracts/audit.md, ADR 005). Row changes are captured by the database (trigger audit.capture(),
 * migration 0009); this module provides the platform seam {@link AuditEvents} for application events (GLOBAL, so
 * Identity and Authorization emit without importing this module) and the history endpoint GET /api/audit/timeline.
 */
@Global()
@Module({
  controllers: [AuditController],
  providers: [AuditRepository, TimelineService, { provide: AuditEvents, useClass: PgAuditEvents }],
  exports: [AuditEvents],
})
export class AuditModule {}
