'use strict';
const { db, verifyRequest } = require('../lib/firebaseAdmin');
const { runOptimizer, buildCtx } = require('../lib/seatAlgo');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const decoded = await verifyRequest(req);
  if (!decoded || decoded.role === 'student') return res.status(401).json({ error: '선생님 인증이 필요합니다' });

  const { classId } = req.body || {};
  if (!classId) return res.status(400).json({ error: 'classId가 필요합니다' });

  const classRef = db.collection('classes').doc(classId);
  const classSnap = await classRef.get();
  if (!classSnap.exists || classSnap.data().teacherUid !== decoded.uid) {
    return res.status(403).json({ error: '이 반에 대한 권한이 없습니다' });
  }
  const cls = classSnap.data();
  const { rows, cols, grid, constraints, weights } = cls;
  if (!rows || !cols || !grid) return res.status(400).json({ error: '교실 크기를 먼저 설정하세요' });

  // ── 학생 원본 데이터는 여기, 서버 메모리에서만 다룹니다. 클라이언트로는 절대 안 나갑니다. ──
  const studentsSnap = await classRef.collection('students').get();
  const students = studentsSnap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((s) => s.submitted); // 아직 정보 입력 안 한 학생은 배치 대상에서 제외

  if (students.length === 0) {
    return res.status(400).json({ error: '정보를 입력한 학생이 아직 없습니다' });
  }

  const ctx = buildCtx(grid, rows, cols, students);
  const result = runOptimizer({
    students,
    constraints: constraints || {},
    weights: weights || { location: 5, mate: 6, personality: 10, grade: 10, lively: 5 },
    ctx,
    rows,
    cols,
  });

  if (!result) {
    return res.status(422).json({ error: '조건을 만족하는 배치를 찾지 못했습니다 (제약조건을 완화해보세요)' });
  }

  // 좌석별 {number,name} 만 남기고 그 외 정보는 전부 제거한 안전한 그리드로 변환
  const bySeat = {};
  Object.entries(result.assignment).forEach(([studentId, seatKey]) => { bySeat[seatKey] = studentId; });
  const nameOf = {}; students.forEach((s) => { nameOf[s.id] = s.name; });

  const safeGrid = [];
  for (let r = 0; r < rows; r++) {
    const row = [];
    for (let c = 0; c < cols; c++) {
      const cell = grid[r * cols + c];
      const key = r + '_' + c;
      const sid = bySeat[key];
      row.push({
        type: cell.type,
        aircon: !!cell.aircon,
        number: sid || null,
        name: sid ? (nameOf[sid] || '') : null,
      });
    }
    safeGrid.push(row);
  }

  await classRef.collection('results').doc('current').set({
    rows, cols,
    grid: safeGrid,
    score: result.score,
    breakdown: result.breakdown,
    createdAt: new Date().toISOString(),
  });

  return res.status(200).json({ ok: true });
};
