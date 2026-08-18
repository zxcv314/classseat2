'use strict';
const crypto = require('crypto');
const { db, verifyRequest } = require('../lib/firebaseAdmin');

const hashPin = (pin, classId, number) =>
  crypto.createHash('sha256').update(`${classId}:${number}:${pin}:seatapp-salt`).digest('hex');

const genPin = () => String(Math.floor(1000 + Math.random() * 9000)); // 4자리

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const decoded = await verifyRequest(req);
  if (!decoded || decoded.role === 'student') return res.status(401).json({ error: '선생님 인증이 필요합니다' });

  const { classId, names } = req.body || {};
  if (!classId || !Array.isArray(names) || names.length === 0) {
    return res.status(400).json({ error: 'classId, names[] 가 필요합니다' });
  }

  const classRef = db.collection('classes').doc(classId);
  const classSnap = await classRef.get();
  if (!classSnap.exists || classSnap.data().teacherUid !== decoded.uid) {
    return res.status(403).json({ error: '이 반에 대한 권한이 없습니다' });
  }

  // 이미 등록된 학생 수 확인 (번호 이어서 부여)
  const existing = await classRef.collection('students').get();
  let nextNum = existing.size + 1;
  const roster = classSnap.data().roster || {};

  const batch = db.batch();
  const created = [];
  for (const rawName of names) {
    const name = String(rawName || '').trim();
    if (!name) continue;
    const number = String(nextNum++);
    const pin = genPin();
    const studentRef = classRef.collection('students').doc(number);
    batch.set(studentRef, {
      name,
      number,
      pinHash: hashPin(pin, classId, number),
      submitted: false,
      createdAt: new Date().toISOString(),
      // 설문 응답 필드는 학생이 직접 입력하기 전까지 비어있음
      mbti: '', eyesight: false, grade: '', height: '', preferredLocation: '상관없음',
      aircon: '상관없음', activity: '중간', preferredMates: [], avoidedMate: '', memo: '',
    });
    roster[number] = name;
    created.push({ number, name, pin });
  }
  batch.update(classRef, { roster });
  await batch.commit();

  // PIN은 이 응답에서 딱 한 번만 평문으로 나갑니다 (선생님이 지금 화면에서 학생들에게 나눠줘야 함).
  return res.status(200).json({ created });
};
