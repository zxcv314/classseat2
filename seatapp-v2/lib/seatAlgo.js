'use strict';
/**
 * 자리배치 알고리즘 (v1 클라이언트 버전에서 그대로 포팅)
 * 서버(Vercel 함수)에서 학생 원본 데이터를 읽어 이 모듈로 계산하고,
 * 최종 좌석 배정 결과만 리턴합니다. 학생 개별 응답 필드는 절대 클라이언트로
 * 내보내지 않는 것이 이 아키텍처의 핵심입니다 (run-seating.js 참고).
 */

const shuf = (a) => {
  const b = a.slice();
  for (let i = b.length - 1; i > 0; i--) {
    const j = 0 | (Math.random() * (i + 1));
    [b[i], b[j]] = [b[j], b[i]];
  }
  return b;
};

function buildValid(sts, con, ctx) {
  const a = {};
  Object.entries(con.fixedSeats || {}).forEach(([s, k]) => { if (ctx.sm[s]) a[s] = k; });
  const used = new Set(Object.values(a));
  let emp = ctx.allSeats.filter((k) => !used.has(k));
  const rem = sts.filter((s) => !a[s.id]);
  const eye = rem.filter((s) => s.eyesight);
  const fset = new Set(ctx.frontSeats);
  let fe = shuf(emp.filter((k) => fset.has(k)));
  if (fe.length < eye.length) fe = shuf(emp);
  shuf(eye).forEach((s, i) => { if (fe[i]) { a[s.id] = fe[i]; used.add(fe[i]); } });
  emp = shuf(emp.filter((k) => !used.has(k)));
  shuf(rem.filter((s) => !a[s.id])).forEach((s, i) => { if (emp[i]) a[s.id] = emp[i]; });
  return a;
}

function vH(a, con, ctx) {
  for (const [x, y] of con.blacklist || []) {
    const kx = a[x], ky = a[y]; if (!kx || !ky) continue;
    const [r1, c1] = kx.split('_').map(Number), [r2, c2] = ky.split('_').map(Number);
    if (Math.max(Math.abs(r1 - r2), Math.abs(c1 - c2)) <= 1) return true;
  }
  for (const [x, y] of con.whitelist || []) {
    const kx = a[x], ky = a[y]; if (!kx || !ky) return true;
    if (!ctx.pairs.some(([k1, k2]) => (k1 === kx && k2 === ky) || (k1 === ky && k2 === kx))) return true;
  }
  return false;
}

function mateRankW(i) { return i === 0 ? 4 : i === 1 ? 2 : 1; }

function sc(a, con, W, ctx, sts, rows, cols) {
  const bd = [], sat = {}; let tot = 0;
  Object.entries(a).forEach(([id, k]) => { sat[k] = id; });
  const acs = new Set(ctx.airconSeats);
  const gv = (g) => g === '상' ? 3 : g === '중' ? 2 : 1;
  let lm = 0, am = 0;
  sts.forEach((s) => {
    const k = a[s.id]; if (!k) return;
    const r = +k.split('_')[0];
    if (s.preferredLocation && s.preferredLocation !== '상관없음' && s.preferredLocation === ctx.bands[r]) lm++;
    if (s.aircon === '직빵' && acs.has(k)) am++;
    if (s.aircon === '피함' && !acs.has(k)) am++;
  });
  if (lm) { tot += lm * W.location; bd.push({ label: '선호 위치 (' + lm + '명)', pts: lm * W.location }); }
  if (am) { tot += am * W.location; bd.push({ label: '에어컨 선호 (' + am + '명)', pts: am * W.location }); }
  let mp = 0, mCount = 0;
  ctx.pairs.forEach(([k1, k2]) => {
    const x = sat[k1], y = sat[k2]; if (!x || !y) return;
    const sx = ctx.sm[x], sy = ctx.sm[y];
    if (sx.preferredMates) { const ix = sx.preferredMates.indexOf(y); if (ix > -1) { mp += mateRankW(ix) * W.mate; mCount++; } }
    if (sy.preferredMates) { const iy = sy.preferredMates.indexOf(x); if (iy > -1) { mp += mateRankW(iy) * W.mate; mCount++; } }
  });
  if (mCount) { tot += mp; bd.push({ label: '선호 짝꿍 (' + mCount + '건)', pts: mp }); }
  if (con.personalityBalance) {
    let pm = 0;
    ctx.pairs.forEach(([k1, k2]) => {
      const x = sat[k1], y = sat[k2]; if (!x || !y) return;
      const ex = ctx.sm[x].mbti && ctx.sm[x].mbti[0], ey = ctx.sm[y].mbti && ctx.sm[y].mbti[0];
      if (ex && ey && ex !== ey) pm++;
    });
    if (pm) { tot += pm * W.personality; bd.push({ label: '성격 균형 E·I (' + pm + '쌍)', pts: pm * W.personality }); }
  }
  if (con.gradeBalance && ctx.zones.length > 1) {
    const all = sts.map((s) => gv(s.grade));
    const avg = all.length ? all.reduce((a, b) => a + b, 0) / all.length : 0;
    let ok = 0;
    ctx.zones.forEach((zc) => {
      const vs = [];
      zc.forEach((c) => { for (let r = 0; r < rows; r++) { const sid = sat[r + '_' + c]; if (sid) vs.push(gv(ctx.sm[sid].grade)); } });
      if (vs.length && Math.abs(vs.reduce((a, b) => a + b, 0) / vs.length - avg) <= 0.6) ok++;
    });
    if (ok) { tot += ok * W.grade; bd.push({ label: '성적 균형 (' + ok + '분단)', pts: ok * W.grade }); }
  }
  {
    const rs = [...new Set(ctx.allSeats.map((k) => +k.split('_')[0]))].sort((a, b) => a - b);
    const hv = (h) => h === '상' ? 3 : h === '중' ? 2 : 1;
    let hp = 0;
    for (let i = 0; i < rs.length - 1; i++) {
      const rf = rs[i], rb = rs[i + 1];
      for (let c = 0; c < cols; c++) {
        const sf = sat[rf + '_' + c], sb = sat[rb + '_' + c];
        if (sf && sb) { const hf = hv(ctx.sm[sf].height || '중'), hb = hv(ctx.sm[sb].height || '중'); if (hb >= hf) hp += W.location; else hp -= W.location; }
      }
    }
    if (hp !== 0) { tot += hp; bd.push({ label: '키 순서', pts: hp }); }
  }
  let av = 0;
  ctx.pairs.forEach(([k1, k2]) => {
    const x = sat[k1], y = sat[k2]; if (!x || !y) return;
    const sx = ctx.sm[x], sy = ctx.sm[y];
    if ((sx.avoidedMate && sx.avoidedMate === y) || (sy.avoidedMate && sy.avoidedMate === x)) av++;
  });
  if (av) { const p = -av * (W.mate * 2); tot += p; bd.push({ label: '기피 짝꿍 인접 (' + av + '건)', pts: p }); }
  if ((con.lively || []).length > 1) {
    let pen = 0; const dl = con.distLevel || 3;
    for (let i = 0; i < con.lively.length; i++) for (let j = i + 1; j < con.lively.length; j++) {
      const kx = a[con.lively[i]], ky = a[con.lively[j]]; if (!kx || !ky) continue;
      const [r1, c1] = kx.split('_').map(Number), [r2, c2] = ky.split('_').map(Number);
      const d = Math.max(Math.abs(r1 - r2), Math.abs(c1 - c2));
      if (d <= 1) pen += dl * W.lively; else if (d === 2) pen += dl * W.lively / 2;
    }
    if (pen > 0) { tot -= pen; bd.push({ label: '활발 학생 밀집', pts: -pen }); }
  }
  if (con.activityBalance) {
    let ap = 0;
    const av2 = (x) => x === '높음' ? 3 : x === '중간' ? 2 : 1;
    ctx.pairs.forEach(([k1, k2]) => {
      const x = sat[k1], y = sat[k2]; if (!x || !y) return;
      if (av2(ctx.sm[x].activity || '중간') + av2(ctx.sm[y].activity || '중간') >= 5) ap += W.lively;
    });
    if (ap > 0) { tot -= ap; bd.push({ label: '활동성 과밀 짝꿍', pts: -ap }); }
  }
  return { total: tot, breakdown: bd };
}

/**
 * Simulated Annealing 최적화.
 * data: {students, constraints, weights, ctx, rows, cols}
 * students 항목 id는 학생 "번호"(문자열)를 사용합니다.
 */
function runOptimizer(data) {
  const { students, constraints, weights, ctx, rows, cols } = data;
  const W = JSON.parse(JSON.stringify(weights));
  let cur = buildValid(students, constraints, ctx);
  if (!cur) return null;
  for (let t = 0; t < 60 && vH(cur, constraints, ctx); t++) cur = buildValid(students, constraints, ctx);
  if (vH(cur, constraints, ctx)) return null;
  let cs = sc(cur, constraints, W, ctx, students, rows, cols).total;
  let best = { ...cur }, bs = cs;
  const fi = new Set(Object.keys(constraints.fixedSeats || {}));
  const free = students.filter((s) => !fi.has(s.id)).map((s) => s.id);
  const T0 = 80, Tm = 0.5, steps = 22000;
  const al = Math.pow(Tm / T0, 1 / steps);
  let T = T0;
  for (let i = 0; i < steps; i++) {
    T *= al;
    if (free.length < 2) break;
    const a1 = free[0 | (Math.random() * free.length)], a2 = free[0 | (Math.random() * free.length)];
    if (a1 === a2) continue;
    const k1 = cur[a1], k2 = cur[a2];
    cur[a1] = k2; cur[a2] = k1;
    if (vH(cur, constraints, ctx)) { cur[a1] = k1; cur[a2] = k2; continue; }
    const ns = sc(cur, constraints, W, ctx, students, rows, cols).total;
    const d = ns - cs;
    if (d > 0 || Math.random() < Math.exp(d / T)) cs = ns;
    else { cur[a1] = k1; cur[a2] = k2; }
    if (cs > bs) { best = { ...cur }; bs = cs; }
  }
  const f = sc(best, constraints, weights, ctx, students, rows, cols);
  return { assignment: best, score: f.total, breakdown: f.breakdown };
}

/* ── 그리드 유틸 (v1 Grd 모듈 포팅) ── */
function seatsOf(grid, rows, cols) {
  const o = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (grid[r * cols + c].type === 'seat') o.push(r + '_' + c);
  return o;
}
function pairsOf(grid, rows, cols) {
  const o = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols - 1; c++) {
    if (grid[r * cols + c].type === 'seat' && grid[r * cols + (c + 1)].type === 'seat') o.push([r + '_' + c, r + '_' + (c + 1)]);
  }
  return o;
}
function bandsOf(seats) {
  const rows = [...new Set(seats.map((k) => +k.split('_')[0]))].sort((a, b) => a - b);
  const n = rows.length, b = {};
  rows.forEach((r, i) => { const f = n ? i / n : 0; b[r] = f < 1 / 3 ? '앞' : f < 2 / 3 ? '중간' : '뒤'; });
  return b;
}
function frontKeysOf(grid, rows, cols, count) {
  if (count <= 0) return [];
  const all = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (grid[r * cols + c].type === 'seat') all.push({ r, c, k: r + '_' + c });
  const rs = [...new Set(all.map((s) => s.r))].sort((a, b) => a - b);
  let seen = 0, tr = -1;
  for (const r of rs) { seen += all.filter((s) => s.r === r).length; tr = r; if (seen >= count) break; }
  return all.filter((s) => s.r <= tr).map((s) => s.k);
}
function zonesOf(grid, rows, cols) {
  const div = new Set();
  for (let c = 0; c < cols; c++) { let all = true; for (let r = 0; r < rows; r++) if (grid[r * cols + c].type !== 'aisle') { all = false; break; } if (all) div.add(c); }
  const res = []; let cur = [];
  for (let c = 0; c < cols; c++) { if (div.has(c)) { if (cur.length) { res.push(cur); cur = []; } } else cur.push(c); }
  if (cur.length) res.push(cur);
  return res;
}
function buildCtx(grid, rows, cols, students) {
  const sm = {}; students.forEach((s) => { sm[s.id] = s; });
  const eyeC = students.filter((s) => s.eyesight).length;
  const seats = seatsOf(grid, rows, cols);
  const airconSeats = seats.filter((k) => { const [r, c] = k.split('_').map(Number); return grid[r * cols + c].aircon; });
  return {
    allSeats: seats,
    pairs: pairsOf(grid, rows, cols),
    zones: zonesOf(grid, rows, cols),
    bands: bandsOf(seats),
    frontSeats: frontKeysOf(grid, rows, cols, eyeC),
    airconSeats,
    sm,
  };
}

module.exports = { runOptimizer, buildCtx, mateRankW };
