'use strict';

const assert = require('node:assert');
const { test } = require('node:test');
const { layoutBatch } = require('../src/packer');
const { stackSchedule } = require('../src/stack');
const { workOrder } = require('../src/workorder');
const { cuttingSamplingPlan } = require('../src/sampling');

const EPS = 1e-9;

/** 精简批次（与 workorder.test.js 同构） */
function batchNode(no, members, extra = {}) {
  return {
    batchNo: no,
    orient: 'h', kerf: 0, position: 1,
    region: { w: 100, h: 100 }, cutLength: 100,
    totalLength: 100 * members.length, sheetCount: members.length,
    capped: false,
    members: members.map(([si, cn]) => ({ sheetIndex: si, cutNo: cn })),
    ...extra,
  };
}

/** 由排程批次生成与之完全一致的工单刀次（1..N 连续，全在第 1 班） */
function workOrderFromBatches(batches, unassigned = []) {
  return {
    source: 'batch',
    stackLimit: null,
    dependencySource: 'dependencies',
    maxCutsPerShift: batches.length + 1,
    maxSheetsPerBatch: 500,
    summary: {},
    shifts: [{
      shiftNo: 1,
      cutsTotal: batches.length,
      sheetsCut: batches.reduce((s, b) => s + b.members.length, 0),
      cuts: batches.map((b) => ({
        shiftNo: 1,
        cutInShift: b.batchNo,
        cutNo: b.batchNo,
        batchNo: b.batchNo,
        orient: 'h', kerf: 0, position: 1,
        region: { w: 100, h: 100 }, cutLength: 100,
        totalLength: b.totalLength, sheetCount: b.members.length, capped: false,
        members: b.members.map((m) => ({ sheetIndex: m.sheetIndex, cutNo: m.cutNo })),
      })),
    }],
    crossShiftDeps: [],
    unassigned: unassigned.map((u) => ({
      sheetIndex: u[0], cutNo: u[1], reason: u[2] || 'blocked',
      detail: 'x', batchNo: u[3] == null ? null : u[3],
    })),
  };
}

/** 由排程批次生成与之完全一致的工单刀次（1..N 连续，全在第 1 班） */

/* ---------------- 基本选择与覆盖 ---------------- */

test('抽检计划：逐轮按新增覆盖最多选纸，覆盖完成提前停止', () => {
  // 刀1: 纸1/2/3；刀2: 纸1/2；刀3: 纸1
  const sched = {
    batches: [
      batchNode(1, [[1, 1], [2, 1], [3, 1]]),
      batchNode(2, [[1, 2], [2, 2]]),
      batchNode(3, [[1, 3]]),
    ],
  };
  const wo = workOrderFromBatches(sched.batches);
  const r = cuttingSamplingPlan({ workOrder: wo, schedule: sched, maxSamples: 5 });

  assert.strictEqual(r.summary.sheetsTotal, 3);
  assert.strictEqual(r.summary.cutsAssigned, 3);
  assert.deepStrictEqual(r.rounds.map((x) => x.sheetIndex), [1]); // 纸1 覆盖全部 3 刀
  assert.strictEqual(r.summary.samplesSelected, 1);
  assert.strictEqual(r.summary.cutsCovered, 3);
  assert.strictEqual(r.summary.cutsUncovered, 0);
  assert.ok(Math.abs(r.summary.coverageRate - 1) < EPS);
  assert.strictEqual(r.summary.stopReason, 'covered');
  assert.strictEqual(r.rounds[0].basis.decidedBy, 'new-cuts');
  assert.deepStrictEqual(r.rounds[0].newCuts, [1, 2, 3]);
  assert.deepStrictEqual(r.samples[0].cuts, [1, 2, 3]);
  assert.deepStrictEqual(r.uncoveredCuts, []);
  assert.deepStrictEqual(r.unassignedCuts, []);
});

test('抽检计划：达到抽检纸张上限即止，未覆盖刀次列出', () => {
  // 三张互不搭界的纸，各 1 刀 → maxSamples=2 时恰好覆盖 2/3
  const sched = {
    batches: [
      batchNode(1, [[1, 1]]),
      batchNode(2, [[2, 1]]),
      batchNode(3, [[3, 1]]),
    ],
  };
  const wo = workOrderFromBatches(sched.batches);
  const r = cuttingSamplingPlan({ workOrder: wo, schedule: sched, maxSamples: 2 });

  assert.strictEqual(r.summary.stopReason, 'max-samples');
  assert.strictEqual(r.summary.samplesSelected, 2);
  assert.deepStrictEqual(r.rounds.map((x) => x.sheetIndex), [1, 2]); // 序号决胜
  assert.ok(Math.abs(r.summary.coverageRate - 2 / 3) < 1e-6);
  assert.strictEqual(r.uncoveredCuts.length, 1);
  assert.strictEqual(r.uncoveredCuts[0].cutNo, 3);
  assert.strictEqual(r.uncoveredCuts[0].shiftNo, 1);
  assert.strictEqual(r.uncoveredCuts[0].batchNo, 3);
  assert.deepStrictEqual(r.uncoveredCuts[0].members, [{ sheetIndex: 3, cutNo: 1 }]);
});

/* ---------------- 三级决胜键 ---------------- */

test('抽检计划：新增覆盖并列且参与总数并列时按纸张序号小决胜', () => {
  // 刀1: 纸1/2/3；刀2: 纸1/2；刀3: 纸2/3；刀4: 纸3
  // 首轮：纸2/3 各新增 3 且参与总数各 3 → 序号小 → 纸2；之后纸3 收尾
  const sched = {
    batches: [
      batchNode(1, [[1, 1], [2, 1], [3, 1]]),
      batchNode(2, [[1, 2], [2, 2]]),
      batchNode(3, [[2, 3], [3, 2]]),
      batchNode(4, [[3, 3]]),
    ],
  };
  const wo = workOrderFromBatches(sched.batches);
  const r = cuttingSamplingPlan({ workOrder: wo, schedule: sched, maxSamples: 5 });

  assert.deepStrictEqual(r.rounds.map((x) => x.sheetIndex), [2, 3]);
  assert.strictEqual(r.rounds[0].basis.decidedBy, 'sheet-index');
  assert.strictEqual(r.rounds[0].basis.tiedOnNew, 2);
  assert.strictEqual(r.rounds[0].basis.tiedOnTotal, 2);
  assert.strictEqual(r.rounds[1].basis.decidedBy, 'new-cuts');
  assert.strictEqual(r.summary.cutsCovered, 4);
});

test('抽检计划：新增覆盖并列时按该纸参与刀次总数多决胜', () => {
  // 刀1: 纸1/2/3；刀2: 纸1/2；刀3: 纸2；刀4: 纸3；刀5: 纸1
  // 第1轮：纸1/2 新增3并列、总数3并列 → 序号小纸1，覆盖刀1/2/5
  // 第2轮：纸2 剩刀3（新增1，共参与3）、纸3 剩刀4（新增1，共参与2）→ 总数多 → 纸2
  const sched = {
    batches: [
      batchNode(1, [[1, 1], [2, 1], [3, 1]]),
      batchNode(2, [[1, 2], [2, 2]]),
      batchNode(3, [[2, 3]]),
      batchNode(4, [[3, 2]]),
      batchNode(5, [[1, 3]]),
    ],
  };
  const wo = workOrderFromBatches(sched.batches);
  const r = cuttingSamplingPlan({ workOrder: wo, schedule: sched, maxSamples: 5 });

  assert.deepStrictEqual(r.rounds.map((x) => x.sheetIndex), [1, 2, 3]);
  assert.strictEqual(r.rounds[1].basis.decidedBy, 'total-cuts');
  assert.strictEqual(r.rounds[1].basis.tiedOnNew, 2);
  assert.strictEqual(r.rounds[1].basis.tiedOnTotal, 1);
  assert.strictEqual(r.rounds[1].sheetCutsTotal, 3);
  assert.strictEqual(r.rounds[2].basis.decidedBy, 'new-cuts');
});

test('抽检计划：逐轮依据为选纸前快照（新增数随覆盖递减）', () => {
  const sched = {
    batches: [
      batchNode(1, [[1, 1], [2, 1]]),
      batchNode(2, [[1, 2], [2, 2]]),
      batchNode(3, [[2, 3]]),
    ],
  };
  const wo = workOrderFromBatches(sched.batches);
  const r = cuttingSamplingPlan({ workOrder: wo, schedule: sched, maxSamples: 5 });
  // 纸2 参与 3 刀 > 纸1 参与 2 刀 → 首轮纸2，纸1 不再新增
  assert.deepStrictEqual(r.rounds.map((x) => x.sheetIndex), [2]);
  assert.strictEqual(r.rounds[0].newCutCount, 3);
  assert.strictEqual(r.rounds[0].coveredCutCount, 3);
  assert.deepStrictEqual(r.samples[0].cuts, [1, 2, 3]);
  assert.deepStrictEqual(r.samples[0].newCuts, [1, 2, 3]);
});

test('抽检计划：后续轮次新增覆盖随覆盖集递减，samples 的 newCuts 仅含本轮新增', () => {
  // 刀1: 纸1/2；刀2: 纸1；刀3: 纸2 → 首轮新增相同（各1？不）
  // 纸1 参与 {1,2}、纸2 参与 {1,3}：首轮新增均为 2、总数均为 2 → 序号小纸1，覆盖 1/2；
  // 第2轮纸2 新增刀3（刀1已覆盖）
  const sched = {
    batches: [
      batchNode(1, [[1, 1], [2, 1]]),
      batchNode(2, [[1, 2]]),
      batchNode(3, [[2, 2]]),
    ],
  };
  const wo = workOrderFromBatches(sched.batches);
  const r = cuttingSamplingPlan({ workOrder: wo, schedule: sched, maxSamples: 5 });
  assert.deepStrictEqual(r.rounds.map((x) => x.sheetIndex), [1, 2]);
  assert.strictEqual(r.rounds[0].newCutCount, 2);
  assert.strictEqual(r.rounds[0].coveredCutCount, 2);
  assert.strictEqual(r.rounds[1].newCutCount, 1);
  assert.strictEqual(r.rounds[1].coveredCutCount, 3);
  assert.strictEqual(r.rounds[1].basis.candidates, 1);
  assert.deepStrictEqual(r.samples[1].cuts, [1, 3]);
  assert.deepStrictEqual(r.samples[1].newCuts, [3]);
});

/* ---------------- 未分配刀单列、不计入分母 ---------------- */

test('抽检计划：未分配成员刀不参与覆盖，未分配清单单列且不计入分母', () => {
  // 批1: 纸1/2（纸2#1 在工单 unassigned 中）；批2: 纸1#2 未分配（整批未分配，不出现在 cuts）
  const sched = {
    batches: [
      batchNode(1, [[1, 1], [2, 1]]),
      batchNode(2, [[1, 2]]),
    ],
  };
  const wo = {
    shifts: [{
      shiftNo: 1, cutsTotal: 1, sheetsCut: 2,
      cuts: [{
        shiftNo: 1, cutInShift: 1, cutNo: 1, batchNo: 1,
        orient: 'h', kerf: 0, position: 1, region: { w: 100, h: 100 },
        cutLength: 100, totalLength: 200, sheetCount: 2, capped: false,
        members: [{ sheetIndex: 1, cutNo: 1 }, { sheetIndex: 2, cutNo: 1 }],
      }],
    }],
    crossShiftDeps: [],
    unassigned: [
      { sheetIndex: 2, cutNo: 1, reason: 'over-capacity', detail: 'x', batchNo: 1 },
      { sheetIndex: 1, cutNo: 2, reason: 'blocked', detail: 'x', batchNo: 2 },
    ],
  };
  // 只有全局刀次 1 已分配，其中纸2#1 未被分配 → 可执行成员只剩纸1；
  // 但纸2 仍出现在已分配刀次成员表中，参与纸张总数仍为 2
  const r = cuttingSamplingPlan({ workOrder: wo, schedule: sched, maxSamples: 5 });

  assert.strictEqual(r.summary.cutsAssigned, 1);
  assert.strictEqual(r.summary.cutsUnassigned, 2);
  assert.strictEqual(r.summary.sheetsTotal, 2);
  assert.deepStrictEqual(r.rounds.map((x) => x.sheetIndex), [1]); // 纸2 没有可覆盖的可执行刀次
  assert.ok(Math.abs(r.summary.coverageRate - 1) < EPS); // 分母只含已分配刀次
  assert.deepStrictEqual(r.unassignedCuts.map((u) => `${u.sheetIndex}:${u.cutNo}`), ['1:2', '2:1']);
});

test('抽检计划：已分配刀次成员表中的未分配成员不计入该刀可抽检覆盖', () => {
  const sched = { batches: [batchNode(1, [[1, 1], [2, 1]])] };
  const wo = workOrderFromBatches(sched.batches, [[2, 1, 'missing-parent', 1]]);
  const r = cuttingSamplingPlan({ workOrder: wo, schedule: sched, maxSamples: 1 });
  assert.strictEqual(r.summary.sheetsTotal, 2);
  assert.deepStrictEqual(r.samples[0].cuts, [1]);
  assert.strictEqual(r.samples[0].sheetIndex, 1);
});

/* ---------------- 与真实排程/工单贯通 ---------------- */

test('抽检计划：真实批量排产→排程→工单贯通，覆盖率与人工计算一致', () => {
  const r = layoutBatch({
    paperW: 420, paperH: 300, kerf: 2, maxSheets: 6,
    products: [
      { width: 150, height: 120, quantity: 24 },
      { width: 80, height: 60, quantity: 30 },
    ],
  });
  assert.ok(r.sheets.length >= 2);
  const sched = stackSchedule({ stackLimit: 2, sheets: r.sheets });
  const wo = workOrder({ schedule: sched, maxCutsPerShift: 5 });

  const plan = cuttingSamplingPlan({ workOrder: wo, schedule: sched, maxSamples: sched.batches.length });
  assert.strictEqual(plan.summary.stopReason, 'covered');
  assert.strictEqual(plan.summary.cutsAssigned, sched.batches.length);
  assert.strictEqual(plan.summary.cutsCovered, sched.batches.length);
  assert.ok(plan.summary.samplesSelected <= r.sheets.length);
  assert.ok(Math.abs(plan.summary.coverageRate - 1) < EPS);

  // 人工复核覆盖并集：每张抽检纸参与刀次的并集恰为全部已分配全局刀次
  const allCuts = new Set();
  wo.shifts.forEach((s) => s.cuts.forEach((c) => allCuts.add(c.cutNo)));
  const union = new Set();
  for (const sample of plan.samples) sample.cuts.forEach((c) => union.add(c));
  assert.strictEqual(union.size, allCuts.size);
  [...allCuts].forEach((c) => assert.ok(union.has(c)));

  // 每张纸上报的参与刀次与工单成员逐一核对
  const expectOf = new Map();
  wo.shifts.forEach((s) => s.cuts.forEach((c) => {
    c.members.forEach((m) => {
      if (!expectOf.has(m.sheetIndex)) expectOf.set(m.sheetIndex, new Set());
      expectOf.get(m.sheetIndex).add(c.cutNo);
    });
  }));
  plan.samples.forEach((sample) => {
    assert.deepStrictEqual(
      new Set(sample.cuts),
      expectOf.get(sample.sheetIndex),
      `第 ${sample.sheetIndex} 张纸的覆盖刀次必须等于其参与刀次`
    );
  });
});

test('抽检计划：同输入两次运行结果完全一致（确定性）', () => {
  const r = layoutBatch({
    paperW: 420, paperH: 300, kerf: 2, maxSheets: 6,
    products: [{ width: 150, height: 120, quantity: 24 }],
  });
  const sched = stackSchedule({ stackLimit: 2, sheets: r.sheets });
  const wo = workOrder({ schedule: sched, maxCutsPerShift: 3 });
  const a = cuttingSamplingPlan({ workOrder: wo, schedule: sched, maxSamples: 2 });
  const b = cuttingSamplingPlan({ workOrder: wo, schedule: sched, maxSamples: 2 });
  assert.deepStrictEqual(JSON.stringify(a), JSON.stringify(b));
});

/* ---------------- 校验：成员引用缺失 / 重复归属 / 不一致 ---------------- */

test('抽检计划：成员引用缺失返回 400 语义错误', () => {
  const sched = {
    batches: [
      batchNode(1, [[1, 1], [2, 1]]),
      batchNode(2, [[1, 2]]),
    ],
  };
  const wo = workOrderFromBatches([
    batchNode(1, [[1, 1], [9, 1]]),
    batchNode(2, [[1, 2]]),
  ]);
  assert.throws(
    () => cuttingSamplingPlan({ workOrder: wo, schedule: sched, maxSamples: 5 }),
    /成员引用缺失/
  );
});

test('抽检计划：重复归属（跨刀次 / 同刀次 / 排程批次）报错', () => {
  const sched = {
    batches: [
      batchNode(1, [[1, 1], [2, 1]]),
      batchNode(2, [[1, 2]]),
    ],
  };
  // 跨刀次重复
  assert.throws(
    () => cuttingSamplingPlan({
      workOrder: workOrderFromBatches([
        batchNode(1, [[1, 1], [2, 1]]),
        batchNode(2, [[1, 1]]),
      ]),
      schedule: sched, maxSamples: 5,
    }),
    /多个已分配刀次/
  );
  // 同一刀次成员重复
  assert.throws(
    () => cuttingSamplingPlan({
      workOrder: workOrderFromBatches([batchNode(1, [[1, 1], [1, 1]])]),
      schedule: { batches: [batchNode(1, [[1, 1]])] },
      maxSamples: 5,
    }),
    /多个已分配刀次/
  );
  // 排程同一刀出现在多批
  assert.throws(
    () => cuttingSamplingPlan({
      workOrder: workOrderFromBatches([batchNode(1, [[1, 1]])]),
      schedule: { batches: [batchNode(1, [[1, 1]]), batchNode(2, [[1, 1]])] },
      maxSamples: 5,
    }),
    /出现在多个批次/
  );
});

test('抽检计划：schedule/workOrder 成员集合不一致或来源批次缺失报错', () => {
  const sched = {
    batches: [
      batchNode(1, [[1, 1], [2, 1]]),
      batchNode(2, [[1, 2]]),
    ],
  };
  // 工单刀次比来源批次少成员
  assert.throws(
    () => cuttingSamplingPlan({
      workOrder: workOrderFromBatches([
        batchNode(1, [[1, 1]]),
        batchNode(2, [[1, 2]]),
      ]),
      schedule: sched, maxSamples: 5,
    }),
    /成员与排程批次不一致/
  );
  // 工单刀次比来源批次多成员（该成员存在于排程其他批次 → 归属错位而非引用缺失）
  const schedSwap = {
    batches: [
      batchNode(1, [[1, 1], [2, 1]]),
      batchNode(2, [[1, 2], [3, 1]]),
    ],
  };
  assert.throws(
    () => cuttingSamplingPlan({
      workOrder: workOrderFromBatches([
        batchNode(1, [[1, 1], [2, 1], [3, 1]]),
        batchNode(2, [[1, 2], [3, 1]]),
      ]),
      schedule: schedSwap, maxSamples: 5,
    }),
    /成员与排程批次不一致/
  );
  // 来源批次号不存在
  assert.throws(
    () => cuttingSamplingPlan({
      workOrder: workOrderFromBatches([
        batchNode(1, [[1, 1], [2, 1]]),
        batchNode(9, [[1, 2]]),
      ]),
      schedule: sched, maxSamples: 5,
    }),
    /来源批次 9 不在排程批次中/
  );
  // 未分配刀不在排程批次中
  assert.throws(
    () => cuttingSamplingPlan({
      workOrder: workOrderFromBatches(
        [batchNode(1, [[1, 1], [2, 1]]), batchNode(2, [[1, 2]])],
        [[9, 9, 'blocked', null]]
      ),
      schedule: sched, maxSamples: 5,
    }),
    /工单未分配刀.*不在排程批次中/
  );
});

test('抽检计划：入参与记录非法时报错', () => {
  const sched = { batches: [batchNode(1, [[1, 1]])] };
  const goodWo = workOrderFromBatches(sched.batches);

  assert.throws(() => cuttingSamplingPlan(), /抽检计划输入/);
  assert.throws(() => cuttingSamplingPlan(null), /抽检计划输入/);
  assert.throws(() => cuttingSamplingPlan({ schedule: sched, maxSamples: 5 }), /缺少工单/);
  assert.throws(() => cuttingSamplingPlan({ workOrder: goodWo, maxSamples: 5 }), /缺少排程/);
  assert.throws(
    () => cuttingSamplingPlan({ workOrder: goodWo, schedule: { batches: [] }, maxSamples: 5 }),
    /没有任何刀次批次/
  );
  for (const v of [0, -1, 1.2, 'x', NaN, undefined, 10001]) {
    assert.throws(
      () => cuttingSamplingPlan({ workOrder: goodWo, schedule: sched, maxSamples: v }),
      /抽检纸张上限/,
      `maxSamples=${v} 应报错`
    );
  }
  assert.throws(
    () => cuttingSamplingPlan({
      workOrder: { shifts: [{ cuts: [{ cutNo: 1, batchNo: 1, members: [{ sheetIndex: 1, cutNo: 1 }] }] }], unassigned: 'x' },
      schedule: sched, maxSamples: 5,
    }),
    /unassigned 必须是数组/
  );
  // 全局刀号重复
  assert.throws(
    () => cuttingSamplingPlan({
      workOrder: {
        shifts: [
          { cuts: [{ cutNo: 1, batchNo: 1, members: [{ sheetIndex: 1, cutNo: 1 }] }] },
          { cuts: [{ cutNo: 1, batchNo: 2, members: [{ sheetIndex: 1, cutNo: 2 }] }] },
        ],
        unassigned: [],
      },
      schedule: { batches: [batchNode(1, [[1, 1]]), batchNode(2, [[1, 2]])] },
      maxSamples: 5,
    }),
    /全局刀号重复/
  );
});

test('抽检计划：边界——全部批次均未分配时没有可抽检纸张，覆盖率为 0', () => {
  // 批1 整批在工单 unassigned（工单侧没有任何已分配刀次）
  const sched = { batches: [batchNode(1, [[1, 1], [2, 1]])] };
  const wo = {
    shifts: [],
    unassigned: [
      { sheetIndex: 1, cutNo: 1, reason: 'over-capacity', detail: 'x', batchNo: 1 },
      { sheetIndex: 2, cutNo: 1, reason: 'over-capacity', detail: 'x', batchNo: 1 },
    ],
  };
  const r = cuttingSamplingPlan({ workOrder: wo, schedule: sched, maxSamples: 5 });
  assert.strictEqual(r.summary.cutsAssigned, 0);
  assert.strictEqual(r.summary.sheetsTotal, 0); // 没有任何已分配刀次 → 没有参与纸张
  assert.strictEqual(r.summary.samplesSelected, 0);
  assert.strictEqual(r.summary.coverageRate, 0);
  assert.strictEqual(r.summary.stopReason, 'covered'); // 目标集合为空，视为覆盖完成
  assert.deepStrictEqual(r.rounds, []);
  assert.deepStrictEqual(r.samples, []);
  assert.strictEqual(r.unassignedCuts.length, 2);
});

test('抽检计划：unassigned 中的非法记录被忽略（与现场进度同口径）', () => {
  const sched = {
    batches: [
      batchNode(1, [[1, 1], [2, 1]]),
      batchNode(2, [[2, 2]]),
    ],
  };
  const wo = workOrderFromBatches(sched.batches, [[2, 1, 'over-capacity', 1]]);
  wo.unassigned.push(null, { sheetIndex: 'x' }, {});
  const r = cuttingSamplingPlan({ workOrder: wo, schedule: sched, maxSamples: 5 });
  assert.strictEqual(r.unassignedCuts.length, 1);
  assert.deepStrictEqual(r.unassignedCuts[0], {
    sheetIndex: 2, cutNo: 1, reason: 'over-capacity', detail: 'x', batchNo: 1,
  });
});
