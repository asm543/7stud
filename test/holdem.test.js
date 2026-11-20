'use strict';

/**
 * 노리밋 홀덤 엔진 테스트
 *  1) 룰 단위 테스트: 빅블라인드 앤티(빅블라인드 우선), 최소 레이즈, 숏 올인 재오픈 금지와 누적 재오픈, 헤즈업 순서,
 *     데드 버튼, 앤티는 메인 팟, 콜 받지 못한 베트 반환, 남는 칩 순서, 짧은 빅블라인드와 스몰블라인드 반환
 *  2) 컴퓨터끼리 대회 시뮬레이션: 모든 액션이 가능한 액션 범위 안인지, 매 액션 칩 보존, 대회 종료,
 *     스타일별 우승·입상·VPIP·PFR·공격 비율·쇼다운 비율, 사람 같은 상태 지표, 판단 시간
 *  3) 기준 봇 비교: 단순한 "ABC" 타이트 봇과 섞어서 컴퓨터 우승 점유율
 *  4) 공략 봇 비교: 매 핸드 올인·무조건 콜·항상 최소 레이즈 봇 1명 + 컴퓨터 8명에서 봇의 우승·입상률
 * 사용법: node test/holdem.test.js [대회 수=60] [all|mixed|exploit|both]
 */
const H = require('../public/holdem.js');
const Stud = require('../public/engine.js');

let checks = 0;

/**
 * 조건이 거짓이면 예외를 던진다.
 * @param {boolean} cond 조건
 * @param {string} msg 메시지
 * @returns {void}
 */
function assert(cond, msg) {
  checks++;
  if (!cond) throw new Error('ASSERT: ' + msg);
}

/**
 * "As", "Td" 같은 표기를 카드 정수로 바꾼다 (무늬 c d h s = 0 1 2 3).
 * @param {string} s 카드 표기
 * @returns {number} 카드 정수
 */
function card(s) {
  const r = '23456789TJQKA'.indexOf(s[0]) + 2;
  const u = 'cdhs'.indexOf(s[1]);
  return r * 4 + u;
}

/**
 * 원하는 홀카드·보드가 나오도록 덱을 만든다 (엔진은 pop으로 딜).
 * @param {string[][]} holes 딜 순서(버튼 다음 사람부터)대로의 홀카드 표기
 * @param {string[]} board 보드 5장 표기
 * @returns {number[]} 덱
 */
function rig(holes, board) {
  const seq = [];
  holes.forEach(hc => seq.push(card(hc[0])));
  holes.forEach(hc => seq.push(card(hc[1])));
  const b = board.map(card);
  const used = new Set(seq.concat(b));
  const spare = [];
  for (let c = 8; c < 60; c++) if (!used.has(c)) spare.push(c);
  seq.push(spare.pop(), b[0], b[1], b[2], spare.pop(), b[3], spare.pop(), b[4]);
  return spare.concat(seq.reverse());
}

/**
 * 사람만 있는 테이블을 좌석 1..n 고정으로 만든다. 사람 액션은 script 함수가 정한다.
 * @param {number[]} stacks 좌석 순 시작 스택
 * @param {function(object, object[], object): object} script (플레이어, 가능한 액션, 토너먼트) → 액션
 * @param {object} [extra] 추가 설정 (deck, prevBB, prevSB, level)
 * @returns {object} 토너먼트
 */
function table(stacks, script, extra) {
  const ex = extra || {};
  const t = new H.Tournament({
    players: stacks.map((_, i) => ({ name: `P${i + 1}`, isHuman: true })),
    controller: {
      wait: async () => {},
      humanAction: async (p, legal, tt) => script(p, legal, tt),
      afterHand: async () => {}
    },
    rng: Stud.makeRng(7),
    deckFactory: ex.deck ? () => ex.deck.slice() : null
  });
  t.players.forEach((p, i) => { p.seat = i + 1; });
  t.players.sort((a, b) => a.seat - b.seat);
  t.players.forEach((p, i) => { p.stack = stacks[i]; });
  t.handNo = 1;
  if (ex.prevBB !== undefined) {
    t.prevBB = ex.prevBB;
    t.prevSB = ex.prevSB;
  }
  return t;
}

/**
 * 좌석 번호로 플레이어를 찾는다.
 * @param {object} t 토너먼트
 * @param {number} seat 좌석
 * @returns {object} 플레이어
 */
function at(t, seat) {
  return t.players.find(p => p.seat === seat);
}

/**
 * 순서대로 액션을 내는 스크립트를 만든다. 각 항목은 [좌석, 액션 종류, 금액?]이고, 다 쓰면 체크/콜.
 * 실제로 받은 가능한 액션 목록을 seen에 기록한다.
 * @param {Array} steps 액션 목록
 * @param {object[]} seen 기록용 배열
 * @returns {function} 스크립트
 */
function scripted(steps, seen) {
  return (p, legal) => {
    seen.push({ seat: p.seat, legal });
    const step = steps.shift();
    if (!step) return legal.find(a => a.type === 'check') || legal.find(a => a.type === 'call');
    if (step[0] !== p.seat) throw new Error(`expected seat ${step[0]} to act, got ${p.seat}`);
    const a = legal.find(x => x.type === step[1]);
    if (!a) throw new Error(`seat ${p.seat}: ${step[1]} not legal (${legal.map(x => x.type).join(',')})`);
    return step[2] !== undefined ? Object.assign({}, a, { to: step[2] }) : a;
  };
}

/**
 * 룰 단위 테스트를 모두 실행한다.
 * @returns {Promise<void>} 완료 Promise
 */
async function ruleTests() {
  {
    const seen = [];
    const t = table([20000, 20000, 300], scripted([[1, 'fold'], [2, 'fold']], seen), { prevBB: 2, prevSB: 1 });
    await t.playHand();
    const h = t.hand;
    assert(h.buttonSeat === 1 && h.sbSeat === 2 && h.bbSeat === 3, 'positions from prev blinds');
    assert(at(t, 3).antePaid === 100 && h.dead === 100, 'BB posts blind first, then ante with the rest');
    assert(at(t, 3).stack === 300 + 100, 'short-ante BB wins the SB 100');
  }
  {
    const seen = [];
    const t = table([20000, 20000, 50], scripted([[1, 'fold'], [2, 'fold']], seen), { prevBB: 2, prevSB: 1 });
    await t.playHand();
    assert(t.hand.currentBet === 200, 'short BB still makes full BB the bet to call');
    assert(seen[1].legal.find(a => a.type === 'call').amount === 100, 'SB must call up to the full BB');
    assert(at(t, 2).stack === 20000 - 50, 'SB gets back the part the short BB could not match');
    assert(at(t, 3).stack === 100, 'short BB wins 50 + 50');
  }
  {
    const seen = [];
    const t = table([20000, 20000, 20000, 20000], scripted([[4, 'raise', 600], [1, 'raise', 1500], [2, 'fold'], [3, 'fold'], [4, 'fold']], seen), { prevBB: 2, prevSB: 1 });
    await t.playHand();
    const r1 = seen.find(x => x.seat === 1).legal.find(a => a.type === 'raise');
    assert(r1.min === 1000, `min reraise = 600 + 400 (got ${r1.min})`);
    const r4 = seen.filter(x => x.seat === 4)[1].legal.find(a => a.type === 'raise');
    assert(r4.min === 2400, `min raise after 900 raise = 1500 + 900 (got ${r4.min})`);
    assert(at(t, 1).stack === 20000 + 600 + 100 + 200 + 200, 'uncalled 900 returned, winner gets the rest');
  }
  {
    const seen = [];
    const t = table([20000, 900, 20000, 20000], scripted([[4, 'raise', 600], [1, 'call'], [2, 'raise', 900], [3, 'fold']], seen), { prevBB: 2, prevSB: 1 });
    await t.playHand();
    const back4 = seen.filter(x => x.seat === 4)[1];
    const back1 = seen.filter(x => x.seat === 1)[1];
    assert(back4 && !back4.legal.some(a => a.type === 'raise'), 'short all-in does not reopen for UTG');
    assert(back1 && !back1.legal.some(a => a.type === 'raise'), 'short all-in does not reopen for caller');
    assert(back4.legal.find(a => a.type === 'call').amount === 300, 'call the extra 300');
  }
  {
    const seen = [];
    const t = table([20000, 20000, 20000, 20000, 900], scripted([[4, 'raise', 600], [5, 'raise', 900], [1, 'call'], [2, 'fold'], [3, 'fold']], seen), { prevBB: 2, prevSB: 1 });
    await t.playHand();
    const r1 = seen.find(x => x.seat === 1).legal.find(a => a.type === 'raise');
    assert(r1 && r1.min === 1300, `after short all-in 900, min raise stays last full raise 400 → 1300 (got ${r1 && r1.min})`);
  }
  {
    const seen = [];
    const t = table([20000, 20000, 20000, 900, 1100], scripted([[4, 'raise', 600], [5, 'call'], [1, 'raise', 900], [2, 'raise', 1100], [3, 'fold']], seen), { prevBB: 2, prevSB: 1 });
    t.players[0].stack = 900;
    t.players[1].stack = 1100;
    t.players[3].stack = 20000;
    t.players[4].stack = 20000;
    await t.playHand();
    const back4 = seen.filter(x => x.seat === 4)[1];
    const r = back4.legal.find(a => a.type === 'raise');
    assert(r && r.min === 1500, `two short all-ins totaling a full raise reopen betting, min to 1500 (got ${r && r.min})`);
  }
  {
    const seen = [];
    const deck = rig([['Kh', 'Kd'], ['2c', '7d']], ['As', '9h', '4c', '3s', 'Jd']);
    const t = table([20000, 20000], scripted([[2, 'call'], [1, 'check'], [1, 'check'], [2, 'check'], [1, 'check'], [2, 'check'], [1, 'check'], [2, 'check']], seen), { prevBB: 2, prevSB: 1, deck });
    await t.playHand();
    const h = t.hand;
    assert(h.buttonSeat === 2 && h.sbSeat === 2 && h.bbSeat === 1, 'heads-up: button is small blind, BB alternates');
    assert(seen[0].seat === 2, 'heads-up: button/SB acts first preflop');
    assert(seen[2].seat === 1, 'heads-up: BB acts first after the flop');
  }
  {
    const t = table([20000, 20000, 20000, 20000], () => null, {});
    t.prevBB = 3;
    t.prevSB = 2;
    at(t, 2).busted = true;
    let pos = t.assignPositions();
    assert(pos.bb === 4 && pos.sb === 3 && pos.button === 2, 'SB busted → dead button on seat 2');
    pos = t.assignPositions();
    assert(pos.bb === 1 && pos.sb === 4 && pos.button === 3, 'then normal rotation');
    const t2 = table([20000, 20000, 20000, 20000], () => null, {});
    t2.prevBB = 3;
    t2.prevSB = 2;
    at(t2, 3).busted = true;
    pos = t2.assignPositions();
    assert(pos.bb === 4 && pos.sb === 3 && pos.button === 2, 'BB busted → dead small blind, BB still moves one seat');
    const t3 = table([20000, 20000, 20000], () => null, {});
    t3.prevBB = 3;
    t3.prevSB = 2;
    at(t3, 1).busted = true;
    pos = t3.assignPositions();
    assert(pos.bb === 2 && pos.sb === 3 && pos.button === 3, 'to heads-up: last BB becomes SB/button, no BB twice');
  }
  {
    const seen = [];
    const deck = rig([['Kc', 'Kd'], ['As', 'Ad']], ['2s', '7h', '9c', 'Jd', '3h']);
    const t = table([20000, 5000], scripted([[2, 'raise', 5000], [1, 'call']], seen), { prevBB: 2, prevSB: 1, deck });
    await t.playHand();
    assert(at(t, 2).stack === 10200, `heads-up shove wins 5000 + 5000 + 200 ante (got ${at(t, 2).stack})`);
    assert(at(t, 1).stack === 20000 - 5200, 'BB loses call + ante');
  }
  {
    const seen = [];
    const deck = rig([['2c', '3d'], ['4h', '5c'], ['6d', '8c']], ['As', 'Ks', 'Qs', 'Js', 'Ts']);
    const t = table([20000, 20000, 20000], scripted([[1, 'call'], [2, 'call'], [3, 'check']], seen), { prevBB: 2, prevSB: 1, deck });
    await t.playHand();
    assert(t.hand.showdown && t.hand.pots[0].amount === 800, 'pot 600 + ante 200');
    const won = [1, 2, 3].map(s => at(t, s).won);
    assert(won[1] === 267 && won[2] === 267 && won[0] === 266, `odd chips go left of button first (got ${won.join('/')})`);
  }
  {
    let total = 0;
    const deck = rig([['7c', '7d'], ['As', 'Kd'], ['Qs', 'Qd']], ['Qh', '9h', '2c', '3s', '8d']);
    const seen = [];
    const t = table([20000, 3000, 8000], scripted([[1, 'raise', 1000], [2, 'raise', 3000], [3, 'raise', 8000], [1, 'call']], seen), { prevBB: 2, prevSB: 1, deck });
    total = t.players.reduce((a, p) => a + p.stack, 0);
    await t.playHand();
    assert(t.players.reduce((a, p) => a + p.stack, 0) === total, 'chips conserved with side pots');
    assert(t.hand.pots.length === 2, 'main + side pot');
    assert(t.hand.pots[0].amount === 3000 * 3 + 200, 'main pot = 3 × 3000 + ante');
    assert(at(t, 3).contrib === 7800, 'BB raise is capped at stack after blind + ante');
    assert(at(t, 1).stack === 20000 - 7800 + 3000 * 3 + 200 + 4800 * 2, 'QQ set wins both pots');
  }
}

/**
 * 기준 봇("ABC" 타이트): 상위 15%만 오픈, 레이즈에는 상위 5%만 콜, 플랍 이후엔 탑 페어 이상이면 베트·콜, 아니면 체크·폴드.
 * @param {object} p 플레이어
 * @param {object[]} legal 가능한 액션
 * @param {object} t 토너먼트
 * @returns {object} 액션
 */
function abcBot(p, legal, t) {
  const h = t.hand;
  const find = type => legal.find(a => a.type === type);
  const passive = find('check') || find('call');
  const fold = find('fold') || find('check');
  const r = find('raise') || find('bet');
  const sizeTo = to => (r ? Object.assign({}, r, { to: Math.max(r.min, Math.min(r.max, Math.round(to))) }) : passive);
  if (h.street === 0) {
    const pct = H.handPct(p.hole);
    if (h.raises === 0) {
      if (pct <= 0.15) return sizeTo(t.level.bb * 2.5);
      return h.currentBet - p.bet === 0 ? passive : fold;
    }
    if (pct <= 0.03) return sizeTo(h.currentBet * 3);
    return pct <= 0.06 ? passive : fold;
  }
  const lv = H.madeLevel(p.hole, h.board);
  const toCall = h.currentBet - p.bet;
  if (toCall === 0) return lv >= 2 ? sizeTo(t.potTotal() * 0.6) : passive;
  if (lv >= 3) return r ? sizeTo(h.currentBet * 2.5) : passive;
  return lv >= 2 && toCall <= t.potTotal() ? passive : fold;
}

/**
 * 공략용 봇: 사람이 컴퓨터를 이용해 먹으려고 쓸 법한 극단적인 전략.
 *  - push: 매 핸드 올인 (못 하면 콜)
 *  - callany: 무조건 체크·콜
 *  - minraise: 할 수 있으면 항상 최소 베트·레이즈, 아니면 콜
 * @param {string} kind 봇 종류
 * @returns {function(object, object[]): object} 봇 함수
 */
function exploitBot(kind) {
  return (p, legal) => {
    const find = type => legal.find(a => a.type === type);
    const passive = find('check') || find('call');
    const r = find('raise') || find('bet');
    if (kind === 'push') return r ? Object.assign({}, r, { to: r.max }) : passive;
    if (kind === 'minraise') return r || passive;
    return passive;
  };
}

/**
 * 대회 하나를 끝까지 돌리면서 매 액션을 검사하고 통계를 모은다.
 * @param {number} seed 시드
 * @param {number} hpl 레벨업 간격
 * @param {number} nPlayers 인원
 * @param {number} abc 기준 봇 수 (0이면 전원 컴퓨터)
 * @param {object} agg 누적 통계
 * @param {string} [botKind] 기준 봇 종류 ('abc' 또는 exploitBot 종류)
 * @returns {Promise<void>} 완료 Promise
 */
async function runOne(seed, hpl, nPlayers, abc, agg, botKind) {
  const rng = Stud.makeRng(seed);
  const kind = botKind || 'abc';
  const bot = kind === 'abc' ? abcBot : exploitBot(kind);
  const ais = H.pickAiPlayers(nPlayers - abc, rng);
  const players = ais.concat(Array.from({ length: abc }, (_, i) => ({ name: `${kind}${i + 1}`, isHuman: true })));
  let lastLegal = null;
  let decisions = 0;
  let decideMs = 0;
  let talks = 0;
  let total = 0;
  const t = new H.Tournament({
    players, rng, handsPerLevel: hpl, sims: 120,
    controller: {
      onEvent: type => { if (type === 'talk') talks++; },
      wait: async () => {},
      humanAction: async (p, legal, tt) => bot(p, legal, tt),
      afterHand: async () => {}
    }
  });
  total = t.players.reduce((a, p) => a + p.stack, 0);
  const origLegal = t.legalActions.bind(t);
  t.legalActions = p => {
    lastLegal = origLegal(p);
    return lastLegal;
  };
  const origApply = t.applyAction.bind(t);
  t.applyAction = (p, a) => {
    const match = lastLegal.find(x => x.type === a.type);
    assert(!!match, `illegal ${a.type}`);
    if (a.type === 'bet' || a.type === 'raise') assert(a.to >= match.min && a.to <= match.max && Number.isInteger(a.to), `raise size ${a.to} in [${match.min}, ${match.max}]`);
    origApply(p, a);
    assert(t.players.reduce((s, x) => s + x.stack, 0) + t.potTotal() === total, 'chips conserved during hand');
  };
  const origDecide = t.aiAction.bind(t);
  t.aiAction = async (p, legal) => {
    const t0 = process.hrtime.bigint();
    const r = await origDecide(p, legal);
    decideMs += Number(process.hrtime.bigint() - t0) / 1e6;
    decisions++;
    return r;
  };
  let tilted = 0;
  let offGear = 0;
  let mindSamples = 0;
  const origEnd = t.ctl.afterHand;
  t.ctl.afterHand = async tt => {
    assert(tt.players.reduce((s, x) => s + x.stack, 0) === total, 'chips conserved after hand');
    tt.players.filter(p => p.mind && !p.busted).forEach(p => {
      mindSamples++;
      if (p.mind.tilt >= 0.15) tilted++;
      if (p.mind.gear !== 0) offGear++;
    });
    return origEnd(tt);
  };
  await t.run();
  const places = t.players.map(p => p.place).sort((a, b) => a - b);
  assert(places.join() === Array.from({ length: nPlayers }, (_, i) => i + 1).join(), 'places 1..n');
  agg.tours++;
  agg.hands += t.handNo;
  agg.decisions += decisions;
  agg.decideMs += decideMs;
  agg.talks += talks;
  agg.tilted += tilted;
  agg.offGear += offGear;
  agg.mindSamples += mindSamples;
  t.players.forEach(p => {
    const key = p.persona ? p.persona.id : 'bot';
    const s = agg.styles[key] || (agg.styles[key] = { n: 0, win: 0, itm: 0, hands: 0, vpip: 0, pfr: 0, agg: 0, pas: 0, sd: 0, steal: 0, stealOpp: 0, cb: 0, cbOpp: 0 });
    s.n++;
    if (p.place === 1) s.win++;
    if (p.place <= t.paidPlaces) s.itm++;
    ['hands', 'vpip', 'pfr', 'agg', 'pas', 'sd', 'steal', 'stealOpp', 'cb', 'cbOpp'].forEach(k => { s[k] += p.st[k]; });
  });
}

/**
 * 누적 통계를 표로 출력한다.
 * @param {string} title 제목
 * @param {object} agg 누적 통계
 * @param {number} nPlayers 인원
 * @returns {void}
 */
function report(title, agg, nPlayers) {
  console.log(`\n${title}: ${agg.tours} tournaments, avg ${(agg.hands / agg.tours).toFixed(1)} hands, ${(agg.decideMs / agg.decisions).toFixed(2)} ms/decision, chat ${(agg.talks / agg.hands).toFixed(3)}/hand, tilted ${(agg.tilted / agg.mindSamples * 100).toFixed(1)}%, off-gear ${(agg.offGear / agg.mindSamples * 100).toFixed(1)}%`);
  console.log('style       n   win%  itm%  vpip  pfr   AF    wtsd  steal cbet');
  Object.entries(agg.styles).sort((a, b) => b[1].win / b[1].n - a[1].win / a[1].n).forEach(([k, s]) => {
    const pc = (x, y) => (y ? (x / y * 100).toFixed(1) : '-').padStart(5);
    console.log(`${k.padEnd(10)} ${String(s.n).padStart(3)} ${pc(s.win, s.n)} ${pc(s.itm, s.n)} ${pc(s.vpip, s.hands)} ${pc(s.pfr, s.hands)} ${(s.agg / Math.max(1, s.pas)).toFixed(2).padStart(5)} ${pc(s.sd, s.vpip)} ${pc(s.steal, s.stealOpp)} ${pc(s.cb, s.cbOpp)}`);
  });
  if (agg.styles.bot) {
    const smart = Object.entries(agg.styles).filter(([k]) => k !== 'bot').reduce((a, [, s]) => a + s.win, 0);
    const smartN = Object.entries(agg.styles).filter(([k]) => k !== 'bot').reduce((a, [, s]) => a + s.n, 0);
    console.log(`computer win share ${(smart / agg.tours * 100).toFixed(1)}% (fair ${(smartN / agg.tours / nPlayers * 100).toFixed(1)}%)`);
  }
}

/**
 * 테스트 진입점.
 * @returns {Promise<void>} 완료 Promise
 */
async function main() {
  await ruleTests();
  console.log(`rule tests ok (${checks} checks)`);
  const n = Number(process.argv[2]) || 60;
  const mode = process.argv[3] || 'all';
  const fresh = () => ({ tours: 0, hands: 0, decisions: 0, decideMs: 0, talks: 0, tilted: 0, offGear: 0, mindSamples: 0, styles: {} });
  if (mode === 'all' || mode === 'both') {
    const agg = fresh();
    for (let i = 0; i < n; i++) await runOne(1000 + i, 10, 9, 0, agg);
    report('9 computers', agg, 9);
    const agg6 = fresh();
    for (let i = 0; i < Math.ceil(n / 3); i++) await runOne(5000 + i, 10, 6, 0, agg6);
    report('6 computers', agg6, 6);
  }
  if (mode === 'mixed' || mode === 'both') {
    const agg = fresh();
    for (let i = 0; i < n; i++) await runOne(9000 + i, 10, 9, 4, agg);
    report('5 computers + 4 ABC bots', agg, 9);
  }
  if (mode === 'exploit' || mode === 'both') {
    for (const kind of ['push', 'callany', 'minraise']) {
      const agg = fresh();
      for (let i = 0; i < n; i++) await runOne(12000 + i, 10, 9, 1, agg, kind);
      const b = agg.styles.bot;
      console.log(`exploit bot "${kind}" vs 8 computers: win ${(b.win / b.n * 100).toFixed(1)}% · itm ${(b.itm / b.n * 100).toFixed(1)}% (fair 11.1% · 33.3%), avg ${(agg.hands / agg.tours).toFixed(0)} hands`);
    }
  }
  console.log(`\nall ok (${checks} checks)`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
