import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import { requireContext } from '../../../platform/context/request-context.js';

/** The caller's company; a caller without a tenant has nothing to see (404). */
export function tenant(): string {
  const { companyId } = requireContext();
  if (!companyId) throw new NotFoundException('Company not found');
  return companyId;
}

/** The authenticated caller's user id. */
export function callerId(): string {
  const { userId } = requireContext();
  if (!userId) throw new UnauthorizedException();
  return userId;
}
