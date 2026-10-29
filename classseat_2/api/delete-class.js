const { db, auth, authTeacherClass } = require('../lib/firebaseAdmin');

// 반 삭제: 반 문서 + 모든 서브컬렉션(students, results, history, settings)을 지우고,
// 학생 로그인으로 만들어진 Firebase Auth 계정도 정리한다.
module.exports = async (req, res) => {
  const h = await authTeacherClass(req, res);
  if (!h) return;
  const { classId, classRef, classData } = h;

  const uids = Object.keys(classData.roster || {}).map((n) => `student_${classId}_${n}`);

  try {
    await db.recursiveDelete(classRef);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: '반 삭제 중 오류가 발생했습니다' });
  }

  // Auth 계정 정리는 최선 시도 (한 번도 로그인하지 않은 학생은 계정이 없을 수 있음)
  try {
    for (let i = 0; i < uids.length; i += 1000) {
      await auth.deleteUsers(uids.slice(i, i + 1000));
    }
  } catch (e) {
    console.error('학생 Auth 계정 정리 실패(무시):', e);
  }

  return res.status(200).json({ ok: true });
};
