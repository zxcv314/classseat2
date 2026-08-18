'use strict';
const crypto = require('crypto');
const { db, auth } = require('../lib/firebaseAdmin');

const hashPin = (pin, classId, number) =>
  crypto.createHash('sha256').update(`${classId}:${number}:${pin}:seatapp-salt`).digest('hex');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const { classId, number, pin } = req.body || {};
  if (!classId || !number || !pin) return res.status(400).json({ error: '번호와 PIN을 입력하세요' });

  const studentRef = db.collection('classes').doc(classId).collection('students').doc(String(number));
  const snap = await studentRef.get();
  if (!snap.exists) return res.status(401).json({ error: '학번 또는 PIN이 올바르지 않습니다' });

  const data = snap.data();
  if (data.pinHash !== hashPin(String(pin), classId, String(number))) {
    return res.status(401).json({ error: '학번 또는 PIN이 올바르지 않습니다' });
  }

  // 학생 전용 uid. role/classId/number 커스텀 클레임으로 Firestore 보안규칙이
  // "본인 문서만" 읽고 쓸 수 있게 강제합니다 (선생님 uid는 이 클레임을 절대 못 가짐).
  const uid = `student_${classId}_${number}`;
  const token = await auth.createCustomToken(uid, { role: 'student', classId, number: String(number) });

  return res.status(200).json({ token, name: data.name });
};
