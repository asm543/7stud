/**
 * 7카드 스터드 토너먼트 엔진
 * DOM에 의존하지 않는 순수 게임 로직으로, 브라우저와 Node 양쪽에서 동작한다.
 * 구성 요소
 *  - 카드 표현과 덱: 카드 한 장을 정수(rank * 4 + suit)로 다룬다. suit 0~3 = ♣ ♦ ♥ ♠ (브링인 서열과 동일)
 *  - 족보 평가: 3~7장 평가, 오픈 카드만의 평가(4구 이후 선 결정용)
 *  - 몬테카를로 승률 추정: AI 판단과 연습 모드 힌트에 사용
 *  - Tournament: 앤티·브링인·complete, 고정 리밋(캡 = 베트 + 3레이즈), 사이드팟, 레벨, 탈락·순위
 *  - AI 판단: 성향(페르소나)별 임계값으로 폴드/콜/레이즈 결정
 */
const Stud = (() => {
  const SUIT_SYMBOLS = ['♣', '♦', '♥', '♠'];
  const RANK_LABELS = ['', '', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
  const HAND_NAMES = ['하이카드', '원페어', '투페어', '트리플', '스트레이트', '플러시', '풀하우스', '포카드', '스트레이트 플러시'];
  const STREET_NAMES = { 3: '3구', 4: '4구', 5: '5구', 6: '6구', 7: '7구 (히든)' };
  const STREET_EN = { 3: '3rd street', 4: '4th street', 5: '5th street', 6: '6th street', 7: '7th street' };
  const MAX_RAISE_LEVELS = 4;
  const BASE = 16;
  const CAT_BASE = BASE ** 5;

  const LEVELS = [
    { ante: 25, bringIn: 25, small: 100, big: 200 },
    { ante: 25, bringIn: 50, small: 150, big: 300 },
    { ante: 50, bringIn: 50, small: 200, big: 400 },
    { ante: 75, bringIn: 75, small: 300, big: 600 },
    { ante: 100, bringIn: 100, small: 400, big: 800 },
    { ante: 100, bringIn: 150, small: 600, big: 1200 },
    { ante: 150, bringIn: 200, small: 800, big: 1600 },
    { ante: 200, bringIn: 300, small: 1000, big: 2000 },
    { ante: 300, bringIn: 400, small: 1500, big: 3000 },
    { ante: 400, bringIn: 500, small: 2000, big: 4000 },
    { ante: 500, bringIn: 600, small: 2500, big: 5000 },
    { ante: 600, bringIn: 800, small: 3000, big: 6000 },
    { ante: 800, bringIn: 1000, small: 4000, big: 8000 },
    { ante: 1000, bringIn: 1500, small: 6000, big: 12000 },
    { ante: 1500, bringIn: 2000, small: 8000, big: 16000 }
  ];

  const PERSONAS = [
    { id: 'rock', name: 'Linda', enter: 1.45, raise: 2.1, aggr: 0.35, bluff: 0.02, steal: 0.06, sticky: 0.0, respect: 0.2 },
    { id: 'lag', name: 'Victor', enter: 1.1, raise: 1.45, aggr: 0.75, bluff: 0.18, steal: 0.6, sticky: 0.05, respect: 0.08 },
    { id: 'tag', name: 'Kenji', enter: 1.3, raise: 1.7, aggr: 0.62, bluff: 0.08, steal: 0.35, sticky: 0.02, respect: 0.14 },
    { id: 'station', name: 'Marco', enter: 1.0, raise: 2.3, aggr: 0.2, bluff: 0.03, steal: 0.05, sticky: 0.35, respect: 0.04 },
    { id: 'solid', name: 'Sophie', enter: 1.25, raise: 1.65, aggr: 0.55, bluff: 0.1, steal: 0.4, sticky: 0.08, respect: 0.14 },
    { id: 'loose', name: 'Dmitri', enter: 1.05, raise: 1.95, aggr: 0.3, bluff: 0.06, steal: 0.15, sticky: 0.2, respect: 0.08 }
  ];

  /**
   * 카드 정수에서 숫자(2~14)를 꺼낸다.
   * @param {number} c 카드 정수
   * @returns {number} 숫자 (A = 14)
   */
  function rankOf(c) {
    return c >> 2;
  }

  /**
   * 카드 정수에서 무늬(0 클럽 ~ 3 스페이드)를 꺼낸다.
   * @param {number} c 카드 정수
   * @returns {number} 무늬 인덱스
   */
  function suitOf(c) {
    return c & 3;
  }

  /**
   * 카드를 "K♠" 같은 표시용 문자열로 바꾼다.
   * @param {number} c 카드 정수
   * @returns {string} 표시 문자열
   */
  function cardLabel(c) {
    return RANK_LABELS[rankOf(c)] + SUIT_SYMBOLS[suitOf(c)];
  }

  /**
   * 숫자를 천 단위 구분 문자열로 만든다.
   * @param {number} n 숫자
   * @returns {string} 예: 12,500
   */
  function fmt(n) {
    return Math.round(n).toLocaleString('en-US');
  }

  /**
   * 시드 기반 의사난수 생성기(mulberry32)를 만든다. 테스트 재현용.
   * @param {number} seed 32비트 정수 시드
   * @returns {function(): number} [0, 1) 난수 함수
   */
  function makeRng(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /**
   * 배열을 제자리에서 섞는다 (Fisher-Yates).
   * @param {Array} arr 대상 배열
   * @param {function(): number} rng 난수 함수
   * @returns {Array} 섞인 같은 배열
   */
  function shuffle(arr, rng) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }
    return arr;
  }

  /**
   * 52장 덱을 새로 만들어 섞는다.
   * @param {function(): number} rng 난수 함수
   * @returns {number[]} 섞인 카드 정수 배열 (pop으로 딜)
   */
  function newDeck(rng) {
    const d = [];
    for (let r = 2; r <= 14; r++) {
      for (let s = 0; s < 4; s++) d.push(r * 4 + s);
    }
    return shuffle(d, rng);
  }

  /**
   * 족보 분류와 비교용 숫자들을 하나의 비교 가능한 점수로 묶는다.
   * @param {number} cat 족보 분류 (0 하이카드 ~ 8 스트레이트 플러시)
   * @param {number[]} ranks 비교 순서대로의 숫자들 (최대 5개)
   * @returns {number} 클수록 강한 점수
   */
  function packScore(cat, ranks) {
    let v = cat * CAT_BASE;
    for (let i = 0; i < 5; i++) v += (ranks[i] || 0) * BASE ** (4 - i);
    return v;
  }

  /**
   * 점수에서 족보 분류를 꺼낸다.
   * @param {number} score packScore 결과
   * @returns {number} 족보 분류
   */
  function scoreCategory(score) {
    return Math.floor(score / CAT_BASE);
  }

  /**
   * 점수에서 비교용 숫자 5개를 꺼낸다.
   * @param {number} score packScore 결과
   * @returns {number[]} 숫자 배열
   */
  function scoreRanks(score) {
    const out = [];
    let rest = score % CAT_BASE;
    for (let i = 4; i >= 0; i--) {
      const unit = BASE ** i;
      out.push(Math.floor(rest / unit));
      rest %= unit;
    }
    return out;
  }

  /**
   * 숫자 비트마스크에서 가장 높은 스트레이트의 탑 숫자를 찾는다. A-2-3-4-5는 5 하이(가장 낮음).
   * @param {number} mask 비트 r이 켜져 있으면 숫자 r 보유
   * @returns {number} 스트레이트 탑 숫자, 없으면 0
   */
  function straightHigh(mask) {
    const m = mask & (1 << 14) ? mask | 2 : mask;
    for (let h = 14; h >= 5; h--) {
      if (((m >> (h - 4)) & 31) === 31) return h;
    }
    return 0;
  }

  /**
   * 숫자별 개수 배열에서 제외 목록을 뺀 높은 숫자를 n개 고른다.
   * @param {Int8Array} rc 숫자별 개수
   * @param {number[]} exclude 제외할 숫자
   * @param {number} n 고를 개수
   * @returns {number[]} 내림차순 키커
   */
  function kickers(rc, exclude, n) {
    const out = [];
    for (let r = 14; r >= 2 && out.length < n; r--) {
      if (rc[r] && exclude.indexOf(r) < 0) out.push(r);
    }
    return out;
  }

  /**
   * 3~7장 중 가장 좋은 5장 족보를 평가한다.
   * @param {number[]} cards 카드 정수 배열
   * @returns {number} 비교 가능한 족보 점수
   */
  function evaluate(cards) {
    const rc = new Int8Array(15);
    const sc = [0, 0, 0, 0];
    let mask = 0;
    for (let i = 0; i < cards.length; i++) {
      const c = cards[i];
      rc[c >> 2]++;
      sc[c & 3]++;
      mask |= 1 << (c >> 2);
    }
    let fs = -1;
    let fmask = 0;
    for (let s = 0; s < 4; s++) if (sc[s] >= 5) fs = s;
    if (fs >= 0) {
      for (let i = 0; i < cards.length; i++) if ((cards[i] & 3) === fs) fmask |= 1 << (cards[i] >> 2);
      const sf = straightHigh(fmask);
      if (sf) return packScore(8, [sf]);
    }
    const quads = [];
    const trips = [];
    const pairs = [];
    for (let r = 14; r >= 2; r--) {
      if (rc[r] === 4) quads.push(r);
      else if (rc[r] === 3) trips.push(r);
      else if (rc[r] === 2) pairs.push(r);
    }
    if (quads.length) return packScore(7, [quads[0], kickers(rc, [quads[0]], 1)[0] || 0]);
    if (trips.length && (trips.length > 1 || pairs.length)) {
      return packScore(6, [trips[0], Math.max(trips[1] || 0, pairs[0] || 0)]);
    }
    if (fs >= 0) {
      const fr = [];
      for (let r = 14; r >= 2 && fr.length < 5; r--) if (fmask & (1 << r)) fr.push(r);
      return packScore(5, fr);
    }
    const st = straightHigh(mask);
    if (st) return packScore(4, [st]);
    if (trips.length) return packScore(3, [trips[0]].concat(kickers(rc, [trips[0]], 2)));
    if (pairs.length >= 2) return packScore(2, [pairs[0], pairs[1]].concat(kickers(rc, [pairs[0], pairs[1]], 1)));
    if (pairs.length === 1) return packScore(1, [pairs[0]].concat(kickers(rc, [pairs[0]], 3)));
    return packScore(0, kickers(rc, [], 5));
  }

  /**
   * 오픈 카드(1~4장)만으로 보이는 패의 세기를 평가한다. 스트레이트·플러시 미완성은 치지 않는다.
   * @param {number[]} cards 오픈 카드 정수 배열
   * @returns {number} 비교 가능한 점수 (포카드 > 트리플 > 투페어 > 원페어 > 하이)
   */
  function evaluateShowing(cards) {
    const rc = new Int8Array(15);
    for (let i = 0; i < cards.length; i++) rc[cards[i] >> 2]++;
    const trips = [];
    const pairs = [];
    for (let r = 14; r >= 2; r--) {
      if (rc[r] === 4) return packScore(7, [r]);
      if (rc[r] === 3) trips.push(r);
      else if (rc[r] === 2) pairs.push(r);
    }
    if (trips.length) return packScore(3, [trips[0]].concat(kickers(rc, [trips[0]], 1)));
    if (pairs.length >= 2) return packScore(2, [pairs[0], pairs[1]]);
    if (pairs.length === 1) return packScore(1, [pairs[0]].concat(kickers(rc, [pairs[0]], 2)));
    return packScore(0, kickers(rc, [], 4));
  }

  /**
   * 족보 점수를 한국어 설명으로 바꾼다.
   * @param {number} score evaluate 결과
   * @returns {string} 예: "K 트리플", "풀하우스 (Q 트리플 + 7 페어)"
   */
  function describeScore(score) {
    const cat = scoreCategory(score);
    const r = scoreRanks(score).map(x => RANK_LABELS[x] || '');
    switch (cat) {
      case 8: return r[0] === 'A' ? '로열 스트레이트 플러시' : `${r[0]} 하이 스트레이트 플러시`;
      case 7: return `${r[0]} 포카드`;
      case 6: return `풀하우스 (${r[0]} 트리플 + ${r[1]} 페어)`;
      case 5: return `${r[0]} 하이 플러시`;
      case 4: return `${r[0]} 하이 스트레이트`;
      case 3: return `${r[0]} 트리플`;
      case 2: return `${r[0]}·${r[1]} 투페어`;
      case 1: return `${r[0]} 원페어`;
      default: return `${r[0]} 하이`;
    }
  }

  /**
   * 동점 팟을 나눌 때 남는 칩의 우선순위 키를 구한다 (베스트 5장 중 가장 높은 카드의 무늬 기준).
   * @param {number[]} cards 플레이어의 카드
   * @param {number} score 해당 플레이어의 족보 점수
   * @returns {number} 클수록 우선
   */
  function oddChipKey(cards, score) {
    const cat = scoreCategory(score);
    const top = scoreRanks(score)[0];
    let suit = -1;
    if (cat === 5 || cat === 8) {
      const sc = [0, 0, 0, 0];
      cards.forEach(c => { sc[suitOf(c)]++; });
      suit = sc.findIndex(n => n >= 5);
    } else {
      cards.forEach(c => { if (rankOf(c) === top) suit = Math.max(suit, suitOf(c)); });
    }
    return top * 4 + suit;
  }

  /**
   * 몬테카를로로 승률을 추정한다. 상대의 히든 카드와 앞으로 받을 카드는 보이지 않은 카드 중에서 무작위로 가정한다.
   * @param {number[]} myCards 내 카드 전부
   * @param {{up:number[]}[]} opponents 남아 있는 상대들의 오픈 카드
   * @param {number[]} dead 그 밖에 이미 본 카드 (폴드한 사람의 오픈 카드)
   * @param {number} sims 시뮬레이션 횟수
   * @param {function(): number} rng 난수 함수
   * @returns {number} 0~1 사이 승률 (무승부는 나눠서 반영)
   */
  function estimateEquity(myCards, opponents, dead, sims, rng) {
    if (!opponents.length) return 1;
    const known = new Set(myCards.concat(dead));
    opponents.forEach(o => o.up.forEach(c => known.add(c)));
    const pool = [];
    for (let c = 8; c < 60; c++) if (!known.has(c)) pool.push(c);
    const myNeed = 7 - myCards.length;
    const needs = opponents.map(o => 7 - o.up.length);
    const total = myNeed + needs.reduce((a, b) => a + b, 0);
    if (total > pool.length) return 1 / (opponents.length + 1);
    let acc = 0;
    for (let n = 0; n < sims; n++) {
      for (let i = 0; i < total; i++) {
        const j = i + Math.floor(rng() * (pool.length - i));
        const tmp = pool[i];
        pool[i] = pool[j];
        pool[j] = tmp;
      }
      let k = 0;
      const mine = myCards.slice();
      for (let i = 0; i < myNeed; i++) mine.push(pool[k++]);
      const myScore = evaluate(mine);
      let lost = false;
      let ties = 0;
      for (let o = 0; o < opponents.length && !lost; o++) {
        const hand = opponents[o].up.slice();
        for (let i = 0; i < needs[o]; i++) hand.push(pool[k++]);
        const s = evaluate(hand);
        if (s > myScore) lost = true;
        else if (s === myScore) ties++;
      }
      if (!lost) acc += 1 / (ties + 1);
    }
    return acc / sims;
  }

  /**
   * 토너먼트 한 개를 진행하는 클래스.
   * 내부 요소
   *  - players: 좌석 순으로 정렬된 플레이어 (stack, cards, bet, contrib, folded, allIn, busted, place ...)
   *  - hand: 현재 핸드 상태 (street, currentBet, raises, unit, bringInSeat, deadUp, pots ...)
   *  - ctl: 화면 쪽 컨트롤러 (onEvent, wait, humanAction, afterHand)
   *  - log: 핸드 기록
   */
  class Tournament {
    /**
     * 토너먼트를 만든다.
     * @param {object} opts 설정
     * @param {{name:string,isHuman?:boolean,persona?:object}[]} opts.players 참가자
     * @param {object} opts.controller 화면 컨트롤러
     * @param {number} [opts.handsPerLevel=6] 레벨업 간격(핸드 수)
     * @param {number} [opts.startingStack=10000] 시작 스택
     * @param {number} [opts.sims=160] AI 승률 추정 시뮬레이션 횟수
     * @param {function(): number} [opts.rng] 난수 함수
     * @param {object} [opts.restore] snapshot()으로 저장한 이어하기 데이터
     */
    constructor(opts) {
      this.rng = opts.rng || Math.random;
      this.ctl = opts.controller;
      this.handsPerLevel = opts.handsPerLevel || 6;
      this.startingStack = opts.startingStack || 10000;
      this.sims = opts.sims || 160;
      this.handNo = 0;
      this.hand = null;
      this.log = [];
      this.finished = false;
      const seats = shuffle([1, 2, 3, 4, 5, 6, 7].slice(0, opts.players.length), this.rng);
      this.players = opts.players.map((p, i) => ({
        id: i,
        name: p.name,
        isHuman: !!p.isHuman,
        persona: p.persona || null,
        seat: seats[i],
        stack: this.startingStack,
        busted: false,
        place: null,
        cards: [],
        bet: 0,
        contrib: 0,
        folded: true,
        allIn: false,
        inHand: false
      }));
      if (opts.restore) this.applySnapshot(opts.restore);
      this.players.sort((a, b) => a.seat - b.seat);
    }

    /**
     * 이어하기 데이터를 적용한다.
     * @param {object} snap snapshot() 결과
     * @returns {void}
     */
    applySnapshot(snap) {
      this.handNo = snap.handNo;
      this.handsPerLevel = snap.handsPerLevel;
      this.players.forEach((p, i) => {
        const s = snap.players[i];
        if (!s) return;
        Object.assign(p, { seat: s.seat, stack: s.stack, busted: s.busted, place: s.place });
      });
    }

    /**
     * 핸드 사이 시점의 이어하기 데이터를 만든다.
     * @returns {object} JSON 직렬화 가능한 요약
     */
    snapshot() {
      return {
        handNo: this.handNo,
        handsPerLevel: this.handsPerLevel,
        players: this.players.slice().sort((a, b) => a.id - b.id).map(p => ({
          seat: p.seat, stack: p.stack, busted: p.busted, place: p.place
        }))
      };
    }

    /**
     * 현재 레벨 인덱스(0부터)를 구한다.
     * @param {number} [handNo] 기준 핸드 번호, 생략 시 현재 핸드
     * @returns {number} 레벨 인덱스
     */
    levelIndex(handNo) {
      const n = handNo === undefined ? this.handNo : handNo;
      return Math.min(Math.floor((Math.max(n, 1) - 1) / this.handsPerLevel), LEVELS.length - 1);
    }

    /**
     * 현재 레벨 구조(앤티/브링인/리밋)를 돌려준다.
     * @returns {{ante:number,bringIn:number,small:number,big:number}} 레벨 구조
     */
    get level() {
      return LEVELS[this.levelIndex()];
    }

    /**
     * 탈락하지 않은 플레이어 목록.
     * @returns {object[]} 플레이어 배열
     */
    alive() {
      return this.players.filter(p => !p.busted);
    }

    /**
     * 이번 핸드에서 폴드하지 않은 플레이어 목록.
     * @returns {object[]} 플레이어 배열
     */
    live() {
      return this.players.filter(p => p.inHand && !p.folded);
    }

    /**
     * 아직 액션할 수 있는지(폴드·올인 아님) 확인한다.
     * @param {object} p 플레이어
     * @returns {boolean} 액션 가능 여부
     */
    canAct(p) {
      return p.inHand && !p.folded && !p.allIn;
    }

    /**
     * 액션 가능한 플레이어 목록.
     * @returns {object[]} 플레이어 배열
     */
    actors() {
      return this.players.filter(p => this.canAct(p));
    }

    /**
     * 이번 핸드의 총 팟(앤티 포함 모든 기여 칩).
     * @returns {number} 팟 크기
     */
    potTotal() {
      return this.players.reduce((a, p) => a + p.contrib, 0);
    }

    /**
     * 화면 쪽에 이벤트를 알린다.
     * @param {string} type 이벤트 종류
     * @param {*} [data] 부가 데이터
     * @returns {void}
     */
    emit(type, data) {
      if (this.ctl && this.ctl.onEvent) this.ctl.onEvent(type, data, this);
    }

    /**
     * 핸드 기록에 한 줄을 추가한다.
     * @param {string} text 기록 내용
     * @param {string} [kind] 표시 구분 (head, street, win, bust, level)
     * @returns {void}
     */
    addLog(text, kind) {
      this.log.push({ text, kind: kind || '', hand: this.handNo });
      if (this.log.length > 600) this.log.splice(0, this.log.length - 600);
    }

    /**
     * 토너먼트를 끝까지 진행한다.
     * @returns {Promise<void>} 우승자가 정해지면 끝나는 Promise
     */
    async run() {
      this.emit('start');
      while (this.alive().length > 1) {
        this.handNo++;
        if (this.handNo > 1 && this.levelIndex() !== this.levelIndex(this.handNo - 1)) {
          const L = this.level;
          this.addLog(`레벨 ${this.levelIndex() + 1} 시작 · 앤티 ${fmt(L.ante)} / 브링인 ${fmt(L.bringIn)} / 리밋 ${fmt(L.small)}-${fmt(L.big)}`, 'level');
        }
        await this.playHand();
        this.resolveBusts();
        this.emit('handEnd');
        if (this.alive().length > 1) await this.ctl.afterHand(this);
      }
      const winner = this.alive()[0];
      winner.place = 1;
      this.finished = true;
      this.addLog(`${winner.name} 우승!`, 'win');
      this.emit('tournamentEnd');
    }

    /**
     * 칩을 팟에 넣는다.
     * @param {object} p 플레이어
     * @param {number} amount 넣을 금액
     * @param {boolean} isBet 이번 스트리트 베팅에 포함할지 여부 (앤티는 false)
     * @returns {number} 실제로 넣은 금액
     */
    commit(p, amount, isBet) {
      const amt = Math.max(0, Math.min(amount, p.stack));
      p.stack -= amt;
      p.contrib += amt;
      if (isBet) p.bet += amt;
      if (p.stack === 0) p.allIn = true;
      return amt;
    }

    /**
     * 지정한 좌석부터 시계방향으로 이번 핸드 참가자를 나열한다.
     * @param {number} seat 시작 좌석 번호
     * @returns {object[]} 순서대로의 플레이어
     */
    orderFrom(seat) {
      const ps = this.players.filter(p => p.inHand);
      const idx = ps.findIndex(p => p.seat === seat);
      return ps.slice(idx).concat(ps.slice(0, idx));
    }

    /**
     * 플레이어의 오픈 카드 정수 목록.
     * @param {object} p 플레이어
     * @returns {number[]} 오픈 카드
     */
    upCards(p) {
      return p.cards.filter(x => x.up).map(x => x.c);
    }

    /**
     * 핸드 하나를 진행한다: 앤티 → 3구 딜·브링인 → 4~7구 → 쇼다운/정산.
     * @returns {Promise<void>} 핸드가 끝나면 끝나는 Promise
     */
    async playHand() {
      const L = this.level;
      const deck = newDeck(this.rng);
      this.players.forEach(p => {
        Object.assign(p, {
          cards: [], bet: 0, contrib: 0, allIn: false, acted: false, mayRaise: true,
          lastAction: '', shown: false, result: '', won: 0,
          inHand: !p.busted, folded: p.busted, startStack: p.stack
        });
      });
      this.hand = {
        no: this.handNo, levelIndex: this.levelIndex(), deck, street: 3, currentBet: 0, raises: 0,
        unit: L.small, bringInSeat: null, bringInPending: false, actingSeat: null, deadUp: [],
        pots: [], showdown: false, done: false
      };
      this.addLog(`핸드 #${this.handNo} · 레벨 ${this.levelIndex() + 1} (앤티 ${fmt(L.ante)} / 브링인 ${fmt(L.bringIn)} / ${fmt(L.small)}-${fmt(L.big)})`, 'head');
      this.players.filter(p => p.inHand).forEach(p => this.commit(p, L.ante, false));
      const dealt = this.players.filter(p => p.inHand);
      for (let round = 0; round < 3; round++) {
        dealt.forEach(p => p.cards.push({ c: deck.pop(), up: round === 2 }));
      }
      this.emit('deal');
      if (this.actors().length >= 2) await this.bettingRound(3);
      for (let street = 4; street <= 7; street++) {
        if (this.live().length <= 1) break;
        this.hand.street = street;
        const live = this.live();
        const needed = live.length * (7 - live[0].cards.length);
        if (deck.length - 1 >= needed) deck.pop();
        live.forEach(p => p.cards.push({ c: deck.pop(), up: street < 7 }));
        this.players.forEach(p => { p.bet = 0; p.lastAction = p.folded ? p.lastAction : ''; });
        this.emit('deal');
        if (this.actors().length >= 2) {
          await this.bettingRound(street);
        } else {
          this.addLog(`${STREET_NAMES[street]} 딜 (올인 런아웃)`, 'street');
          await this.ctl.wait(null, this, 'runout');
        }
      }
      this.settle();
      this.emit('settle');
    }

    /**
     * 3구 브링인 대상(도어 카드가 가장 낮은 사람, 같으면 무늬 ♣<♦<♥<♠ 중 낮은 쪽)을 찾는다.
     * @returns {object|null} 브링인 플레이어
     */
    findBringIn() {
      const cands = this.actors();
      if (!cands.length) return null;
      return cands.reduce((lo, p) => (p.cards[2].c < lo.cards[2].c ? p : lo));
    }

    /**
     * 4구 이후 먼저 액션할 사람(보이는 패가 가장 높은 사람, 같으면 딜러 왼쪽 = 낮은 좌석 번호)을 찾는다.
     * @returns {object} 플레이어
     */
    firstToAct() {
      let best = null;
      let bestScore = -1;
      this.live().forEach(p => {
        const s = evaluateShowing(this.upCards(p));
        if (s > bestScore) {
          best = p;
          bestScore = s;
        }
      });
      return best;
    }

    /**
     * 한 스트리트의 베팅 라운드를 진행한다.
     * @param {number} street 3~7
     * @returns {Promise<void>} 라운드가 끝나면 끝나는 Promise
     */
    async bettingRound(street) {
      const h = this.hand;
      const L = this.level;
      h.street = street;
      h.unit = street <= 4 ? L.small : L.big;
      h.currentBet = 0;
      h.raises = 0;
      this.players.forEach(p => { p.bet = 0; p.acted = false; p.mayRaise = true; });
      let start;
      if (street === 3) {
        start = this.findBringIn();
        h.bringInSeat = start.seat;
        h.bringInPending = true;
        this.addLog(`3구 딜 · 도어 카드가 가장 낮은 ${start.name}(${cardLabel(start.cards[2].c)})가 브링인`, 'street');
      } else {
        start = this.firstToAct();
        const shown = this.upCards(start).map(cardLabel).join(' ');
        this.addLog(`${STREET_NAMES[street]} 딜 · 먼저 액션: ${start.name} (${shown}) · ${street <= 4 ? '스몰' : '빅'} 베팅 ${fmt(h.unit)}`, 'street');
      }
      const order = this.orderFrom(start.seat);
      let i = 0;
      let guard = 0;
      while (this.live().length > 1) {
        const actors = this.actors();
        const pending = actors.filter(p => !p.acted || p.bet < h.currentBet);
        if (!pending.length) break;
        if (actors.length === 1 && actors[0].bet >= h.currentBet && !h.bringInPending) break;
        const p = order[i % order.length];
        i++;
        if (!this.canAct(p) || (p.acted && p.bet >= h.currentBet)) continue;
        const legal = this.legalActions(p);
        h.actingSeat = p.seat;
        this.emit('turn', p);
        const action = p.isHuman ? await this.ctl.humanAction(p, legal, this) : await this.aiAction(p, legal);
        this.applyAction(p, action);
        h.actingSeat = null;
        this.emit('action', p);
        if (++guard > 400) throw new Error('betting loop guard');
      }
      h.bringInPending = false;
    }

    /**
     * 플레이어가 지금 할 수 있는 액션 목록을 만든다.
     * @param {object} p 플레이어
     * @returns {{type:string,amount?:number,to?:number,allIn?:boolean}[]} 가능한 액션
     */
    legalActions(p) {
      const h = this.hand;
      const L = this.level;
      if (h.bringInPending && p.seat === h.bringInSeat) {
        const bi = Math.min(L.bringIn, p.stack);
        const acts = [{ type: 'bringin', amount: bi, to: bi, allIn: bi === p.stack }];
        if (p.stack > L.bringIn) {
          const to = Math.min(h.unit, p.stack);
          acts.push({ type: 'complete', amount: to, to, allIn: to === p.stack });
        }
        return acts;
      }
      const toCall = Math.max(0, h.currentBet - p.bet);
      const others = this.actors().filter(o => o !== p).length;
      const fullTarget = (h.raises + 1) * h.unit;
      const canRaise = h.raises < MAX_RAISE_LEVELS && p.mayRaise && others > 0 && p.stack > toCall;
      const raiseTo = Math.min(fullTarget, p.bet + p.stack);
      const acts = [];
      if (toCall === 0) {
        acts.push({ type: 'check' });
        if (canRaise) acts.push({ type: 'bet', to: raiseTo, amount: raiseTo - p.bet, allIn: raiseTo - p.bet === p.stack });
      } else {
        acts.push({ type: 'fold' });
        const callAmt = Math.min(toCall, p.stack);
        acts.push({ type: 'call', amount: callAmt, to: p.bet + callAmt, allIn: callAmt === p.stack });
        if (canRaise) {
          const type = h.street === 3 && h.raises === 0 ? 'complete' : 'raise';
          acts.push({ type, to: raiseTo, amount: raiseTo - p.bet, allIn: raiseTo - p.bet === p.stack });
        }
      }
      return acts;
    }

    /**
     * 액션을 적용하고 기록을 남긴다. 풀 레이즈는 레이즈 횟수를 올리고 다른 사람의 액션을 다시 연다.
     * 금액이 모자란 올인 레이즈는 이미 액션한 사람에게 콜/폴드만 허용한다.
     * @param {object} p 플레이어
     * @param {{type:string,amount?:number,to?:number}} a 액션
     * @returns {void}
     */
    applyAction(p, a) {
      const h = this.hand;
      const allInTag = () => (p.allIn ? ' (올인)' : '');
      if (a.type === 'fold') {
        p.folded = true;
        p.acted = true;
        h.deadUp.push(...this.upCards(p));
        p.lastAction = 'Fold';
        this.addLog(`${p.name}: fold`);
      } else if (a.type === 'check') {
        p.acted = true;
        p.lastAction = 'Check';
        this.addLog(`${p.name}: check`);
      } else if (a.type === 'call') {
        const amt = this.commit(p, h.currentBet - p.bet, true);
        p.acted = true;
        p.lastAction = `Call ${fmt(amt)}`;
        this.addLog(`${p.name}: call ${fmt(amt)}${allInTag()}`);
      } else if (a.type === 'bringin') {
        const amt = this.commit(p, a.amount, true);
        h.currentBet = Math.max(h.currentBet, p.bet);
        h.bringInPending = false;
        p.acted = true;
        p.lastAction = `Bring-in ${fmt(amt)}`;
        this.addLog(`${p.name}: bring-in ${fmt(amt)}${allInTag()}`);
      } else {
        this.commit(p, a.to - p.bet, true);
        const fullTarget = (h.raises + 1) * h.unit;
        h.bringInPending = false;
        const others = this.actors().filter(o => o !== p);
        if (p.bet >= fullTarget) {
          h.raises++;
          h.currentBet = p.bet;
          others.forEach(o => { o.acted = false; o.mayRaise = true; });
        } else if (p.bet > h.currentBet) {
          h.currentBet = p.bet;
          others.forEach(o => { if (o.acted) o.mayRaise = false; o.acted = false; });
        }
        p.acted = true;
        const label = a.type === 'bet' ? 'Bet' : a.type === 'complete' ? 'Complete' : 'Raise';
        p.lastAction = `${label} ${fmt(p.bet)}`;
        this.addLog(`${p.name}: ${a.type} ${a.type === 'bet' ? '' : '→ '}${fmt(p.bet)}${allInTag()}`);
      }
    }

    /**
     * AI 플레이어의 액션을 정한다 (화면 쪽 대기 후 판단).
     * @param {object} p AI 플레이어
     * @param {object[]} legal 가능한 액션
     * @returns {Promise<object>} 고른 액션
     */
    async aiAction(p, legal) {
      await this.ctl.wait(p, this, 'think');
      return aiDecide(this, p, legal);
    }

    /**
     * 기여 금액 기준으로 메인 팟과 사이드 팟을 만든다.
     * @returns {{amount:number,eligible:object[]}[]} 팟 목록 (작은 팟부터)
     */
    buildPots() {
      const contenders = this.players.filter(p => p.inHand);
      const levels = Array.from(new Set(contenders.map(p => p.contrib).filter(x => x > 0))).sort((a, b) => a - b);
      const pots = [];
      let carry = 0;
      let prev = 0;
      levels.forEach(lv => {
        let amount = 0;
        contenders.forEach(p => { amount += Math.max(0, Math.min(p.contrib, lv) - prev); });
        const eligible = contenders.filter(p => !p.folded && p.contrib >= lv);
        if (eligible.length) {
          const last = pots[pots.length - 1];
          if (last && last.eligible.length === eligible.length) last.amount += amount + carry;
          else pots.push({ amount: amount + carry, eligible });
          carry = 0;
        } else if (pots.length) {
          pots[pots.length - 1].amount += amount;
        } else {
          carry += amount;
        }
        prev = lv;
      });
      return pots;
    }

    /**
     * 핸드를 정산한다. 혼자 남으면 팟 전체를, 쇼다운이면 팟별로 승자를 가려 나눈다.
     * @returns {void}
     */
    settle() {
      const h = this.hand;
      const live = this.live();
      h.pots = [];
      if (live.length === 1) {
        const w = live[0];
        const total = this.potTotal();
        w.stack += total;
        w.won = total;
        h.pots = [{ amount: total, winners: [w] }];
        this.addLog(`${w.name}: 팟 ${fmt(total)} 획득 (쇼다운 없음)`, 'win');
      } else {
        h.showdown = true;
        live.forEach(p => {
          p.shown = true;
          p.score = evaluate(p.cards.map(x => x.c));
          p.result = describeScore(p.score);
          this.addLog(`${p.name} 쇼다운: ${p.cards.map(x => cardLabel(x.c)).join(' ')} → ${p.result}`);
        });
        const pots = this.buildPots();
        pots.forEach((pot, idx) => {
          const best = Math.max(...pot.eligible.map(p => p.score));
          const winners = pot.eligible.filter(p => p.score === best)
            .sort((a, b) => oddChipKey(b.cards.map(x => x.c), b.score) - oddChipKey(a.cards.map(x => x.c), a.score));
          const share = Math.floor(pot.amount / winners.length);
          let rem = pot.amount - share * winners.length;
          winners.forEach(w => {
            const extra = rem > 0 ? 1 : 0;
            rem -= extra;
            w.stack += share + extra;
            w.won += share + extra;
          });
          h.pots.push({ amount: pot.amount, winners });
          const potName = pots.length === 1 ? '팟' : idx === 0 ? '메인 팟' : `사이드 팟 ${idx}`;
          const names = winners.map(w => w.name).join(', ');
          this.addLog(`${names}: ${potName} ${fmt(pot.amount)} 획득${winners.length > 1 ? ' (분할)' : ''} · ${winners[0].result}`, 'win');
        });
      }
      h.done = true;
      h.actingSeat = null;
    }

    /**
     * 칩이 0이 된 플레이어를 탈락 처리하고 순위를 매긴다. 같은 핸드에 여러 명이면 시작 스택이 컸던 사람이 상위.
     * @returns {void}
     */
    resolveBusts() {
      const out = this.players.filter(p => !p.busted && p.stack === 0).sort((a, b) => b.startStack - a.startStack);
      if (!out.length) return;
      let place = this.alive().length - out.length + 1;
      out.forEach(p => {
        p.busted = true;
        p.place = place++;
        this.addLog(`${p.name} 탈락 · ${p.place}위`, 'bust');
      });
    }
  }

  /**
   * AI 판단: 몬테카를로 승률을 상대 수로 정규화한 세기(strength)와 성향별 임계값으로 액션을 고른다.
   * 3구에서는 참가/스틸/레이즈 기준, 4구부터는 팟 오즈와 레이즈 기준을 쓴다.
   * @param {Tournament} t 토너먼트
   * @param {object} p AI 플레이어
   * @param {object[]} legal 가능한 액션
   * @returns {object} 고른 액션 (legal 중 하나)
   */
  function aiDecide(t, p, legal) {
    const h = t.hand;
    const P = p.persona || PERSONAS[2];
    const find = type => legal.find(a => a.type === type);
    const aggressive = find('raise') || find('complete') || find('bet');
    const passive = find('check') || find('call');
    const rnd = t.rng();
    const opps = t.live().filter(o => o !== p);
    const n = opps.length;
    const eq = estimateEquity(p.cards.map(x => x.c), opps.map(o => ({ up: t.upCards(o) })), h.deadUp, t.sims, t.rng);
    const strength = eq * (n + 1);
    const toCall = Math.max(0, h.currentBet - p.bet);
    const facing = Math.max(0, h.raises - (h.street === 3 ? 1 : 0));
    const adj = strength * (1 - P.respect * facing);
    const shortStack = p.stack <= h.unit * 2;
    if (find('bringin')) {
      return find('complete') && strength >= P.raise + 0.2 && rnd < P.aggr ? find('complete') : find('bringin');
    }
    if (toCall === 0) {
      const myUp = t.upCards(p);
      const scary = scoreCategory(evaluateShowing(myUp)) >= 1 || myUp.some(c => rankOf(c) >= 13) ||
        [0, 1, 2, 3].some(s => myUp.filter(c => suitOf(c) === s).length >= 3);
      if (aggressive && adj >= P.raise * 0.85 && rnd < Math.min(0.95, P.aggr + 0.25)) return aggressive;
      if (aggressive && n <= 2 && scary && rnd < P.bluff) return aggressive;
      return passive;
    }
    if (h.street === 3) {
      if (h.raises === 0) {
        const door = rankOf(p.cards[2].c);
        const callers = t.live().filter(o => o !== p && o.seat !== h.bringInSeat && o.bet > 0).length;
        const toAct = t.actors().filter(o => o !== p && (!o.acted || o.seat === h.bringInSeat));
        const stealSpot = callers === 0 && toAct.every(o => rankOf(o.cards[2].c) < door);
        if (aggressive && adj >= P.raise && rnd < P.aggr) return aggressive;
        if (aggressive && stealSpot && rnd < P.steal) return aggressive;
        if (adj >= P.enter || (shortStack && adj >= P.enter * 0.8)) return passive;
        return find('fold');
      }
      const need = P.enter + 0.12 * (h.raises - 1) - P.sticky * 0.5;
      if (aggressive && adj >= P.raise + 0.25 * (h.raises - 1) && rnd < P.aggr) return aggressive;
      if (adj >= need) return passive;
      return find('fold');
    }
    const potOdds = toCall / (t.potTotal() + toCall);
    if (aggressive && adj >= P.raise && rnd < P.aggr) return aggressive;
    const eqAdj = eq * (1 - P.respect * (h.raises + 1)) + P.sticky * 0.08;
    if (eqAdj >= potOdds) return passive;
    if (aggressive && n === 1 && rnd < P.bluff * 0.3) return aggressive;
    return find('fold');
  }

  /**
   * 연습 모드 힌트: 팟 오즈, 추정 승률, 내 숫자·무늬의 남은 장수, 다음 카드로 족보가 오르는 장수를 계산한다.
   * @param {Tournament} t 토너먼트
   * @param {object} p 플레이어 (사람)
   * @param {number} [sims=1200] 승률 시뮬레이션 횟수
   * @returns {object} 힌트 데이터
   */
  function analyze(t, p, sims) {
    const h = t.hand;
    const my = p.cards.map(x => x.c);
    const opps = t.live().filter(o => o !== p);
    const seen = new Set(my);
    t.players.forEach(o => { if (o !== p && o.inHand) t.upCards(o).forEach(c => seen.add(c)); });
    const eq = estimateEquity(my, opps.map(o => ({ up: t.upCards(o) })), h.deadUp, sims || 1200, Math.random);
    const toCall = Math.max(0, h.currentBet - p.bet);
    const pot = t.potTotal();
    const need = toCall > 0 ? toCall / (pot + toCall) : 0;
    const countSeen = fn => Array.from(seen).filter(c => my.indexOf(c) < 0 && fn(c)).length;
    const myRanks = Array.from(new Set(my.map(rankOf))).sort((a, b) => b - a);
    const ranks = myRanks.map(r => {
      const mine = my.filter(c => rankOf(c) === r).length;
      const out = countSeen(c => rankOf(c) === r);
      return { label: RANK_LABELS[r], mine, seen: out, left: 4 - mine - out };
    });
    const suits = [0, 1, 2, 3].map(s => {
      const mine = my.filter(c => suitOf(c) === s).length;
      const out = countSeen(c => suitOf(c) === s);
      return { symbol: SUIT_SYMBOLS[s], suit: s, mine, seen: out, left: 13 - mine - out };
    }).filter(x => x.mine >= 3);
    const current = evaluate(my);
    let improving = 0;
    let unseen = 0;
    if (my.length < 7) {
      const cat = scoreCategory(current);
      for (let c = 8; c < 60; c++) {
        if (seen.has(c)) continue;
        unseen++;
        if (scoreCategory(evaluate(my.concat([c]))) > cat) improving++;
      }
    }
    return {
      eq, toCall, pot, need, ranks, suits, improving, unseen,
      nextStreet: my.length < 7 ? (my.length === 6 ? STREET_NAMES[7] : STREET_NAMES[my.length + 1]) : null,
      current: describeScore(current), opponents: opps.length
    };
  }

  return {
    LEVELS, PERSONAS, SUIT_SYMBOLS, RANK_LABELS, HAND_NAMES, STREET_NAMES, STREET_EN, MAX_RAISE_LEVELS,
    rankOf, suitOf, cardLabel, fmt, makeRng, shuffle, newDeck, evaluate, evaluateShowing,
    describeScore, scoreCategory, estimateEquity, analyze, aiDecide, Tournament
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Stud;
