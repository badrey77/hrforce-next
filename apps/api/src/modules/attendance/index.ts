/** Public surface of the Attendance module (the only file other modules may import). */
export { AttendanceModule } from './attendance.module.js';
export { AttendanceClock, AttendanceKeys } from './application/attendance-clock.js';
export { ATTENDANCE_PERMISSIONS } from './application/presence.service.js';
export { runAttendanceRetention, type AttendanceRetentionResult } from './application/attendance-retention.js';
export { algiersDate, algiersInstant, retentionCutoff } from './domain/time.js';
export {
  deriveKeys,
  encodeKioskCookie,
  sha256 as attendanceSha256,
  signQrToken,
  signScanReceipt,
  windowOf,
  WINDOW_SECONDS,
  type AttendanceKeys as AttendanceKeySet,
} from './domain/tokens.js';
export {
  AGENCY_WEEK,
  DEMO_KIOSKS,
  DEMO_PAIRING_CODE,
  DEMO_SCHEDULES,
  RAMADAN_WEEK,
  seedAttendanceDefaults,
  seedDemoAttendance,
  seedDemoAttendanceSetup,
  seedDemoPunches,
  weekOf,
} from './infra/attendance-seed.js';
