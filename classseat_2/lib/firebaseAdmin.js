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

module.exports = { admin, auth, db, verifyRequest };
