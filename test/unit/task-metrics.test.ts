import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  compareDecimal,
  isSlaBreached,
  exceedsGateDwellTarget,
  groupOpenTasks,
  assertValidTaskFilters,
  GATE_DWELL_TARGET_MINUTES,
  SUPPORTED_TASK_TYPES,
  type OpenTask,
} from '../../src/warehouse/task-metrics.js';
import {
  normalizeThresholdMinutes,
  WAREHOUSE_TASK_SUPERVISE_ROLES,
} from '../../src/compliance/warehouse-task.js';
import { AppError } from '../../src/middleware/error.js';

/**
 * Story 3.8 (Task 8.2): the pure decision math behind the task board and the gate-dwell exception.
 *
 * These are the functions that decide whether a business fact is true - "this task has breached its
 * SLA", "this shift missed the 4-minute target" - so they are tested independently of the database.
 * Every boundary case here is one AC1 or AC3 states in words.
 */

function task(overrides: Partial<OpenTask> = {}): OpenTask {
  return {
    task_type: 'picking',
    task_id: '11111111-1111-4111-8111-111111111111',
    site_id: '22222222-2222-4222-8222-222222222222',
    zone_id: null,
    assigned_to: null,
    priority: 'normal',
    status: 'pending',
    created_at: '2026-07-29T00:00:00.000Z',
    age_minutes: 10,
    age_minutes_exact: '10.000000',
    sla_threshold_minutes: null,
    breached: false,
    breached_threshold_minutes: null,
    ...overrides,
  };
}

describe('Story 3.8 task-metrics: exact decimal comparison', () => {
  it('compares equal values across differing scales', () => {
    assert.equal(compareDecimal('4', '4.00'), 0);
    assert.equal(compareDecimal('4.000000', '4'), 0);
    assert.equal(compareDecimal('0', '0.0'), 0);
  });

  it('orders by magnitude, not by string length or lexical order', () => {
    assert.equal(compareDecimal('10', '9'), 1);
    assert.equal(compareDecimal('9', '10'), -1);
    assert.equal(compareDecimal('4.10', '4.09'), 1);
    assert.equal(compareDecimal('100.5', '100.50000001'), -1);
  });

  it('does not inherit binary floating-point error', () => {
    // 0.1 + 0.2 > 0.3 is true in IEEE-754 doubles. As decimals it is false.
    assert.equal(compareDecimal('0.3', '0.30000000000000004'), -1);
    assert.equal(compareDecimal('0.30', '0.3'), 0);
  });

  it('handles negative values and treats -0 as 0', () => {
    assert.equal(compareDecimal('-1', '1'), -1);
    assert.equal(compareDecimal('-2', '-1'), -1);
    assert.equal(compareDecimal('-0', '0'), 0);
    assert.equal(compareDecimal('-0.5', '0'), -1);
  });
});

describe('Story 3.8 AC1: SLA breach decision', () => {
  it('flags a task whose age strictly exceeds its threshold', () => {
    assert.equal(isSlaBreached('30.5', '30'), true);
  });

  it('does not flag a task sitting exactly at its threshold', () => {
    assert.equal(isSlaBreached('30.000000', '30.00'), false);
  });

  it('does not flag a task below its threshold', () => {
    assert.equal(isSlaBreached('29.999999', '30.00'), false);
  });

  it('treats an unconfigured threshold as "no SLA", never as a breach and never as a default', () => {
    assert.equal(isSlaBreached('99999', null), false);
  });
});

describe('Story 3.8 AC3: gate-dwell exception decision', () => {
  it('flags a shift whose median exceeds 4 minutes', () => {
    assert.equal(exceedsGateDwellTarget('4.000001'), true);
    assert.equal(exceedsGateDwellTarget('7.5'), true);
  });

  it('does NOT flag a shift whose median is exactly 4 minutes (AC3 says "exceeds")', () => {
    assert.equal(exceedsGateDwellTarget('4'), false);
    assert.equal(exceedsGateDwellTarget('4.000000'), false);
    assert.equal(exceedsGateDwellTarget('4.00'), false);
  });

  it('does not flag a shift under the target', () => {
    assert.equal(exceedsGateDwellTarget('3.999999'), false);
  });

  it('treats a shift with no resolved dwell (empty set) as no exception', () => {
    assert.equal(exceedsGateDwellTarget(null), false);
  });

  it('a single-vehicle shift is its own median', () => {
    // With one vehicle, percentile_cont returns that vehicle's dwell verbatim; the decision below
    // is therefore the whole shift outcome.
    assert.equal(exceedsGateDwellTarget('4.5'), true);
    assert.equal(exceedsGateDwellTarget('2.0'), false);
  });

  it('pins the documented target', () => {
    assert.equal(GATE_DWELL_TARGET_MINUTES, 4);
  });
});

describe('Story 3.8 AC1: board grouping', () => {
  it('returns no groups for an empty task set', () => {
    assert.deepEqual(groupOpenTasks([]), []);
  });

  it('groups by task type and then by operator, counting breaches at both levels', () => {
    const alice = '33333333-3333-4333-8333-333333333333';
    const groups = groupOpenTasks([
      task({ task_id: 'a', assigned_to: alice, breached: true, breached_threshold_minutes: '30' }),
      task({ task_id: 'b', assigned_to: alice }),
      task({ task_id: 'c', task_type: 'putaway' }),
    ]);
    const picking = groups.find((g) => g.task_type === 'picking');
    const putaway = groups.find((g) => g.task_type === 'putaway');
    assert.ok(picking && putaway);
    assert.equal(picking.open_count, 2);
    assert.equal(picking.breached_count, 1);
    assert.equal(picking.operators.length, 1);
    assert.equal(picking.operators[0]!.assigned_to, alice);
    assert.equal(picking.operators[0]!.breached_count, 1);
    assert.equal(putaway.open_count, 1);
    assert.equal(putaway.breached_count, 0);
    // An unassigned task groups under a null operator, not under an empty-string operator id.
    assert.equal(putaway.operators[0]!.assigned_to, null);
  });
});

describe('Story 3.8 Task 4.3: filter validation happens before any query', () => {
  const validate = (qs: string): void => assertValidTaskFilters(new URLSearchParams(qs));

  it('accepts an empty filter set', () => {
    assert.doesNotThrow(() => validate(''));
  });

  it('accepts every supported task type', () => {
    for (const taskType of SUPPORTED_TASK_TYPES) {
      assert.doesNotThrow(() => validate(`task_type=${taskType}`));
    }
  });

  it('rejects an unknown task_type with 400 INVALID_PARAMS', () => {
    assert.throws(
      () => validate('task_type=teleportation'),
      (err: unknown) =>
        err instanceof AppError && err.statusCode === 400 && err.errorCode === 'INVALID_PARAMS',
    );
  });

  it('rejects a non-UUID id filter rather than letting Postgres raise 22P02', () => {
    for (const key of ['zone_id', 'assigned_to', 'site_id', 'operator_id']) {
      assert.throws(
        () => validate(`${key}=not-a-uuid`),
        (err: unknown) =>
          err instanceof AppError && err.statusCode === 400 && err.errorCode === 'INVALID_PARAMS',
        `${key} must be rejected`,
      );
    }
  });

  it('rejects a malformed business_date and a malformed period bound', () => {
    assert.throws(() => validate('business_date=29-07-2026'), AppError);
    assert.throws(() => validate('period_start=yesterday'), AppError);
  });

  it('rejects an inverted or empty period window', () => {
    assert.throws(
      () => validate('period_start=2026-07-29T10:00:00Z&period_end=2026-07-29T09:00:00Z'),
      AppError,
    );
    assert.throws(
      () => validate('period_start=2026-07-29T10:00:00Z&period_end=2026-07-29T10:00:00Z'),
      AppError,
    );
    assert.doesNotThrow(() =>
      validate('period_start=2026-07-29T09:00:00Z&period_end=2026-07-29T10:00:00Z'),
    );
  });
});

describe('Story 3.8 Task 3.3: SLA threshold normalization', () => {
  it('accepts positive values within NUMERIC(9,2) precision', () => {
    assert.equal(normalizeThresholdMinutes(30), '30');
    assert.equal(normalizeThresholdMinutes('30.5'), '30.5');
    assert.equal(normalizeThresholdMinutes('0.01'), '0.01');
  });

  it('rejects zero, negatives, and non-finite values', () => {
    assert.equal(normalizeThresholdMinutes(0), null);
    assert.equal(normalizeThresholdMinutes(-5), null);
    assert.equal(normalizeThresholdMinutes(Number.NaN), null);
    assert.equal(normalizeThresholdMinutes(Number.POSITIVE_INFINITY), null);
  });

  it('rejects more precision than the column can hold rather than letting Postgres round it', () => {
    assert.equal(normalizeThresholdMinutes('30.005'), null);
  });

  it('rejects values that are not numbers at all', () => {
    assert.equal(normalizeThresholdMinutes('soon'), null);
    assert.equal(normalizeThresholdMinutes(null), null);
    assert.equal(normalizeThresholdMinutes(undefined), null);
    assert.equal(normalizeThresholdMinutes('1e3'), null);
  });
});

describe('Story 3.8 Task 7.1: role sets are explicit', () => {
  it('restricts SLA-threshold changes to supervisors', () => {
    assert.deepEqual(WAREHOUSE_TASK_SUPERVISE_ROLES, ['warehouse_manager', 'inventory_controller']);
  });
});
