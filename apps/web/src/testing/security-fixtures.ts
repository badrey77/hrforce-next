import type { MfaEnrollment } from '../app/core/auth/mfa.models';

/** `POST /api/me/mfa/enroll/start` answer (docs/contracts/mfa.md). */
export const ENROLLMENT: MfaEnrollment = {
  secret: 'JBSWY3DPEHPK3PXPJBSWY3DP',
  otpauthUri: 'otpauth://totp/HRForce:rh.admin@demo.dz?secret=JBSWY3DPEHPK3PXPJBSWY3DP&issuer=HRForce',
  qrPng: 'data:image/png;base64,iVBORw0KGgo=',
};

/** A (short) set of recovery codes. */
export const CODES: readonly string[] = ['AAAAA-BBBBB', 'CCCCC-DDDDD', 'EEEEE-FFFFF'];
