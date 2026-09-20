const { db, verifyRequest } = require('../lib/firebaseAdmin');
const { buildCtx, runOptimizer } = require('../lib/seatAlgo');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const decoded = await verifyRequest(req);
  if (!decoded) return res.status(401).json({ error: '인증이 필요합니다' });
  if (decoded.role === 'student') {
    return res.status(403).json({ error: '선생님만 배치를 실행할 수 있습니다' });
  }

  const { classId } = req.body || {};
  if (!classId) return res.status(400).json({ error: 'classId가 필요합니다' });

  const classRef = db.collection('classes').doc(classId);
  const classSnap = await classRef.get();
  if (!classSnap.exists) return res.status(404).json({ error: '반을 찾을 수 없습니다' });

  const classData = classSnap.data();
  if (classData.teacherUid !== decoded.uid) {
    return res.status(403).json({ error: '이 반의 담당 선생님이 아닙니다' });
  }

  const { rows, cols, grid, constraints, weights } = classData;
  if (!rows || !cols || !Array.isArray(grid)) {
    return res.status(400).json({ error: '이 반의 좌석 배치도가 아직 설정되지 않았습니다' });
  }

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
    constraints: constraints || {},
    weights: weights || {},
    ctx,
    rows,
    cols,
  });

  await classRef.collection('results').doc('current').set({
    rows: result.rows,
    cols: result.cols,
    grid: result.grid,
    score: result.score,
    breakdown: result.breakdown,
    createdAt: new Date().toISOString(),
  });

  // 응답에도 결과(좌석/이름)만 돌려주고, students 원본 배열은 절대 포함하지 않는다.
  return res.status(200).json({
    rows: result.rows,
    cols: result.cols,
    grid: result.grid,
    score: result.score,
    breakdown: result.breakdown,
  });
};
