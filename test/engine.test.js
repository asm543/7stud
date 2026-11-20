/**
 * 엔진 검증 스크립트
 * 1) 족보 평가 단위 테스트
 * 2) AI 7명끼리 다수의 대회를 돌려 칩 보존, 베팅 매칭, 레이즈 캡, 종료 여부를 확인
 */
const Stud = require('../public/engine.js');
const { evaluate, evaluateShowing, describeScore, scoreCategory, Tournament, PERSONAS, makeRng } = Stud;

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
 * AI만으로 대회를 한 번 돌리고 통계를 돌려준다.
 * @param {number} seed 시드
 * @param {number} handsPerLevel 레벨업 간격
 * @returns {Promise<object>} 통계
 */
async function runOne(seed, handsPerLevel) {
  const rng = makeRng(seed);
  const stats = { hands: 0, showdowns: 0, maxRaises: 0, sidePots: 0, splits: 0, thirdFolds: 0, thirdActs: 0 };
  const players = [{ name: 'Hero', persona: PERSONAS[2] }].concat(PERSONAS.map(p => ({ name: p.name, persona: p })));
  const total = players.length * 10000;
  const ctl = {
    onEvent(type, data, t) {
      const sum = t.players.reduce((a, p) => a + p.stack + p.contrib, 0);
      if (type !== 'handEnd' && type !== 'tournamentEnd' && type !== 'start') {
        assert(sum === total || t.hand.done, `chip mismatch ${sum} at ${type}`);
      }
      if (type === 'settle') {
        const after = t.players.reduce((a, p) => a + p.stack, 0);
        assert(after === total, `after settle ${after}`);
        stats.hands++;
        if (t.hand.showdown) stats.showdowns++;
        if (t.hand.pots.length > 1) stats.sidePots++;
        if (t.hand.pots.some(pt => pt.winners.length > 1)) stats.splits++;
      }
      if (type === 'action') {
        assert(t.hand.raises <= 4, 'raise cap exceeded');
        stats.maxRaises = Math.max(stats.maxRaises, t.hand.raises);
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
  stats.winner = winners[0].name;
  stats.totalHands = t.handNo;
  return stats;
}

(async () => {
  const N = Number(process.argv[2] || 120);
  const agg = { hands: 0, showdowns: 0, sidePots: 0, splits: 0, thirdFolds: 0, thirdActs: 0, maxRaises: 0, wins: {}, lengths: [] };
  const t0 = Date.now();
  for (let i = 0; i < N; i++) {
    const s = await runOne(1000 + i, i % 2 ? 4 : 6);
    ['hands', 'showdowns', 'sidePots', 'splits', 'thirdFolds', 'thirdActs'].forEach(k => { agg[k] += s[k]; });
    agg.maxRaises = Math.max(agg.maxRaises, s.maxRaises);
    agg.wins[s.winner] = (agg.wins[s.winner] || 0) + 1;
    agg.lengths.push(s.totalHands);
  }
  agg.lengths.sort((a, b) => a - b);
  console.log(`tournaments: ${N} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`hands/tournament median ${agg.lengths[N >> 1]} (min ${agg.lengths[0]}, max ${agg.lengths[N - 1]})`);
  console.log(`showdown rate ${(agg.showdowns / agg.hands * 100).toFixed(1)}%  side-pot hands ${agg.sidePots}  split pots ${agg.splits}  max raise level ${agg.maxRaises}`);
  console.log(`3rd street fold rate ${(agg.thirdFolds / agg.thirdActs * 100).toFixed(1)}%`);
  console.log('wins by player', agg.wins);
})().catch(e => { console.error(e); process.exit(1); });
