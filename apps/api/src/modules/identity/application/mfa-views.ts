/** GET /api/me/mfa (docs/contracts/mfa.md › Endpoints). */
export interface MfaStatusView {
  enabled: boolean;
  required: boolean;
  /** ISO timestamp of the activation, null when not enabled */
  enrolledAt: string | null;
  /** unused recovery codes, null when not enabled */
  recoveryCodesLeft: number | null;
}

/** The `mfa` block of GET /api/me. */
export interface MeMfaView {
  enabled: boolean;
  required: boolean;
  recoveryCodesLeft: number | null;
}

/** POST /api/me/mfa/enroll/start — shown once, to the user themselves. */
export interface MfaEnrollmentView {
  /** base32 TOTP key (no padding) for manual entry */
  secret: string;
  otpauthUri: string;
  /** QR code of otpauthUri, `data:image/png;base64,…` */
  qrPng: string;
}

/** POST /api/me/mfa/enroll/confirm and /recovery-codes — shown once. */
export interface RecoveryCodesView {
  recoveryCodes: string[];
}

/** POST /api/auth/login when a second step is needed. */
export interface MfaRequiredView {
  mfaRequired: true;
}
