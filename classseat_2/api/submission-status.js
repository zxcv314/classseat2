const { authTeacherClass } = require('../lib/firebaseAdmin');

// 선생님에게는 "누가 제출했는지(이름/번호/제출 여부)"만 알려준다.
// MBTI, 성적, 선호 짝꿍 등 학생이 입력한 내용은 절대 응답에 넣지 않는다.
module.exports = async (req, res) => {
  const h = await authTeacherClass(req, res);
  if (!h) return;

  const snap = await h.classRef.collection('students').get();
  const students = snap.docs
    .map((d) => {
      const s = d.data();
      return { number: d.id, name: s.name || '', submitted: !!s.submitted };
    })
    .sort((a, b) => Number(a.number) - Number(b.number));

  return res.status(200).json({
    total: students.length,
    submittedCount: students.filter((s) => s.submitted).length,
    students,
  });
};
