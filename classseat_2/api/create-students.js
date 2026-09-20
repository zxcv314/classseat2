const crypto = require('crypto');
const { db, verifyRequest } = require('../lib/firebaseAdmin');

const genPin = () => String(Math.floor(1000 + Math.random() * 9000)); // 4자리

const hashPin = (pin, classId, number) =>
  crypto.createHash('sha256').update(`${classId}:${number}:${pin}:seatapp-salt`).digest('hex');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const decoded = await verifyRequest(req);
  if (!decoded) return res.status(401).json({ error: '인증이 필요합니다' });
  if (decoded.role === 'student') {
    return res.status(403).json({ error: '선생님만 학생 계정을 생성할 수 있습니다' });
  }

  const { classId, names } = req.body || {};
  if (!classId || !Array.isArray(names) || names.length === 0) {
    return res.status(400).json({ error: 'classId와 names(배열)가 필요합니다' });
  }

  const classRef = db.collection('classes').doc(classId);
  const classSnap = await classRef.get();
  if (!classSnap.exists) return res.status(404).json({ error: '반을 찾을 수 없습니다' });
  if (classSnap.data().teacherUid !== decoded.uid) {
    return res.status(403).json({ error: '이 반의 담당 선생님이 아닙니다' });
  }

  // 기존 roster에서 가장 큰 번호를 찾아 이어서 부여
  const roster = classSnap.data().roster || {};
  const existingNumbers = Object.keys(roster).map(Number).filter((n) => !isNaN(n));
  let nextNumber = existingNumbers.length ? Math.max(...existingNumbers) + 1 : 1;

  const created = [];
  const batch = db.batch();
  const newRoster = { ...roster };

  for (const name of names) {
    const number = String(nextNumber++);
    const pin = genPin();
    const studentRef = classRef.collection('students').doc(number);

    batch.set(studentRef, {
      name,
      number,
      pinHash: hashPin(pin, classId, number),
      mbti: null,
      eyesight: null,
      grade: null,
      height: null,
      preferredLocation: null,
      aircon: null,
      activity: null,
      preferredMates: [],
      avoidedMate: null,
      memo: '',
      submitted: false,
      updatedAt: new Date().toISOString(),
    });

    newRoster[number] = name;
    // 평문 PIN은 이 응답에만 한 번 포함되고 어디에도 저장되지 않는다.
    created.push({ number, name, pin });
  }

  batch.update(classRef, { roster: newRoster });

  await batch.commit();

  return res.status(200).json({ created });
};
