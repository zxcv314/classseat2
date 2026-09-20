// ──────────────────────────────────────────────────────────────────────────
// lib/seatAlgo.js
// 시뮬레이티드 어닐링 기반 좌석배치 최적화 알고리즘.
// 이 파일은 순수 함수만 다루고, Firestore/HTTP 등은 전혀 모른다.
// api/run-seating.js가 학생 데이터를 읽어서 이 파일의 runOptimizer()에 넘긴다.
// ──────────────────────────────────────────────────────────────────────────

function shuf(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * grid: [{type:'seat'|'aisle', aircon:bool}, ...] row-major, 길이 rows*cols
 * 반환: 좌석 컨텍스트 (좌석 인덱스, 행/열, 인접관계 계산에 쓰는 헬퍼)
 */
function buildCtx(grid, rows, cols) {
  const seatIdx = [];
  grid.forEach((c, i) => {
    if (c.type === 'seat') seatIdx.push(String(i));
  });
  const rc = (k) => {
    const i = Number(k);
    return { r: Math.floor(i / cols), c: i % cols };
  };
  const isAdjacent = (k1, k2) => {
    const a = rc(k1);
    const b = rc(k2);
    return Math.abs(a.r - b.r) <= 1 && Math.abs(a.c - b.c) <= 1 && k1 !== k2;
  };
  // 좌석map(sm): 학생 배치 딕셔너리에서 실제 존재하는 좌석 키인지 확인용
  const sm = {};
  seatIdx.forEach((k) => (sm[k] = true));

  // 인접한 좌석 쌍을 미리 한 번만 계산해둔다 (좌석 배치도는 바뀌지 않으므로).
  // sc()가 22,000번 반복 호출되는데, 매번 O(n^2)로 쌍을 다시 찾지 않도록 여기서 캐시.
  const adjacentSeatPairs = [];
  for (let i = 0; i < seatIdx.length; i++) {
    for (let j = i + 1; j < seatIdx.length; j++) {
      if (isAdjacent(seatIdx[i], seatIdx[j])) adjacentSeatPairs.push([seatIdx[i], seatIdx[j]]);
    }
  }

  return { grid, rows, cols, seatIdx, rc, isAdjacent, sm, adjacentSeatPairs };
}

/**
 * 필수 제약(고정석, 시력)을 최대한 만족하는 랜덤 초기 배치를 만든다.
 * 반환: { [seatKey]: studentId }
 */
function buildValid(sts, con, ctx) {
  const a = {};
  const used = new Set();

  // 1) 고정석(fixedSeats) 먼저 배치: { seatKey: studentId }
  Object.entries(con.fixedSeats || {}).forEach(([s, k]) => {
    if (ctx.sm[s] && !used.has(s)) {
      a[s] = k;
      used.add(s);
    }
  });

  const fixedStudentIds = new Set(Object.values(con.fixedSeats || {}));
  const remainingStudents = sts.filter((s) => !fixedStudentIds.has(s.id));
  const emptySeats = ctx.seatIdx.filter((k) => !used.has(k));

  // 앞줄 정의: 존재하는 행 번호 중 가장 작은 값들 (교실 앞쪽)
  const rowsPresent = [...new Set(emptySeats.map((k) => ctx.rc(k).r))].sort((x, y) => x - y);
  const frontRows = new Set(rowsPresent.slice(0, Math.max(1, Math.ceil(rowsPresent.length / 3))));
  const frontSeats = shuf(emptySeats.filter((k) => frontRows.has(ctx.rc(k).r)));

  // 2) 시력 나쁜 학생(eyesight가 낮을수록 잘 안 보인다고 가정, 1~2를 "나쁨"으로 취급) → 앞자리 우선
  const eyeSensitive = shuf(remainingStudents.filter((s) => Number(s.eyesight) > 0 && Number(s.eyesight) <= 2));
  const usedFront = new Set();
  eyeSensitive.forEach((s, i) => {
    const seat = frontSeats.find((k) => !usedFront.has(k) && !used.has(k));
    if (seat) {
      a[seat] = s.id;
      used.add(seat);
      usedFront.add(seat);
    }
  });

  // 3) 나머지는 랜덤 배치
  const placedIds = new Set(Object.values(a));
  const rest = shuf(remainingStudents.filter((s) => !placedIds.has(s.id)));
  const freeSeats = shuf(ctx.seatIdx.filter((k) => !used.has(k)));
  rest.forEach((s, i) => {
    if (freeSeats[i]) {
      a[freeSeats[i]] = s.id;
      used.add(freeSeats[i]);
    }
  });

  return a;
}

/**
 * 필수(하드) 제약 위반 여부 검사. true를 반환하면 이 배치는 무효.
 * a: { seatKey: studentId }, con: constraints
 */
function vH(a, con, ctx) {
  const seatOf = {};
  Object.entries(a).forEach(([seat, id]) => (seatOf[id] = seat));

  for (const [x, y] of con.blacklist || []) {
    const sx = seatOf[x];
    const sy = seatOf[y];
    if (sx && sy && ctx.isAdjacent(sx, sy)) return true;
  }
  for (const [x, y] of con.whitelist || []) {
    const sx = seatOf[x];
    const sy = seatOf[y];
    if (sx && sy && !ctx.isAdjacent(sx, sy)) return true;
  }
  return false;
}

/**
 * 배치 하나에 대한 점수(목적함수)를 계산한다. 클수록 좋은 배치.
 * 반환: { total, breakdown }
 */
function sc(a, sts, con, w, ctx) {
  const byId = {};
  sts.forEach((s) => (byId[s.id] = s));
  const seatOf = {};
  Object.entries(a).forEach(([seat, id]) => (seatOf[id] = seat));

  const breakdown = {
    location: 0,
    aircon: 0,
    mates: 0,
    personality: 0,
    grade: 0,
    height: 0,
    avoid: 0,
    activity: 0,
  };

  const seatEntries = Object.entries(a); // [seatKey, studentId]

  // 선호 위치(앞/중간/뒤) 일치
  const rowsPresent = [...new Set(ctx.seatIdx.map((k) => ctx.rc(k).r))].sort((x, y) => x - y);
  const third = Math.max(1, Math.ceil(rowsPresent.length / 3));
  const frontRows = new Set(rowsPresent.slice(0, third));
  const backRows = new Set(rowsPresent.slice(-third));

  for (const [seat, id] of seatEntries) {
    const s = byId[id];
    if (!s || !s.preferredLocation) continue;
    const r = ctx.rc(seat).r;
    const zone = frontRows.has(r) ? 'front' : backRows.has(r) ? 'back' : 'middle';
    if (s.preferredLocation === zone) breakdown.location += w.location || 0;
  }

  // 에어컨 선호 일치
  for (const [seat, id] of seatEntries) {
    const s = byId[id];
    if (!s || !s.aircon) continue;
    const cell = ctx.grid[Number(seat)];
    const hasAc = !!cell.aircon;
    if ((s.aircon === 'near' && hasAc) || (s.aircon === 'far' && !hasAc)) {
      breakdown.aircon += w.aircon || 0;
    }
  }

  // 선호 짝꿍 인접 (1지망 4배, 2지망 2배, 3지망 1배) + 기피 짝꿍 인접 (선호 가중치의 2배 감점)
  const mateW = w.mates || 0;
  for (const s of sts) {
    const mySeat = seatOf[s.id];
    if (!mySeat) continue;
    (s.preferredMates || []).forEach((mateId, rank) => {
      const mateSeat = seatOf[mateId];
      if (mateSeat && ctx.isAdjacent(mySeat, mateSeat)) {
        const mult = rank === 0 ? 4 : rank === 1 ? 2 : 1;
        breakdown.mates += mateW * mult;
      }
    });
    if (s.avoidedMate) {
      const avoidSeat = seatOf[s.avoidedMate];
      if (avoidSeat && ctx.isAdjacent(mySeat, avoidSeat)) {
        breakdown.avoid -= mateW * 2;
      }
    }
  }

  // 성격 균형: 인접한 좌석끼리 MBTI의 E/I가 다르면 가점
  const personalityW = w.personality || 0;
  if (personalityW) {
    for (const [seatA, seatB] of ctx.adjacentSeatPairs) {
      const s1 = byId[a[seatA]];
      const s2 = byId[a[seatB]];
      if (!s1 || !s2 || !s1.mbti || !s2.mbti) continue;
      const ei1 = s1.mbti[0];
      const ei2 = s2.mbti[0];
      if (ei1 && ei2 && ei1 !== ei2) breakdown.personality += personalityW;
    }
  }

  // 성적 균형: 분단(열)별 평균 성적이 전체 평균과 비슷할수록 가점
  const gradeW = w.grade || 0;
  if (gradeW) {
    const allGrades = sts.map((s) => Number(s.grade)).filter((g) => !isNaN(g));
    if (allGrades.length) {
      const overallAvg = allGrades.reduce((x, y) => x + y, 0) / allGrades.length;
      const byCol = {};
      for (const [seat, id] of seatEntries) {
        const s = byId[id];
        if (!s || isNaN(Number(s.grade))) continue;
        const c = ctx.rc(seat).c;
        (byCol[c] = byCol[c] || []).push(Number(s.grade));
      }
      Object.values(byCol).forEach((arr) => {
        if (!arr.length) return;
        const avg = arr.reduce((x, y) => x + y, 0) / arr.length;
        const diff = Math.abs(avg - overallAvg);
        breakdown.grade += gradeW * Math.max(0, 1 - diff / (overallAvg || 1));
      });
    }
  }

  // 키 순서: 뒷줄이 앞줄보다 크면 가점, 작으면 감점 (같은 열 기준 비교)
  const heightW = w.height || 0;
  if (heightW) {
    const byColRow = {};
    for (const [seat, id] of seatEntries) {
      const s = byId[id];
      if (!s || isNaN(Number(s.height))) continue;
      const { r, c } = ctx.rc(seat);
      byColRow[c] = byColRow[c] || {};
      byColRow[c][r] = Number(s.height);
    }
    Object.values(byColRow).forEach((rowsMap) => {
      const rowNums = Object.keys(rowsMap).map(Number).sort((x, y) => x - y);
      for (let i = 0; i < rowNums.length - 1; i++) {
        const front = rowsMap[rowNums[i]];
        const back = rowsMap[rowNums[i + 1]];
        breakdown.height += back >= front ? heightW : -heightW;
      }
    });
  }

  // 활동성 높은 학생끼리 인접하면 감점 (분산 목적)
  const activityW = w.activity || 0;
  if (activityW) {
    for (const [seatA, seatB] of ctx.adjacentSeatPairs) {
      const s1 = byId[a[seatA]];
      const s2 = byId[a[seatB]];
      if (!s1 || !s2 || !s1.activity || !s2.activity) continue;
      if (Number(s1.activity) >= 4 && Number(s2.activity) >= 4) {
        breakdown.activity -= activityW;
      }
    }
  }

  const total = Object.values(breakdown).reduce((x, y) => x + y, 0);
  return { total, breakdown };
}

/**
 * 시뮬레이티드 어닐링 메인 루프.
 * params: { students, constraints, weights, ctx, rows, cols }
 * 반환: { grid: [{type,aircon,number,name}], score, breakdown }
 */
function runOptimizer({ students, constraints, weights, ctx, rows, cols }) {
  const con = constraints || {};
  const w = weights || {};

  let cur = buildValid(students, con, ctx);
  let tries = 0;
  while (vH(cur, con, ctx) && tries < 200) {
    cur = buildValid(students, con, ctx);
    tries++;
  }

  let curScore = sc(cur, students, con, w, ctx);
  let cs = curScore.total;
  let best = { ...cur };
  let bs = cs;

  const T0 = 80;
  const Tm = 0.5;
  const steps = 22000;
  const al = Math.pow(Tm / T0, 1 / steps);
  let T = T0;

  const seatKeys = Object.keys(cur);

  for (let i = 0; i < steps; i++) {
    T *= al;

    // 임의의 두 학생 좌석을 스왑
    const i1 = Math.floor(Math.random() * seatKeys.length);
    let i2 = Math.floor(Math.random() * seatKeys.length);
    if (i1 === i2) continue;
    const k1 = seatKeys[i1];
    const k2 = seatKeys[i2];

    const next = { ...cur, [k1]: cur[k2], [k2]: cur[k1] };
    if (vH(next, con, ctx)) continue; // 하드 제약 위반이면 스왑 시도 자체를 건너뜀

    const ns = sc(next, students, con, w, ctx).total;
    const d = ns - cs;

    if (d > 0 || Math.random() < Math.exp(d / T)) {
      cur = next;
      cs = ns;
      if (cs > bs) {
        best = { ...cur };
        bs = cs;
      }
    }
  }

  const byId = {};
  students.forEach((s) => (byId[s.id] = s));

  const safeGrid = ctx.grid.map((cell, i) => {
    if (cell.type !== 'seat') return { type: cell.type, aircon: !!cell.aircon };
    const studentId = best[String(i)];
    const s = studentId ? byId[studentId] : null;
    return {
      type: 'seat',
      aircon: !!cell.aircon,
      number: s ? s.number : null,
      name: s ? s.name : null,
    };
  });

  const finalScore = sc(best, students, con, w, ctx);

  return {
    rows,
    cols,
    grid: safeGrid,
    score: finalScore.total,
    breakdown: finalScore.breakdown,
  };
}

module.exports = { buildCtx, buildValid, vH, sc, runOptimizer };
