const { db, authTeacherClass, loadSettings } = require('../lib/firebaseAdmin');
const { buildCtx, evaluateLayout } = require('../lib/seatAlgo');
const { saveResult } = require('../lib/results');

const fail = (res, code, msg) => res.status(code).json({ error: msg });

// 수동 미세조정 저장: 학생끼리(또는 빈 자리와) 자리를 맞바꾼 좌석표만 허용한다.
async function saveManual(h, res) {
  const { classRef, classData, body } = h;
  const curSnap = await classRef.collection('results').doc('current').get();
  if (!curSnap.exists) return fail(res, 400, '현재 배치 결과가 없습니다');
  const cur = curSnap.data();

  const grid = body.grid;
  if (!Array.isArray(grid) || grid.length !== cur.grid.length) {
    return fail(res, 400, '좌석표 크기가 맞지 않습니다');
  }
  for (let i = 0; i < grid.length; i++) {
    const o = cur.grid[i];
    const n = grid[i];
    if (!n || n.type !== o.type || !!n.aircon !== !!o.aircon) {
      return fail(res, 400, '좌석 배치도 구조가 바뀌었습니다. 자리 맞바꾸기만 가능합니다');
    }
  }
  const numbersOf = (g) =>
    g.filter((x) => x.type === 'seat' && x.number != null && x.number !== '').map((x) => String(x.number)).sort();
  const before = numbersOf(cur.grid);
  const after = numbersOf(grid);
  if (before.length !== after.length || before.some((v, i) => v !== after[i])) {
    return fail(res, 400, '학생 구성이 달라졌습니다. 자리 맞바꾸기만 가능합니다');
  }

  // 이름은 클라이언트가 보낸 값을 믿지 않고 기존 결과/명단에서 다시 채운다.
  const roster = classData.roster || {};
  const nameByNumber = {};
  cur.grid.forEach((c) => {
    if (c.type === 'seat' && c.number != null) nameByNumber[String(c.number)] = c.name;
  });
  const newGrid = cur.grid.map((o, i) => {
    if (o.type !== 'seat') return { type: o.type, aircon: !!o.aircon };
    const num = grid[i].number != null && grid[i].number !== '' ? String(grid[i].number) : null;
    return { type: 'seat', aircon: !!o.aircon, number: num, name: num ? nameByNumber[num] ?? roster[num] ?? null : null };
  });

  // 점수/제약 위반을 서버에서 다시 계산 (학생 원본 데이터는 서버 안에서만 사용)
  const settings = await loadSettings(classRef, classData);
  const studentsSnap = await classRef.collection('students').get();
  const students = studentsSnap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((s) => s.submitted);
  const ctx = buildCtx(newGrid, cur.rows, cur.cols);
  // 고정석 키는 현재 좌석표 기준이므로, 배치 이후 좌석표 크기가 바뀌었다면 고정석 검사는 건너뛴다.
  const sameLayout = cur.rows === classData.rows && cur.cols === classData.cols;
  const constraints = { ...settings.constraints, fixedSeats: sameLayout ? settings.constraints.fixedSeats : {} };
  const ev = evaluateLayout({ grid: newGrid, students, constraints, weights: settings.weights, ctx });

  const saved = await saveResult(db, classRef, {
    rows: cur.rows, cols: cur.cols, grid: newGrid, score: ev.score, breakdown: ev.breakdown, warnings: ev.warnings,
  }, '수동 조정');
  return res.status(200).json({ score: saved.score, warnings: saved.warnings });
}

// 이력 복원: 이력 문서를 현재 결과(results/current)로 되돌린다.
async function restore(h, res) {
  const { classRef, body } = h;
  const historyId = body.historyId;
  if (!historyId || typeof historyId !== 'string') return fail(res, 400, 'historyId가 필요합니다');
  const hs = await classRef.collection('history').doc(historyId).get();
  if (!hs.exists) return fail(res, 404, '해당 이력을 찾을 수 없습니다');
  await classRef.collection('results').doc('current').set({
    ...hs.data(),
    label: '복원',
    historyId,
    restoredFrom: historyId,
    restoredAt: new Date().toISOString(),
  });
  return res.status(200).json({ ok: true });
}

module.exports = async (req, res) => {
  const h = await authTeacherClass(req, res);
  if (!h) return;
  try {
    if (h.body.action === 'save-manual') return await saveManual(h, res);
    if (h.body.action === 'restore') return await restore(h, res);
    return fail(res, 400, '알 수 없는 action입니다');
  } catch (e) {
    console.error(e);
    return fail(res, 500, '처리 중 오류가 발생했습니다');
  }
};
