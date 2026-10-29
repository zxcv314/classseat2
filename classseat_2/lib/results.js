// 배치 결과 저장: results/current(현재 결과) + history/{id}(이력)에 함께 쓰고, 오래된 이력은 정리한다.
const MAX_HISTORY = 20;

async function saveResult(db, classRef, data, label) {
  const now = new Date().toISOString();
  const histRef = classRef.collection('history').doc();
  const payload = { ...data, label, createdAt: now, historyId: histRef.id };

  const batch = db.batch();
  batch.set(classRef.collection('results').doc('current'), payload);
  batch.set(histRef, payload);
  await batch.commit();

  // 최근 MAX_HISTORY개만 보관
  const old = await classRef.collection('history').orderBy('createdAt', 'desc').offset(MAX_HISTORY).get();
  if (!old.empty) {
    const b = db.batch();
    old.docs.forEach((d) => b.delete(d.ref));
    await b.commit();
  }
  return payload;
}

module.exports = { saveResult, MAX_HISTORY };
