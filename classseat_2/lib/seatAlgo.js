// ──────────────────────────────────────────────────────────────────────────
// lib/seatAlgo.js
// 시뮬레이티드 어닐링 기반 좌석배치 최적화 알고리즘.
// 이 파일은 순수 함수만 다루고, Firestore/HTTP 등은 전혀 모른다.
// api/run-seating.js가 학생 데이터를 읽어서 이 파일의 runOptimizer()에 넘긴다.
//
// 제약 조건 형태 (알고리즘 내부, normalizeConstraints 이후):
//   blacklist : [[idA, idB], ...]           인접(8방향) 금지      — 하드 제약
//   whitelist : [[idA, idB], ...]           반드시 인접           — 하드 제약
//   separate  : [[idA, idB, level], ...]    떨어뜨리기             — 하드 제약
//               level = 'far' | 'farthest'  (체비셰프 거리 최소값은 sepMinDistance 참고)
//   fixedSeats: { seatKey: studentId }      고정석                — 하드 제약 (스왑 대상에서 제외)
// Firestore는 중첩 배열을 저장할 수 없어서 DB에는 [{a,b,level}] 형태로 저장하고,
// normalizeConstraints()가 두 형태를 모두 받아 위 형태로 바꿔준다.
// ──────────────────────────────────────────────────────────────────────────

const DEFAULT_SEAT_WEIGHT = 5;

// ── 떨어뜨리기(separate) 최소 거리 ─────────────────────────────────────────
// span = 좌석이 존재하는 영역의 가로/세로 폭 중 큰 값 (체비셰프 기준 "반 대각선 끝과 끝" 거리).
//   far      : span의 50% 이상 (최소 2칸)
//   farthest : span의 80% 이상 (최소 3칸)
// 예) 6열×5행 → span=5 → far ≥ 3칸, farthest ≥ 4칸.
// ※ public/index.html의 sepMin()과 같은 공식을 유지할 것 (선생님 화면 안내 문구용).
const SEPARATE_RATIO = { far: 0.5, farthest: 0.8 };
const SEPARATE_FLOOR = { far: 2, farthest: 3 };

function sepMinDistance(level, span) {
  if (span <= 0) return 0;
  const ratio = SEPARATE_RATIO[level] ?? SEPARATE_RATIO.far;
  const floor = SEPARATE_FLOOR[level] ?? SEPARATE_FLOOR.far;
  return Math.min(span, Math.max(Math.ceil(span * ratio), floor));
}

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
 * 반환: 좌석 컨텍스트 (좌석 인덱스, 행/열, 인접·거리 계산에 쓰는 헬퍼)
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

  // 좌석별 (행,열) 캐시 + 좌석 영역의 폭(span)
  const pos = {};
  let minR = Infinity, maxR = -Infinity, minC = Infinity, maxC = -Infinity;
  seatIdx.forEach((k) => {
    const p = rc(k);
    pos[k] = p;
    if (p.r < minR) minR = p.r;
    if (p.r > maxR) maxR = p.r;
    if (p.c < minC) minC = p.c;
    if (p.c > maxC) maxC = p.c;
  });
  const span = seatIdx.length ? Math.max(maxR - minR, maxC - minC) : 0;

  // 체비셰프 거리 = max(|Δ행|, |Δ열|)
  const cheb = (k1, k2) => {
    const a = pos[k1] || rc(k1);
    const b = pos[k2] || rc(k2);
    return Math.max(Math.abs(a.r - b.r), Math.abs(a.c - b.c));
  };
  const minDist = { far: sepMinDistance('far', span), farthest: sepMinDistance('farthest', span) };

  // 인접한 좌석 쌍을 미리 한 번만 계산해둔다 (좌석 배치도는 바뀌지 않으므로).
  // sc()가 22,000번 반복 호출되는데, 매번 O(n^2)로 쌍을 다시 찾지 않도록 여기서 캐시.
  const adjacentSeatPairs = [];
  for (let i = 0; i < seatIdx.length; i++) {
    for (let j = i + 1; j < seatIdx.length; j++) {
      if (isAdjacent(seatIdx[i], seatIdx[j])) adjacentSeatPairs.push([seatIdx[i], seatIdx[j]]);
    }
  }

  return { grid, rows, cols, seatIdx, rc, isAdjacent, sm, adjacentSeatPairs, pos, span, cheb, minDist };
}

/**
 * Firestore 저장 형태([{a,b,level}])와 알고리즘 형태([[a,b,level]])를 모두 받아
 * 알고리즘 형태로 통일한다. 학생 id는 항상 문자열.
 */
function normalizeConstraints(raw) {
  const r = raw || {};
  const pairOf = (p) => {
    if (Array.isArray(p)) return p.length >= 2 ? [String(p[0]), String(p[1]), p[2]] : null;
    if (p && p.a != null && p.b != null) return [String(p.a), String(p.b), p.level];
    return null;
  };
  const list = (x) => (Array.isArray(x) ? x : []).map(pairOf).filter(Boolean);
  const fixedSeats = {};
  Object.entries(r.fixedSeats || {}).forEach(([seat, id]) => {
    if (id != null && id !== '') fixedSeats[String(seat)] = String(id);
  });
  return {
    blacklist: list(r.blacklist).map(([a, b]) => [a, b]),
    whitelist: list(r.whitelist).map(([a, b]) => [a, b]),
    separate: list(r.separate).map(([a, b, level]) => [a, b, level === 'farthest' ? 'farthest' : 'far']),
    fixedSeats,
  };
}

/**
 * 고정석 중 실제로 적용 가능한 것만 골라낸다.
 * (존재하는 좌석 + 이번 배치 대상 학생 + 한 학생이 두 자리에 고정되는 일 없음)
 * 반환: { seatKey: studentId }
 */
function resolveFixed(sts, con, ctx) {
  const present = new Set(sts.map((s) => String(s.id)));
  const out = {};
  const usedStudents = new Set();
  Object.entries(con.fixedSeats || {}).forEach(([seat, id]) => {
    const sid = String(id);
    if (ctx.sm[seat] && present.has(sid) && !usedStudents.has(sid) && out[seat] === undefined) {
      out[seat] = sid;
      usedStudents.add(sid);
    }
  });
  return out;
}

/**
 * 필수 제약(고정석, 시력)을 최대한 만족하는 랜덤 초기 배치를 만든다.
 * 반환: { [seatKey]: studentId }
 */
function buildValid(sts, con, ctx) {
  const a = {};
  const used = new Set();

  // 1) 고정석(fixedSeats) 먼저 배치
  const fixed = resolveFixed(sts, con, ctx);
  Object.entries(fixed).forEach(([seat, id]) => {
    a[seat] = id;
    used.add(seat);
  });

  const fixedStudentIds = new Set(Object.values(fixed));
  const remainingStudents = sts.filter((s) => !fixedStudentIds.has(String(s.id)));
  const emptySeats = ctx.seatIdx.filter((k) => !used.has(k));

  // 앞줄 정의: 존재하는 행 번호 중 가장 작은 값들 (교실 앞쪽)
  const rowsPresent = [...new Set(emptySeats.map((k) => ctx.rc(k).r))].sort((x, y) => x - y);
  const frontRows = new Set(rowsPresent.slice(0, Math.max(1, Math.ceil(rowsPresent.length / 3))));
  const frontSeats = shuf(emptySeats.filter((k) => frontRows.has(ctx.rc(k).r)));

  // 2) 시력 나쁜 학생(eyesight가 낮을수록 잘 안 보인다고 가정, 1~2를 "나쁨"으로 취급) → 앞자리 우선
  const eyeSensitive = shuf(remainingStudents.filter((s) => Number(s.eyesight) > 0 && Number(s.eyesight) <= 2));
  const usedFront = new Set();
  eyeSensitive.forEach((s) => {
    const seat = frontSeats.find((k) => !usedFront.has(k) && !used.has(k));
    if (seat) {
      a[seat] = String(s.id);
      used.add(seat);
      usedFront.add(seat);
    }
  });

  // 3) 나머지는 랜덤 배치
  const placedIds = new Set(Object.values(a));
  const rest = shuf(remainingStudents.filter((s) => !placedIds.has(String(s.id))));
  const freeSeats = shuf(ctx.seatIdx.filter((k) => !used.has(k)));
  rest.forEach((s, i) => {
    if (freeSeats[i]) {
      a[freeSeats[i]] = String(s.id);
      used.add(freeSeats[i]);
    }
  });

  return a;
}

function seatMapOf(a) {
  const m = {};
  for (const seat in a) m[a[seat]] = seat;
  return m;
}

/**
 * 하드 제약(인접 금지 / 반드시 인접 / 떨어뜨리기) 위반 목록.
 * firstOnly=true면 첫 위반에서 바로 멈춘다 (vH용).
 */
function violations(a, con, ctx, firstOnly) {
  const out = [];
  const seatOf = seatMapOf(a);
  const push = (v) => {
    out.push(v);
    return !!firstOnly;
  };

  for (const [x, y] of con.blacklist || []) {
    const sx = seatOf[x];
    const sy = seatOf[y];
    if (sx !== undefined && sy !== undefined && ctx.isAdjacent(sx, sy) && push({ type: 'blacklist', x, y })) return out;
  }
  for (const [x, y] of con.whitelist || []) {
    const sx = seatOf[x];
    const sy = seatOf[y];
    if (sx !== undefined && sy !== undefined && !ctx.isAdjacent(sx, sy) && push({ type: 'whitelist', x, y })) return out;
  }
  for (const [x, y, level] of con.separate || []) {
    const sx = seatOf[x];
    const sy = seatOf[y];
    if (sx === undefined || sy === undefined) continue;
    const need = ctx.minDist[level] ?? ctx.minDist.far;
    const dist = ctx.cheb(sx, sy);
    if (dist < need && push({ type: 'separate', x, y, level, dist, need })) return out;
  }
  return out;
}

/**
 * 필수(하드) 제약 위반 여부 검사. true를 반환하면 이 배치는 무효.
 * a: { seatKey: studentId }, con: normalizeConstraints()를 거친 constraints
 */
function vH(a, con, ctx) {
  return violations(a, con, ctx, true).length > 0;
}

/** 사람이 읽을 수 있는 위반 설명 (고정석 위반 포함). 선생님 화면의 "확인 필요" 목록에 쓰인다. */
function describeViolations(a, con, ctx, byId, fixed) {
  const label = (id) => {
    const s = byId && byId[id];
    return s ? `${s.number ?? id}번 ${s.name ?? ''}`.trim() : `${id}번`;
  };
  const msgs = violations(a, con, ctx, false).map((v) => {
    if (v.type === 'blacklist') return `${label(v.x)} · ${label(v.y)}: 인접 금지 조건 위반`;
    if (v.type === 'whitelist') return `${label(v.x)} · ${label(v.y)}: 인접해야 하는 조건 위반`;
    const lv = v.level === 'farthest' ? '최대한 멀리' : '어느 정도';
    return `${label(v.x)} · ${label(v.y)}: 떨어뜨리기(${lv}) 조건 위반 — 현재 ${v.dist}칸, ${v.need}칸 이상 필요`;
  });
  Object.entries(fixed || {}).forEach(([seat, id]) => {
    if (a[seat] !== id) msgs.push(`${label(id)}: 고정석에 앉아 있지 않음`);
  });
  return msgs;
}

// "r,c" 형태의 preferredSeat → 현재 좌석표에서의 좌석 키. 유효하지 않으면 null.
function prefKeyOf(s, ctx) {
  if (s._pk !== undefined) return s._pk;
  let key = null;
  if (typeof s.preferredSeat === 'string') {
    const m = s.preferredSeat.match(/^(\d+),(\d+)$/);
    if (m) {
      const r = Number(m[1]);
      const c = Number(m[2]);
      if (r < ctx.rows && c < ctx.cols) {
        const k = String(r * ctx.cols + c);
        if (ctx.sm[k]) key = k;
      }
    }
  }
  s._pk = key;
  return key;
}

/**
 * 배치 하나에 대한 점수(목적함수)를 계산한다. 클수록 좋은 배치.
 * 반환: { total, breakdown }
 */
function sc(a, sts, con, w, ctx) {
  const byId = {};
  sts.forEach((s) => (byId[s.id] = s));

  const breakdown = {
    location: 0,
    seat: 0,
    aircon: 0,
    mates: 0,
    personality: 0,
    grade: 0,
    height: 0,
    avoid: 0,
    activity: 0,
  };

  const seatEntries = Object.entries(a); // [seatKey, studentId]
  const seatOf = {};
  seatEntries.forEach(([seat, id]) => (seatOf[id] = seat));

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

  // 선호 좌석(preferredSeat): 배정 좌석이 선호 좌석에 가까울수록 가점 (1칸 멀어질 때마다 절반으로 감쇠)
  const seatW = w.seat ?? DEFAULT_SEAT_WEIGHT;
  if (seatW) {
    for (const [seat, id] of seatEntries) {
      const s = byId[id];
      if (!s) continue;
      const pk = prefKeyOf(s, ctx);
      if (pk === null) continue;
      breakdown.seat += seatW * Math.pow(0.5, ctx.cheb(seat, pk));
    }
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
    if (mySeat === undefined) continue;
    (s.preferredMates || []).forEach((mateId, rank) => {
      const mateSeat = seatOf[mateId];
      if (mateSeat !== undefined && ctx.isAdjacent(mySeat, mateSeat)) {
        const mult = rank === 0 ? 4 : rank === 1 ? 2 : 1;
        breakdown.mates += mateW * mult;
      }
    });
    if (s.avoidedMate) {
      const avoidSeat = seatOf[s.avoidedMate];
      if (avoidSeat !== undefined && ctx.isAdjacent(mySeat, avoidSeat)) {
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

// 두 좌석의 내용을 맞바꾼 새 배치를 만든다 (빈 좌석도 허용: 빈 좌석 키는 객체에서 제거).
function swapSeats(cur, k1, k2) {
  const v1 = cur[k1];
  const v2 = cur[k2];
  if (v1 === undefined && v2 === undefined) return null;
  const next = { ...cur };
  if (v2 === undefined) delete next[k1];
  else next[k1] = v2;
  if (v1 === undefined) delete next[k2];
  else next[k2] = v1;
  return next;
}

// 초기 배치가 하드 제약을 어기면, 위반 수가 줄어드는 방향으로 무작위 스왑을 반복해 고쳐본다.
function repair(start, con, ctx, movable) {
  let cur = start;
  let cv = violations(cur, con, ctx, false).length;
  if (cv === 0 || movable.length < 2) return cur;
  for (let i = 0; i < 40000 && cv > 0; i++) {
    const k1 = movable[Math.floor(Math.random() * movable.length)];
    const k2 = movable[Math.floor(Math.random() * movable.length)];
    if (k1 === k2) continue;
    const next = swapSeats(cur, k1, k2);
    if (!next) continue;
    const nv = violations(next, con, ctx, false).length;
    if (nv <= cv) {
      cur = next;
      cv = nv;
    }
  }
  return cur;
}

/**
 * 시뮬레이티드 어닐링 메인 루프.
 * params: { students, constraints, weights, ctx, rows, cols }
 * 반환: { rows, cols, grid: [{type,aircon,number,name}], score, breakdown, warnings }
 */
function runOptimizer({ students, constraints, weights, ctx, rows, cols }) {
  const con = normalizeConstraints(constraints);
  const w = weights || {};

  const byId = {};
  students.forEach((s) => (byId[s.id] = s));

  // 고정석은 스왑 대상에서 제외 (움직이지 않음)
  const fixed = resolveFixed(students, con, ctx);
  const movable = ctx.seatIdx.filter((k) => fixed[k] === undefined);

  // 1) 하드 제약을 만족하는 초기 배치를 찾는다.
  let cur = buildValid(students, con, ctx);
  for (let t = 0; t < 50 && vH(cur, con, ctx); t++) cur = buildValid(students, con, ctx);
  if (vH(cur, con, ctx)) cur = repair(cur, con, ctx, movable);

  // 그래도 위반이 남으면(서로 모순되는 조건 등) 위반 수에 큰 벌점을 주는 모드로 전환하고 경고를 남긴다.
  const penalized = vH(cur, con, ctx);
  const PENALTY = 1000;
  const score = (a) => {
    const t = sc(a, students, con, w, ctx).total;
    return penalized ? t - PENALTY * violations(a, con, ctx, false).length : t;
  };

  let cs = score(cur);
  let best = { ...cur };
  let bs = cs;

  const T0 = 80;
  const Tm = 0.5;
  const steps = 22000;
  const al = Math.pow(Tm / T0, 1 / steps);
  let T = T0;

  if (movable.length >= 2) {
    for (let i = 0; i < steps; i++) {
      T *= al;

      // 임의의 두 (고정되지 않은) 좌석의 내용을 스왑. 빈 좌석과의 스왑도 허용.
      const k1 = movable[Math.floor(Math.random() * movable.length)];
      const k2 = movable[Math.floor(Math.random() * movable.length)];
      if (k1 === k2) continue;
      const next = swapSeats(cur, k1, k2);
      if (!next) continue;
      if (!penalized && vH(next, con, ctx)) continue; // 하드 제약 위반이면 스왑 시도 자체를 건너뜀

      const ns = score(next);
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
  }

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
    warnings: describeViolations(best, con, ctx, byId, fixed),
  };
}

/**
 * 이미 만들어진 좌석표(수동 조정 결과 등)의 점수와 제약 위반을 다시 계산한다.
 * grid: [{type, aircon, number, name}] — number(학생 번호 = 학생 문서 id)로 학생을 찾는다.
 */
function evaluateLayout({ grid, students, constraints, weights, ctx }) {
  const con = normalizeConstraints(constraints);
  const byId = {};
  students.forEach((s) => (byId[s.id] = s));
  const a = {};
  grid.forEach((cell, i) => {
    if (cell.type === 'seat' && cell.number != null && cell.number !== '') a[String(i)] = String(cell.number);
  });
  const { total, breakdown } = sc(a, students, con, weights || {}, ctx);
  const fixed = resolveFixed(students, con, ctx);
  return { score: total, breakdown, warnings: describeViolations(a, con, ctx, byId, fixed) };
}

module.exports = {
  buildCtx,
  buildValid,
  vH,
  sc,
  runOptimizer,
  evaluateLayout,
  normalizeConstraints,
  resolveFixed,
  sepMinDistance,
  DEFAULT_SEAT_WEIGHT,
};
