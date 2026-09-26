/**
 * Workflow definitions and progress (docs/contracts/leave.md › Workflow engine, ADR 006). Pure domain code.
 *
 * A definition is an ordered list of steps; each step is either
 *   - `manager`: the subject's manager (resolved by the subject module at the moment the step opens), or
 *   - `permission`: every user holding `permission` over the subject's unit (evaluated at READ time).
 * The last step must be a `permission` step: an escalated manager step falls through to it.
 */

export interface Labels {
  fr: string;
  ar: string;
  en: string;
}

export type StepKind = 'manager' | 'permission';

export interface StepDef {
  key: string;
  kind: StepKind;
  permission?: string;
  labels: Labels;
}

export type InstanceStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';
export type TaskStatus = 'open' | 'done' | 'skipped' | 'cancelled';
export type TaskOutcome = 'approve' | 'reject' | 'escalated';

/** Why a manager step was escalated (recorded as the task's comment). */
export type EscalationReason = 'no-manager' | 'manager-not-linked' | 'manager-is-requester';

export class WorkflowRuleViolation extends Error {
  constructor(
    readonly slug: 'workflow-self-approval' | 'workflow-task-closed' | 'workflow-definition',
    message: string,
    readonly field?: string,
  ) {
    super(message);
  }
}

const STEP_KEY = /^[a-z][a-z0-9_]{0,31}$/;
const PERMISSION = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,2}$/;

function isLabels(value: unknown): value is Labels {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return ['fr', 'ar', 'en'].every((k) => typeof v[k] === 'string' && (v[k] as string).trim() !== '');
}

/** Validates a stored / submitted `steps` document. Throws `workflow-definition` when malformed. */
function bad(message: string): never {
  throw new WorkflowRuleViolation('workflow-definition', message, 'steps');
}

export function parseSteps(value: unknown): StepDef[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 10) bad('A definition has 1 to 10 steps.');
  const steps = (value as unknown[]).map((raw, i): StepDef => {
    if (typeof raw !== 'object' || raw === null) return bad(`Step ${i} is not an object.`);
    const s = raw as Record<string, unknown>;
    if (typeof s['key'] !== 'string' || !STEP_KEY.test(s['key'])) bad(`Step ${i}: invalid key.`);
    if (!isLabels(s['labels'])) bad(`Step ${i}: labels fr/ar/en are required.`);
    const labels = s['labels'] as Labels;
    if (s['kind'] === 'manager') return { key: s['key'] as string, kind: 'manager', labels };
    if (s['kind'] === 'permission') {
      if (typeof s['permission'] !== 'string' || !PERMISSION.test(s['permission'])) bad(`Step ${i}: invalid permission.`);
      return { key: s['key'] as string, kind: 'permission', permission: s['permission'] as string, labels };
    }
    return bad(`Step ${i}: kind must be manager or permission.`);
  });
  if (new Set(steps.map((s) => s.key)).size !== steps.length) bad('Step keys must be unique.');
  if (steps.at(-1)?.kind !== 'permission') bad('The last step must be a permission step (escalations fall through to it).');
  return steps;
}

export interface TaskFact {
  stepIndex: number;
  status: TaskStatus;
  outcome: TaskOutcome | null;
}

export type StepState = 'done' | 'current' | 'pending' | 'escalated' | 'rejected' | 'cancelled' | 'skipped';

export interface StepProgress {
  key: string;
  kind: StepKind;
  labels: Labels;
  state: StepState;
}

/**
 * The state of each step from the instance status and its task history (latest task per step wins):
 * done (approved), escalated (manager step skipped), rejected, cancelled (open when the request was cancelled),
 * current (open task), pending (not reached yet), skipped (not reached because the instance finished earlier).
 */
export function progressOf(steps: readonly StepDef[], tasks: readonly TaskFact[], status: InstanceStatus): StepProgress[] {
  const latest = new Map<number, TaskFact>();
  for (const t of tasks) latest.set(t.stepIndex, t);
  return steps.map((step, i) => {
    const task = latest.get(i);
    let state: StepState;
    if (!task) state = status === 'pending' ? 'pending' : 'skipped';
    else if (task.status === 'open') state = 'current';
    else if (task.status === 'skipped') state = 'escalated';
    else if (task.status === 'cancelled') state = 'cancelled';
    else state = task.outcome === 'reject' ? 'rejected' : 'done';
    return { key: step.key, kind: step.kind, labels: step.labels, state };
  });
}

/** Separation of duties: the users who may never act on the instance's tasks. */
export function excludedActors(startedBy: string, subjectUserId: string | null): Set<string> {
  const excluded = new Set([startedBy]);
  if (subjectUserId) excluded.add(subjectUserId);
  return excluded;
}
