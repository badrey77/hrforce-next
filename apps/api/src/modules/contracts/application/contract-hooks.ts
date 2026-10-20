import { Injectable } from '@nestjs/common';

/** Ends an employment at `endDate` (inclusive) with reason `end_of_contract`, under the Employment module's rules. */
export type EndEmploymentHook = (employmentId: string, endDate: string) => Promise<void>;

/**
 * What the Contracts module needs from the Employment module without importing it (Employment imports Contracts —
 * the reverse would be a cycle): the Employment module registers its end use case here on init. An approved
 * « end » decision calls it in the approval transaction.
 */
@Injectable()
export class ContractHooks {
  private endHook: EndEmploymentHook | undefined;

  registerEndEmployment(hook: EndEmploymentHook): void {
    this.endHook = hook;
  }

  endEmployment(employmentId: string, endDate: string): Promise<void> {
    if (!this.endHook) throw new Error('contracts: no end-of-employment hook registered (EmploymentModule not loaded)');
    return this.endHook(employmentId, endDate);
  }
}
