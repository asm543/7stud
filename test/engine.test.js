/**
 * 엔진 검증 스크립트
 * 1) 족보 평가 단위 테스트
 * 2) AI 7명끼리 다수의 대회를 돌려 칩 보존, 베팅 매칭, 레이즈 캡, 종료 여부를 확인
 */
const Stud = require('../public/engine.js');
const { evaluate, evaluateShowing, describeScore, scoreCategory, Tournament, STYLES, AI_NAMES, pickAiPlayers, makeRng, shuffle } = Stud;

const LEGACY = {
  rock: [1.45, 2.1, 0.35, 0.02, 0.06, 0.0, 0.2], weakTight: [1.15, 1.95, 0.3, 0.02, 0.1, 0.0, 0.38],
  tag: [1.3, 1.7, 0.62, 0.08, 0.35, 0.02, 0.14, 0.25], solid: [1.25, 1.65, 0.55, 0.1, 0.4, 0.08, 0.14, 0.3, 0.15],
  lag: [1.1, 1.45, 0.75, 0.18, 0.6, 0.05, 0.08, 0.45], maniac: [0.8, 1.15, 0.9, 0.32, 0.85, 0.12, 0.03, 0.6],
  station: [1.0, 2.3, 0.2, 0.03, 0.05, 0.35, 0.04, 0, 0, 0.5], fish: [1.0, 1.95, 0.3, 0.06, 0.15, 0.2, 0.08, 0, 0, 0.75],
  trapper: [1.25, 1.6, 0.7, 0.05, 0.25, 0.1, 0.12, 0, 0.7], thief: [1.4, 1.75, 0.5, 0.08, 0.9, 0.0, 0.22]
};

/**
 * 이전 버전 컴퓨터(손읽기·적응·사람 같은 상태 없음)의 스타일 값을 만든다. 비교 테스트용.
 * @param {string} id 스타일 id
 * @returns {object} legacy 스타일
 */
function legacyStyle(id) {
  const v = LEGACY[id];
  return { id: 'old-' + id, legacy: true, enter: v[0], raise: v[1], aggr: v[2], bluff: v[3], steal: v[4], sticky: v[5], respect: v[6], semibluff: v[7] || 0, slowplay: v[8] || 0, chase: v[9] || 0, talk: 0 };
}

/**
 * "As Kd 10h" 형식 문자열을 카드 정수 배열로 바꾼다.
 * @param {string} s 카드 문자열
 * @returns {number[]} 카드 정수 배열
 */
function parse(s) {
  const R = { '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, J: 11, Q: 12, K: 13, A: 14 };
  const S = { c: 0, d: 1, h: 2, s: 3 };
  return s.split(' ').map(t => R[t.slice(0, -1)] * 4 + S[t.slice(-1)]);
}

/**
 * 조건이 거짓이면 예외를 던진다.
 * @param {boolean} cond 조건
 * @param {string} msg 메시지
 * @returns {void}
 */
function assert(cond, msg) {
  if (!cond) throw new Error('ASSERT: ' + msg);
}

const cases = [
  ['Ah Kh Qh Jh 10h 2c 3d', 8, '로열 스트레이트 플러시'],
  ['5s 4s 3s 2s As Kd Kc', 8, '5 하이 스트레이트 플러시'],
  ['9c 9d 9h 9s Kd 2c 3c', 7, '9 포카드'],
  ['Qc Qd Qh 7s 7d 7c 2h', 6, '풀하우스 (Q 트리플 + 7 페어)'],
  ['Ad Jd 8d 4d 2d Kc Ks', 5, 'A 하이 플러시'],
  ['As 2d 3c 4h 5s Kd Qd', 4, '5 하이 스트레이트'],
  ['10s Jd Qc Kh As 2d 3c', 4, 'A 하이 스트레이트'],
  ['8s 8d 8c Ah 3s 2d 5c', 3, '8 트리플'],
  ['Js Jd 4c 4h 2s 2d Ac', 2, 'J·4 투페어'],
  ['Js Jd 7c 4h 2s 9d Ac', 1, 'J 원페어'],
  ['Ks Jd 7c 4h 2s 9d 3c', 0, 'K 하이']
];
cases.forEach(([s, cat, desc]) => {
  const sc = evaluate(parse(s));
  assert(scoreCategory(sc) === cat, `${s} category ${scoreCategory(sc)} != ${cat}`);
  assert(describeScore(sc) === desc, `${s} desc "${describeScore(sc)}" != "${desc}"`);
});
assert(evaluate(parse('6s 5d 4c 3h 2s Kd Qd')) > evaluate(parse('As 2d 3c 4h 5s Kd Qd')), '6-high straight beats wheel');
assert(evaluate(parse('Js Jd 4c 4h As 2d 3c')) > evaluate(parse('Js Jd 4c 4h Ks 2d 3c')), 'two pair kicker');
assert(evaluate(parse('Js Jd 4c 4h 2s 2d 3c')) === evaluate(parse('Jc Jh 4d 4s 2c 2h 3d')), 'equal hands tie');
assert(evaluate(parse('Kc Kd Kh 2s 2d 2c 9h')) === evaluate(parse('Ks Kd Kh 2s 2d Qc 9h')), 'FH with two trips');
assert(evaluateShowing(parse('Ks Kd')) > evaluateShowing(parse('As Qd')), 'showing pair beats AQ');
assert(evaluateShowing(parse('5s 6s 7s 8s')) < evaluateShowing(parse('2c 2d 3h 4h')), 'no straight/flush on board');
console.log('evaluator: all', cases.length + 6, 'checks passed');

/**
 * AI만으로 대회를 한 번 돌리고 통계를 돌려준다. 10가지 스타일 중 7개를 무작위로 앉힌다.
 * 스타일별로 핸드 수, 3구 자발 참가(VPIP), 공격 액션·콜 수, 쇼다운 수, 우승을 집계한다.
 * @param {number} seed 시드
 * @param {number} handsPerLevel 레벨업 간격
 * @param {object} byStyle 스타일별 누적 통계 (갱신됨)
 * @returns {Promise<object>} 대회 통계
 */
async function runOne(seed, handsPerLevel, byStyle, mixed) {
  const rng = makeRng(seed);
  const stats = { hands: 0, showdowns: 0, maxRaises: 0, sidePots: 0, splits: 0, thirdFolds: 0, thirdActs: 0, aiHands: 0, tilted: 0, geared: 0, imaged: 0, committed: 0, talks: 0 };
  let players = pickAiPlayers(7, rng);
  if (mixed) {
    const old = shuffle(STYLES.slice(), rng).slice(0, 3);
    players = players.slice(0, 4).concat(old.map((st, i) => ({ name: 'Old' + i, persona: legacyStyle(st.id) })));
  }
  const total = players.length * 10000;
  const vol = new Set();
  const ensure = id => (byStyle[id] = byStyle[id] || { entries: 0, wins: 0, hands: 0, vpip: 0, agg: 0, calls: 0, showdowns: 0, itm: 0 });
  players.forEach(p => { ensure(p.persona.id).entries++; });
  const ctl = {
    onEvent(type, data, t) {
      const sum = t.players.reduce((a, p) => a + p.stack + p.contrib, 0);
      if (type !== 'handEnd' && type !== 'tournamentEnd' && type !== 'start') {
        assert(sum === total || t.hand.done, `chip mismatch ${sum} at ${type}`);
      }
      if (type === 'talk') stats.talks++;
      if (type === 'deal' && t.hand.street === 3) {
        vol.clear();
        t.players.filter(p => p.inHand).forEach(p => {
          ensure(p.persona.id).hands++;
          if (!p.mind || p.persona.legacy) return;
          stats.aiHands++;
          if (p.mind.tilt > 0.3) stats.tilted++;
          if (p.mind.gear !== 0) stats.geared++;
          if (p.mind.image < -0.3) stats.imaged++;
          if (Stud.effectiveStyle(t, p).commit) stats.committed++;
        });
      }
      if (type === 'settle') {
        const after = t.players.reduce((a, p) => a + p.stack, 0);
        assert(after === total, `after settle ${after}`);
        stats.hands++;
        if (t.hand.showdown) {
          stats.showdowns++;
          t.live().forEach(p => { ensure(p.persona.id).showdowns++; });
        }
        if (t.hand.pots.length > 1) stats.sidePots++;
        if (t.hand.pots.some(pt => pt.winners.length > 1)) stats.splits++;
        vol.forEach(id => { byStyle[id].vpip++; });
      }
      if (type === 'action') {
        assert(t.hand.raises <= 4, 'raise cap exceeded');
        stats.maxRaises = Math.max(stats.maxRaises, t.hand.raises);
        const st = ensure(data.persona.id);
        if (/^(Raise|Bet|Complete)/.test(data.lastAction)) st.agg++;
        if (/^Call/.test(data.lastAction)) st.calls++;
        if (t.hand.street === 3 && /^(Raise|Complete|Call)/.test(data.lastAction)) vol.add(data.persona.id);
        if (t.hand.street === 3 && data.seat !== t.hand.bringInSeat) {
          stats.thirdActs++;
          if (data.folded) stats.thirdFolds++;
        }
      }
      if (type === 'deal' && t.hand.street > 3) {
        t.live().forEach(p => assert(p.cards.length === t.hand.street, 'card count'));
      }
    },
    wait() { return Promise.resolve(); },
    afterHand() { return Promise.resolve(); },
    humanAction() { throw new Error('no human'); }
  };
  const t = new Tournament({ players, controller: ctl, handsPerLevel, rng, sims: 60 });
  const orig = t.bettingRound.bind(t);
  t.bettingRound = async street => {
    await orig(street);
    if (t.live().length > 1) {
      t.actors().forEach(p => assert(p.bet === t.hand.currentBet, `unmatched bet street ${street}: ${p.bet} vs ${t.hand.currentBet}`));
    }
  };
  await t.run();
  const winners = t.players.filter(p => p.place === 1);
  assert(winners.length === 1 && winners[0].stack === total, 'single winner holds all chips');
  const places = t.players.map(p => p.place).sort((a, b) => a - b).join(',');
  assert(places === '1,2,3,4,5,6,7', 'places ' + places);
  t.players.forEach(p => { if (p.place <= 3) byStyle[p.persona.id].itm++; });
  byStyle[winners[0].persona.id].wins++;
  stats.totalHands = t.handNo;
  return stats;
}

(async () => {
  const N = Number(process.argv[2] || 200);
  const mode = process.argv[3] || 'all';
  const agg = { hands: 0, showdowns: 0, sidePots: 0, splits: 0, thirdFolds: 0, thirdActs: 0, maxRaises: 0, lengths: [] };
  const byStyle = {};
  const t0 = Date.now();
  const dyn = { aiHands: 0, tilted: 0, geared: 0, imaged: 0, committed: 0, talks: 0 };
  if (mode === 'mixed' || mode === 'both') {
    const mixedStyle = {};
    let newWins = 0;
    let newItm = 0;
    let oldItm = 0;
    const M = Math.max(40, Math.floor(N / 2));
    for (let i = 0; i < M; i++) {
      await runOne(5000 + i, i % 2 ? 4 : 6, mixedStyle, true);
    }
    Object.keys(mixedStyle).forEach(id => {
      if (id.startsWith('old-')) oldItm += mixedStyle[id].itm;
      else {
        newWins += mixedStyle[id].wins;
        newItm += mixedStyle[id].itm;
      }
    });
    console.log(`mixed tables (4 new vs 3 old) x${M}: new win share ${(newWins / M * 100).toFixed(1)}% (fair 57.1%), new ITM share ${(newItm / (newItm + oldItm) * 100).toFixed(1)}%`);
    if (mode === 'mixed') return;
  }
  for (let i = 0; i < N; i++) {
    const s = await runOne(1000 + i, i % 2 ? 4 : 6, byStyle);
    Object.keys(dyn).forEach(k => { dyn[k] += s[k]; });
    ['hands', 'showdowns', 'sidePots', 'splits', 'thirdFolds', 'thirdActs'].forEach(k => { agg[k] += s[k]; });
    agg.maxRaises = Math.max(agg.maxRaises, s.maxRaises);
    agg.lengths.push(s.totalHands);
  }
  agg.lengths.sort((a, b) => a - b);
  console.log(`tournaments: ${N} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`hands/tournament median ${agg.lengths[N >> 1]} (min ${agg.lengths[0]}, max ${agg.lengths[N - 1]})`);
  console.log(`showdown rate ${(agg.showdowns / agg.hands * 100).toFixed(1)}%  side-pot hands ${agg.sidePots}  split pots ${agg.splits}  max raise level ${agg.maxRaises}`);
  console.log(`3rd street fold rate ${(agg.thirdFolds / agg.thirdActs * 100).toFixed(1)}%`);
  const pc = k => (dyn[k] / dyn.aiHands * 100).toFixed(1) + '%';
  console.log(`human-like states (share of AI hands): tilted ${pc('tilted')}, off-gear ${pc('geared')}, caught-bluff image ${pc('imaged')}, short-stack commit ${pc('committed')}; chat lines ${dyn.talks} (${(dyn.talks / agg.hands).toFixed(2)}/hand)`);
  console.log('style          entries  win%  itm%  vpip%  agg/call  sd/hand%');
  STYLES.forEach(st => {
    const b = byStyle[st.id];
    if (!b) return;
    assert(b.hands > 0, 'style never played: ' + st.id);
    const pct = (x, y) => (y ? (x / y * 100).toFixed(1) : '-').padStart(5);
    console.log(`${st.id.padEnd(12)} ${String(b.entries).padStart(7)} ${pct(b.wins, b.entries)} ${pct(b.itm, b.entries)} ${pct(b.vpip, b.hands)} ${(b.agg / Math.max(1, b.calls)).toFixed(2).padStart(8)} ${pct(b.showdowns, b.hands)}`);
  });
})().catch(e => { console.error(e); process.exit(1); });
