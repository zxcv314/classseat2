const { db, authTeacherClass, loadSettings } = require('../lib/firebaseAdmin');
const { buildCtx, runOptimizer } = require('../lib/seatAlgo');
const { saveResult } = require('../lib/results');

module.exports = async (req, res) => {
  const h = await authTeacherClass(req, res);
  if (!h) return;
  const { classRef, classData } = h;

  const { rows, cols, grid } = classData;
  if (!rows || !cols || !Array.isArray(grid)) {
    return res.status(400).json({ error: '이 반의 좌석 배치도가 아직 설정되지 않았습니다' });
  }
  if (classData.archived) {
    return res.status(400).json({ error: '보관된 반입니다. 보관을 해제한 뒤 실행하세요' });
  }

  const settings = await loadSettings(classRef, classData);

  // ── 학생 원본 데이터는 여기, 서버 메모리에서만 다룹니다. 클라이언트로는 절대 안 나갑니다. ──
  const studentsSnap = await classRef.collection('students').get();
  const students = studentsSnap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((s) => s.submitted);

  if (students.length === 0) {
    return res.status(400).json({ error: '정보를 입력한 학생이 아직 없습니다' });
  }

  const ctx = buildCtx(grid, rows, cols);
  if (students.length > ctx.seatIdx.length) {
    return res.status(400).json({ error: '학생 수가 좌석 수보다 많습니다' });
  }

  const result = runOptimizer({
    students,
    constraints: settings.constraints,
    weights: settings.weights,
    ctx,
    rows,
    cols,
  });

  const saved = await saveResult(db, classRef, {
    rows: result.rows,
    cols: result.cols,
    grid: result.grid,
    score: result.score,
    breakdown: result.breakdown,
    warnings: result.warnings,
  }, '자동 배치');

  // 응답에도 결과(좌석/이름)만 돌려주고, students 원본 배열은 절대 포함하지 않는다.
  return res.status(200).json({
    rows: saved.rows,
    cols: saved.cols,
    grid: saved.grid,
    score: saved.score,
    breakdown: saved.breakdown,
    warnings: saved.warnings,
  });
};
