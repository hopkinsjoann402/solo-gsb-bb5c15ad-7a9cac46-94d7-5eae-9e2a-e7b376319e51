'use strict';

/**
 * 裁切抽检计划（cutting sampling plan）
 *
 * 在执行工单（src/workorder.js 的 workOrder 结果）之上，为质检环节生成
 * “抽检哪几张纸即可覆盖尽量多已分配全局刀次”的确定性抽检方案。
 *
 * 覆盖口径：
 *  - 工单中的每个**已分配全局刀次**（shifts[*].cuts[*]，拥有连续全局刀号）
 *    都是必须覆盖目标；一张纸被抽检时，覆盖它参与的**全部**已分配全局刀次
 *    （合批刀次一刀多张，抽检其中一张即覆盖该全局刀次）。
 *  - 工单单列的**未分配刀**（unassigned：超容量 / 父刀缺失 / 上游阻断）
 *    **不计入覆盖率分母**，原样在 unassignedCuts 中单列。已分配刀次成员表中
 *    被标记为未分配的成员刀（与现场进度同一口径）：该纸仍计入“参与刀次总数”
 *    （决胜键②），但该刀对该纸不是可执行覆盖项（决胜键①只数可执行成员刀）。
 *
 * 逐轮贪心选纸（每轮在“仍能新增覆盖”的纸中决胜）：
 *   1. **新增覆盖刀次最多**者优先（选中后新纳入覆盖集的全局刀次数）；
 *   2. 再按**该纸参与刀次总数多**者优先（该纸参与的全部已分配全局刀次数）；
 *   3. 再按**纸张序号小**者优先。
 * 达到抽检纸张上限（maxSamples）或全部目标刀次覆盖完成即止。
 *
 * 交叉核对（schedule 为叠纸排程结果，含 batches）：
 *  - 成员引用缺失：工单刀次成员在排程批次中找不到 → 400；
 *  - 重复归属：同一 {sheetIndex, cutNo} 在工单刀次或排程批次中出现多次 → 400；
 *  - schedule / workOrder 不一致：工单刀次来源批次缺失或其成员集合与排程批次
 *    不一致、未分配刀不在排程中 → 400。
 */

const MAX_SAMPLES_MAX = 10000; // 抽检纸张上限（与单班刀次上限同一量级）

/** 抽检上限规范化：1～max 的正整数 */
function normalizeMaxSamples(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error('抽检纸张上限必须是正整数');
  }
  if (n > MAX_SAMPLES_MAX) {
    throw new Error(`抽检纸张上限不能超过 ${MAX_SAMPLES_MAX}`);
  }
  return n;
}

/** 中文决胜依据 */
function basisNote(decidedBy, newCount, total, candidates, tiedOnNew, tiedOnTotal) {
  if (decidedBy === 'total-cuts') {
    return `候选 ${candidates} 张纸中本纸新增覆盖 ${newCount} 刀，与 ${tiedOnNew} 张纸并列最多；本纸共参与 ${total} 个刀次，为并列者中最多`;
  }
  if (decidedBy === 'sheet-index') {
    return `新增覆盖 ${newCount} 刀、参与 ${total} 个刀次均与另外 ${tiedOnTotal - 1} 张纸并列最多；按纸张序号最小选中本纸`;
  }
  return `候选 ${candidates} 张纸中本纸新增覆盖 ${newCount} 刀，为唯一最多（本纸共参与 ${total} 个刀次）`;
}

/**
 * 裁切抽检计划主入口。
 *
 * @param {object} input
 *   - workOrder：执行工单结果（必含 shifts，可含 unassigned）；
 *   - schedule：叠纸排程结果（必含 batches，用于成员引用与归属交叉核对）；
 *   - maxSamples：抽检纸张上限（1～10000 正整数，必填）。
 */
function cuttingSamplingPlan(input) {
  if (!input || typeof input !== 'object') {
    throw new Error('缺少裁切抽检计划输入');
  }

  const wo = input.workOrder;
  if (!wo || typeof wo !== 'object' || !Array.isArray(wo.shifts)) {
    throw new Error('缺少工单结果（workOrder）——请先生成执行工单');
  }

  const schedule = input.schedule;
  if (!schedule || typeof schedule !== 'object') {
    throw new Error('缺少排程结果（schedule）——裁切抽检计划需要排程与工单交叉核对');
  }
  if (!Array.isArray(schedule.batches) || schedule.batches.length === 0) {
    throw new Error('排程结果中没有任何刀次批次，无法生成裁切抽检计划');
  }

  const maxSamples = normalizeMaxSamples(input.maxSamples);

  /* ---------------- 排程批次：token → 批次号 ---------------- */

  const scheduleBatchOf = new Map(); // "sheetIndex:cutNo" → batchNo
  const scheduleBatchMembers = new Map(); // batchNo → token 集合
  const scheduleBatchNos = new Set();

  schedule.batches.forEach((b, i) => {
    if (!b || typeof b !== 'object' || !Array.isArray(b.members) || b.members.length === 0) {
      throw new Error(`排程第 ${i + 1} 批缺少成员（members）`);
    }
    const batchNo = Number.isInteger(b.batchNo) && b.batchNo >= 1 ? b.batchNo : i + 1;
    if (scheduleBatchNos.has(batchNo)) {
      throw new Error(`排程批次号重复：${batchNo}`);
    }
    scheduleBatchNos.add(batchNo);
    const tokens = new Set();
    b.members.forEach((m, j) => {
      if (!m
        || !(Number.isInteger(m.sheetIndex) && m.sheetIndex >= 1)
        || !(Number.isInteger(m.cutNo) && m.cutNo >= 1)) {
        throw new Error(`排程第 ${batchNo} 批第 ${j + 1} 个成员不是有效的 {sheetIndex, cutNo}`);
      }
      const token = `${m.sheetIndex}:${m.cutNo}`;
      if (scheduleBatchOf.has(token)) {
        throw new Error(`排程中第 ${m.sheetIndex} 张纸第 ${m.cutNo} 号刀出现在多个批次中，排程记录不合法`);
      }
      scheduleBatchOf.set(token, batchNo);
      tokens.add(token);
    });
    scheduleBatchMembers.set(batchNo, tokens);
  });

  /* ---------------- 工单未分配刀（单列、不计入分母） ---------------- */

  if (wo.unassigned !== undefined && !Array.isArray(wo.unassigned)) {
    throw new Error('工单 unassigned 必须是数组');
  }
  const unassignedTokens = new Set();
  const unassignedCuts = [];
  (Array.isArray(wo.unassigned) ? wo.unassigned : []).forEach((u) => {
    if (u
      && Number.isInteger(u.sheetIndex) && u.sheetIndex >= 1
      && Number.isInteger(u.cutNo) && u.cutNo >= 1) {
      const token = `${u.sheetIndex}:${u.cutNo}`;
      if (unassignedTokens.has(token)) return;
      unassignedTokens.add(token);
      unassignedCuts.push({
        sheetIndex: u.sheetIndex,
        cutNo: u.cutNo,
        reason: typeof u.reason === 'string' ? u.reason : 'blocked',
        detail: typeof u.detail === 'string' ? u.detail : null,
        batchNo: Number.isInteger(u.batchNo) ? u.batchNo : null,
      });
    }
  });
  unassignedCuts.sort((a, b) =>
    (a.sheetIndex - b.sheetIndex) || (a.cutNo - b.cutNo) || String(a.reason).localeCompare(String(b.reason)));
  // 未分配刀必须能在排程批次中找到（否则 schedule/workOrder 不一致）
  for (const token of unassignedTokens) {
    if (!scheduleBatchOf.has(token)) {
      const [si, cn] = token.split(':');
      throw new Error(`工单未分配刀（第 ${si} 张纸第 ${cn} 号刀）不在排程批次中，schedule/workOrder 不一致`);
    }
  }

  /* ---------------- 工单已分配刀次：解析 + 与排程交叉核对 ---------------- */

  const cuts = []; // { cutNo, batchNo, shiftNo, members:[{sheetIndex,cutNo}] }
  const cutByNo = new Map(); // 全局刀号 → cut
  const woTokenOwner = new Map(); // token → 全局刀号（重复归属检查）

  wo.shifts.forEach((shift, shi) => {
    if (!shift || !Array.isArray(shift.cuts)) {
      throw new Error(`工单第 ${shi + 1} 班记录不合法（缺少 cuts）`);
    }
    const shiftNo = Number.isInteger(shift.shiftNo) ? shift.shiftNo : shi + 1;
    shift.cuts.forEach((c) => {
      if (!c || !(Number.isInteger(c.cutNo) && c.cutNo >= 1)) {
        throw new Error(`工单第 ${shiftNo} 班存在缺少有效全局刀号的刀次记录`);
      }
      if (cutByNo.has(c.cutNo)) {
        throw new Error(`工单全局刀号重复：${c.cutNo}`);
      }
      if (!Number.isInteger(c.batchNo) || c.batchNo < 1) {
        throw new Error(`全局刀次 ${c.cutNo} 缺少来源批次号（batchNo），无法与排程核对`);
      }
      if (!scheduleBatchNos.has(c.batchNo)) {
        throw new Error(`全局刀次 ${c.cutNo} 的来源批次 ${c.batchNo} 不在排程批次中，schedule/workOrder 不一致`);
      }
      if (!Array.isArray(c.members) || c.members.length === 0) {
        throw new Error(`全局刀次 ${c.cutNo} 缺少成员（members）`);
      }
      const members = c.members.map((m, j) => {
        if (!m
          || !(Number.isInteger(m.sheetIndex) && m.sheetIndex >= 1)
          || !(Number.isInteger(m.cutNo) && m.cutNo >= 1)) {
          throw new Error(`全局刀次 ${c.cutNo} 第 ${j + 1} 个成员不是有效的 {sheetIndex, cutNo}`);
        }
        return { sheetIndex: m.sheetIndex, cutNo: m.cutNo };
      });

      const hereTokens = new Set();
      members.forEach((m) => {
        const token = `${m.sheetIndex}:${m.cutNo}`;
        // 成员引用缺失：工单成员必须在排程的某个批次中存在
        if (!scheduleBatchOf.has(token)) {
          throw new Error(`全局刀次 ${c.cutNo} 的成员（第 ${m.sheetIndex} 张纸第 ${m.cutNo} 号刀）不在排程批次中，成员引用缺失`);
        }
        // 重复归属：同一刀不得在同一刀次内重复、也不得跨刀次出现
        if (hereTokens.has(token) || woTokenOwner.has(token)) {
          throw new Error(`第 ${m.sheetIndex} 张纸第 ${m.cutNo} 号刀出现在多个已分配刀次中，工单记录不合法`);
        }
        hereTokens.add(token);
        woTokenOwner.set(token, c.cutNo);
      });

      // schedule/workOrder 不一致：刀次成员集合必须与其来源批次完全一致。
      // 成员引用缺失（成员根本不在排程中）已在上面拦截，这里只处理来源批次归属错位/多缺
      const schedTokens = scheduleBatchMembers.get(c.batchNo);
      if (hereTokens.size !== schedTokens.size
        || [...schedTokens].some((t) => !hereTokens.has(t))) {
        const onlyWo = [...hereTokens].filter((t) => !schedTokens.has(t));
        const onlySched = [...schedTokens].filter((t) => !hereTokens.has(t));
        const fmtList = (list) => list.slice(0, 3).map((t) => {
          const [si, cn] = t.split(':');
          return `${si}#${cn}`;
        }).join('、') + (list.length > 3 ? ' 等' : '');
        throw new Error(
          `全局刀次 ${c.cutNo}（来源批次 ${c.batchNo}）的成员与排程批次不一致`
          + `${onlyWo.length ? `：工单多出 ${fmtList(onlyWo)}` : ''}`
          + `${onlySched.length ? `；排程多出 ${fmtList(onlySched)}` : ''}`
        );
      }

      const rec = { cutNo: c.cutNo, batchNo: c.batchNo, shiftNo, members };
      cutByNo.set(c.cutNo, rec);
      cuts.push(rec);
    });
  });
  cuts.sort((a, b) => a.cutNo - b.cutNo);

  /* ---------------- 纸张 → 已分配全局刀次参与关系 ---------------- */

  // 参与总数（决胜键②）：一张纸在工单全部已分配刀次成员表中出现的刀次数，
  // 含被标记为未分配的成员刀（该纸仍参与该刀，只是该刀暂不能执行）；
  // 可抽检覆盖集（决胜键①）只含可执行成员刀，与现场进度同口径。
  const participationTotal = new Map(); // sheetIndex → Set(全局刀号)，含未分配成员
  const participation = new Map(); // sheetIndex → Set(全局刀号)，不含未分配成员刀
  const cutSheets = new Map(); // 全局刀号 → [sheetIndex...]（可执行成员纸张）
  cuts.forEach((rec) => {
    const sheets = [];
    rec.members.forEach((m) => {
      if (!participationTotal.has(m.sheetIndex)) participationTotal.set(m.sheetIndex, new Set());
      participationTotal.get(m.sheetIndex).add(rec.cutNo);
      if (unassignedTokens.has(`${m.sheetIndex}:${m.cutNo}`)) return;
      sheets.push(m.sheetIndex);
      if (!participation.has(m.sheetIndex)) participation.set(m.sheetIndex, new Set());
      participation.get(m.sheetIndex).add(rec.cutNo);
    });
    cutSheets.set(rec.cutNo, sheets);
  });
  // 候选纸张：参与至少一个已分配刀次（含仅有未分配成员刀的纸，前者由参与总数体现）
  const sheetIndices = [...participationTotal.keys()].sort((a, b) => a - b);
  const totalOf = (si) => (participationTotal.get(si) || new Set()).size;
  const coverSetOf = (si) => participation.get(si) || new Set();

  /* ---------------- 逐轮贪心选纸 ---------------- */

  // remaining：各纸尚未被覆盖的“可执行”参与刀次；每轮从中按三级决胜键选纸
  const remaining = new Map();
  sheetIndices.forEach((si) => remaining.set(si, new Set(coverSetOf(si))));

  const covered = new Set();
  const rounds = [];
  const samples = [];

  while (rounds.length < maxSamples) {
    const candidates = sheetIndices.filter((si) => remaining.get(si).size > 0);
    if (candidates.length === 0) break;

    let chosen = null;
    for (const si of candidates) {
      if (chosen == null) { chosen = si; continue; }
      const nNew = remaining.get(si).size;
      const bNew = remaining.get(chosen).size;
      const nTotal = totalOf(si);
      const bTotal = totalOf(chosen);
      // 新增覆盖刀次 ↓ → 参与刀次总数 ↓ → 纸张序号 ↑
      if (nNew > bNew || (nNew === bNew && (nTotal > bTotal
        || (nTotal === bTotal && si < chosen)))) {
        chosen = si;
      }
    }

    const newCuts = [...remaining.get(chosen)].sort((a, b) => a - b);
    newCuts.forEach((cutNo) => {
      covered.add(cutNo);
      (cutSheets.get(cutNo) || []).forEach((si) => remaining.get(si).delete(cutNo));
    });

    const roundNo = rounds.length + 1;
    rounds.push({
      roundNo,
      sheetIndex: chosen,
      newCutCount: newCuts.length,
      sheetCutsTotal: totalOf(chosen),
      coveredCutCount: covered.size,
      newCuts,
      basis: null, // 决胜依据在下方按逐轮快照统一回填
    });
    samples.push({
      roundNo,
      sheetIndex: chosen,
      sheetCutsTotal: totalOf(chosen),
      cuts: [...coverSetOf(chosen)].sort((a, b) => a - b),
      newCuts,
    });
  }

  // 回填逐轮依据（基于该轮选纸前快照重新统计并列情况，保证数字可审计）
  const replayCovered = new Set();
  rounds.forEach((round) => {
    const candidates = sheetIndices.filter((si) => {
      const left = [...coverSetOf(si)].filter((cutNo) => !replayCovered.has(cutNo)).length;
      return left > 0;
    });
    const newOf = (si) =>
      [...coverSetOf(si)].filter((cutNo) => !replayCovered.has(cutNo)).length;
    const maxNew = Math.max(...candidates.map(newOf));
    const tiedNew = candidates.filter((si) => newOf(si) === maxNew);
    const maxTotal = Math.max(...tiedNew.map(totalOf));
    const tiedTotal = tiedNew.filter((si) => totalOf(si) === maxTotal);
    const decidedBy = tiedNew.length === 1
      ? 'new-cuts'
      : (tiedTotal.length === 1 ? 'total-cuts' : 'sheet-index');
    round.basis = {
      decidedBy,
      candidates: candidates.length,
      tiedOnNew: tiedNew.length,
      tiedOnTotal: tiedTotal.length,
      note: basisNote(
        decidedBy, round.newCutCount, round.sheetCutsTotal,
        candidates.length, tiedNew.length, tiedTotal.length
      ),
    };
    round.newCuts.forEach((cutNo) => replayCovered.add(cutNo));
  });

  /* ---------------- 统计与输出 ---------------- */

  const cutsAssigned = cuts.length;
  const maxReached = rounds.length >= maxSamples;
  // 已无可抽检纸张（剩余纸张参与的全是未分配成员刀）时即便未满上限也停止
  const stopReason = covered.size === cutsAssigned
    ? 'covered'
    : maxReached ? 'max-samples' : 'no-eligible-sheets';

  const uncoveredCuts = cuts
    .filter((rec) => !covered.has(rec.cutNo))
    .map((rec) => ({
      cutNo: rec.cutNo,
      batchNo: rec.batchNo,
      shiftNo: rec.shiftNo,
      sheetCount: cutSheets.get(rec.cutNo).length,
      members: rec.members
        .filter((m) => !unassignedTokens.has(`${m.sheetIndex}:${m.cutNo}`))
        .map((m) => ({ sheetIndex: m.sheetIndex, cutNo: m.cutNo })),
    }));

  return {
    maxSamples,
    summary: {
      sheetsTotal: sheetIndices.length,
      cutsAssigned,
      samplesSelected: samples.length,
      cutsCovered: covered.size,
      cutsUncovered: cutsAssigned - covered.size,
      cutsUnassigned: unassignedCuts.length,
      coverageRate: cutsAssigned > 0 ? round6(covered.size / cutsAssigned) : 0,
      stopReason,
    },
    rounds,
    samples,
    uncoveredCuts,
    unassignedCuts,
  };
}

const round6 = (v) => Math.round(v * 1e6) / 1e6;

module.exports = { cuttingSamplingPlan, normalizeMaxSamples };
