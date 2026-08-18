'use strict';
const admin = require('firebase-admin');

// Vercel 환경변수에 다음 세 개를 등록해야 합니다 (README 참고):
//   FIREBASE_PROJECT_ID
//   FIREBASE_CLIENT_EMAIL
//   FIREBASE_PRIVATE_KEY   (줄바꿈은 \n 로 이스케이프해서 저장 → 아래서 복원)
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    }),
  });
}

const db = admin.firestore();
const auth = admin.auth();

/** Authorization: Bearer <idToken> 헤더를 검증하고 decoded token을 리턴. 실패시 null. */
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

module.exports = { admin, db, auth, verifyRequest };
