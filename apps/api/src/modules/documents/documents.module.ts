import { Module } from '@nestjs/common';
import { LeaveModule } from '../leave/index.js';
import { StaffingModule } from '../staffing/index.js';
import { WorkflowModule } from '../workflow/index.js';
import { DocumentsController, DocumentSettingsController, LogoUploadInterceptor, MyDocumentsController } from './api/documents.controller.js';
import { EmployeeFileCategoriesController, EmployeeFilesController, EmployeeFileUploadInterceptor } from './api/employee-files.controller.js';
import { DocumentIssuer } from './application/document-issuer.js';
import { DocumentPresenter } from './application/document-presenter.js';
import { DocumentSettingsService } from './application/document-settings.service.js';
import { DocumentsClock } from './application/documents-clock.js';
import { DocumentsService } from './application/documents.service.js';
import { EmployeeFileImporter } from './application/employee-file-importer.js';
import { EmployeeFileCategoriesService } from './application/employee-file-categories.service.js';
import { EmployeeFilesService } from './application/employee-files.service.js';
import { MyDocumentsService } from './application/my-documents.service.js';
import { DocumentsRepository } from './infra/documents.repository.js';
import { EmployeeFilesRepository } from './infra/employee-files.repository.js';

/**
 * Documents, Phase A (docs/contracts/documents.md, ADR 008): letterhead and signatories, document types and gap-free
 * numbering, issuing through the platform PdfRenderer (Typst), the register with its stored PDFs, void, and
 * self-service attestation requests (workflow subject `document_request`, notifications document.ready / rejected).
 * Phase B: the employee file (uploaded attachments by category, medical ones behind employee.medical.*, retention purge).
 */
@Module({
  imports: [StaffingModule, WorkflowModule, LeaveModule],
  controllers: [DocumentsController, DocumentSettingsController, MyDocumentsController, EmployeeFileCategoriesController, EmployeeFilesController],
  providers: [
    DocumentsRepository,
    DocumentIssuer,
    DocumentPresenter,
    DocumentsService,
    DocumentSettingsService,
    MyDocumentsService,
    DocumentsClock,
    LogoUploadInterceptor,
    EmployeeFilesRepository,
    EmployeeFilesService,
    EmployeeFileCategoriesService,
    EmployeeFileUploadInterceptor,
    EmployeeFileImporter,
  ],
  // the hire of a recruited candidate copies its files into the employee file (docs/contracts/recruitment.md › Hire)
  exports: [EmployeeFileImporter],
})
export class DocumentsModule {}
