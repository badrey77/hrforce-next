// The demo relying party must stay a separate app: it may not import HRForce's API (or web) code.
import { leak } from '../../api/src/platform/db/leak.js';
export const reached = leak;
