const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    }),
  });
}

const auth = admin.auth();
const db = admin.firestore();

// 가중치 기본값 (public/index.html의 DEFAULT_WEIGHTS와 같게 유지)
const DEFAULT_WEIGHTS = {
  location: 5, seat: 5, aircon: 3, mates: 6, personality: 3, grade: 4, height: 4, activity: 3,
};

/**
 * 클라이언트가 보낸 "Authorization: Bearer <idToken>" 헤더를 검증해서
 * 요청을 보낸 사람이 누구인지(uid, custom claims 포함) 확인한다.
 * 실패하면 null을 반환한다.
 */
async function verifyRequest(req) {
  const header = req.headers.authorization || '';
  const m = header.match(/^Bearer (.+)$/);
  if (!m) return null;
  try {
    return await auth.verifyIdToken(m[1]);
  } catch (e) {
    return null;
  }
}

/**
 * "이 반의 담당 선생님인가"를 한 번에 검사하는 공통 헬퍼.
 * 통과하면 { decoded, classId, classRef, classData, body }를 반환하고,
 * 실패하면 응답(res)을 직접 보내고 null을 반환한다.
 */
async function authTeacherClass(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return null;
  }
  const decoded = await verifyRequest(req);
  if (!decoded) {
    res.status(401).json({ error: '인증이 필요합니다' });
    return null;
  }
  if (decoded.role === 'student') {
    res.status(403).json({ error: '선생님만 사용할 수 있습니다' });
    return null;
  }
  const body = req.body || {};
  const classId = body.classId;
  if (!classId || typeof classId !== 'string') {
    res.status(400).json({ error: 'classId가 필요합니다' });
    return null;
  }
  const classRef = db.collection('classes').doc(classId);
  const snap = await classRef.get();
  if (!snap.exists) {
    res.status(404).json({ error: '반을 찾을 수 없습니다' });
    return null;
  }
  const classData = snap.data();
  if (classData.teacherUid !== decoded.uid) {
    res.status(403).json({ error: '이 반의 담당 선생님이 아닙니다' });
    return null;
  }
  return { decoded, classId, classRef, classData, body };
}

/**
 * 제약조건/가중치는 학생이 읽을 수 없도록 classes/{id}/settings/config 에 둔다.
 * (예전에 만든 반은 class 문서에 들어 있으므로 없으면 거기서 읽는다.)
 */
async function loadSettings(classRef, classData) {
  const snap = await classRef.collection('settings').doc('config').get();
  const s = snap.exists ? snap.data() : {};
  return {
    constraints: s.constraints ?? classData.constraints ?? {},
    weights: { ...DEFAULT_WEIGHTS, ...(s.weights ?? classData.weights ?? {}) },
  };
}

module.exports = { admin, auth, db, verifyRequest, authTeacherClass, loadSettings, DEFAULT_WEIGHTS };
