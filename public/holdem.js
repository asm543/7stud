/**
 * 노리밋 텍사스 홀덤 토너먼트 엔진 (WSOP 메인 이벤트 방식 · TDA 룰)
 * DOM에 의존하지 않는 순수 게임 로직으로, 브라우저와 Node 양쪽에서 동작한다. 족보 평가·덱·난수는 7스터드 엔진(Stud)을 그대로 쓴다.
 * 구성 요소
 *  - 레벨 구조: 스몰/빅 블라인드 + 빅블라인드 앤티(BBA, 빅블라인드를 먼저 채우고 남는 칩으로 앤티, 앤티는 줄이지 않음)
 *  - Tournament: 데드 버튼 규칙의 버튼·블라인드 이동, 헤즈업 규칙, 노리밋 베팅(최소 레이즈 = 직전 풀 레이즈,
 *    숏 올인은 이미 액션한 사람에게 레이즈를 다시 열지 않음, 여러 숏 올인이 합쳐 풀 레이즈 이상이면 다시 열림),
 *    콜 받지 못한 베트 반환, 사이드팟, 올인 시 카드 공개, 남는 칩은 버튼 왼쪽 가까운 승자에게
 *  - 프리플랍 169개 핸드 순위표(scripts/gen-preflop.js로 생성)와 레인지 표본 추출
 *  - AI 판단: 7스터드와 같은 10가지 스타일 + 사람 같은 상태(손읽기, 상대 적응, 틸트, 이미지, 기어, 스택·버블 압박, 실수, 채팅)
 *  - 연습 모드 힌트(analyze)
 */
const Holdem = (() => {
  const S = typeof Stud !== 'undefined' ? Stud : require('./engine.js');
  const { evaluate, scoreCategory, scoreRanks, describeScore, cardLabel, fmt, shuffle, newDeck, rankOf, suitOf, makeRng } = S;

  const STREETS = ['프리플랍', '플랍', '턴', '리버'];
  const STREETS_EN = ['Preflop', 'Flop', 'Turn', 'River'];
  const STARTING_STACK = 20000;
  const MAX_SEATS = 9;
  const RANK_CHARS = '23456789TJQKA';
  const RANGE_EPS = 0.08;

  const LEVELS = [
    { sb: 100, bb: 200, ante: 200 },
    { sb: 200, bb: 300, ante: 300 },
    { sb: 200, bb: 400, ante: 400 },
    { sb: 300, bb: 600, ante: 600 },
    { sb: 400, bb: 800, ante: 800 },
    { sb: 500, bb: 1000, ante: 1000 },
    { sb: 600, bb: 1200, ante: 1200 },
    { sb: 800, bb: 1600, ante: 1600 },
    { sb: 1000, bb: 2000, ante: 2000 },
    { sb: 1500, bb: 3000, ante: 3000 },
    { sb: 2000, bb: 4000, ante: 4000 },
    { sb: 2500, bb: 5000, ante: 5000 },
    { sb: 3000, bb: 6000, ante: 6000 },
    { sb: 4000, bb: 8000, ante: 8000 },
    { sb: 5000, bb: 10000, ante: 10000 },
    { sb: 6000, bb: 12000, ante: 12000 },
    { sb: 8000, bb: 16000, ante: 16000 },
    { sb: 10000, bb: 20000, ante: 20000 },
    { sb: 15000, bb: 30000, ante: 30000 },
    { sb: 20000, bb: 40000, ante: 40000 }
  ];

  const PREFLOP_ORDER = 'AA KK QQ JJ TT 99 AKs 88 AKo AQs AJs KQs ATs AQo 77 KJs AJo KTs ATo KQo A9s KJo QJs A8s QTs 66 KTo K9s A7s A6s JTs A9o A5s QJo A8o A4s A3s Q9s QTo 55 K8s K9o A7o K7s T9s J9s A2s K6s Q8s JTo A5o K5s Q9o A6o 44 K4s J8s K8o A4o T8s A3o K7o A2o Q7s Q6s K2s J9o Q5s K3s Q8o K6o J7s T9o 98s Q4s T7s 33 K5o Q3s J8o 97s K4o J6s Q7o Q2s T8o Q6o K3o 98o 87s T6s J5s J7o J4s 96s J3s 22 K2o 86s T7o Q5o J2s 76s 95s Q4o T5s J6o 97o T4s 87o T3s 75s Q3o T6o 85s 65s Q2o J5o J4o 94s T2s 96o 54s 74s 84s T5o 93s 76o J3o 86o 64s 92s 95o T4o J2o T3o 83s 85o 82s 73s 53s 65o 75o T2o 63s 43s 94o 84o 52s 74o 93o 54o 72s 42s 62s 92o 64o 83o 32s 82o 53o 73o 63o 43o 52o 72o 62o 42o 32o';

  const OPEN_BASE = [0.42, 0.4, 0.42, 0.27, 0.2, 0.16, 0.135, 0.12, 0.11, 0.1];
  const PUSH_BASE = [0.62, 0.62, 0.42, 0.3, 0.22, 0.17, 0.14, 0.12, 0.11, 0.1];

  const NL_TRAITS = {
    rock: { open: 0.65, limp: 0, call: 0.6, threeBet: 0.7, cbet: 0.45, size: 0.95 },
    weakTight: { open: 0.85, limp: 0.12, call: 0.85, threeBet: 0.5, cbet: 0.35, size: 0.85 },
    tag: { open: 1.0, limp: 0, call: 0.8, threeBet: 1.0, cbet: 0.65, size: 1.0 },
    solid: { open: 1.05, limp: 0, call: 0.95, threeBet: 1.1, cbet: 0.6, size: 1.0 },
    lag: { open: 1.45, limp: 0, call: 1.1, threeBet: 1.5, cbet: 0.75, size: 1.1 },
    maniac: { open: 2.3, limp: 0.05, call: 1.4, threeBet: 2.4, cbet: 0.9, size: 1.3 },
    station: { open: 0.8, limp: 0.75, call: 1.9, threeBet: 0.4, cbet: 0.25, size: 0.8 },
    fish: { open: 0.9, limp: 0.6, call: 1.7, threeBet: 0.5, cbet: 0.3, size: 0.9 },
    trapper: { open: 0.95, limp: 0.1, call: 1.0, threeBet: 0.7, cbet: 0.5, size: 1.0,
      desc: '아주 강한 패는 프리플랍·플랍에서 콜로 숨겼다가 턴·리버에 레이즈한다' },
    thief: { open: 0.85, limp: 0, call: 0.7, threeBet: 0.8, cbet: 0.7, size: 0.95, label: '블라인드 도둑',
      desc: '버튼·컷오프에서 블라인드 스틸을 자주 하고, 잘 접는 블라인드를 노린다. 저항을 받으면 물러난다' }
  };
  const STYLES = S.STYLES.map(s => Object.assign({}, s, NL_TRAITS[s.id] || NL_TRAITS.tag));
  const TALK = Object.assign({}, S.TALK, {
    badBeat: ['와… 리버 실화냐', '그게 들어오네', '하…', '러너러너?', '이걸 지네'],
    caught: ['ㅋㅋ 들켰네', '아 그걸 콜하네…', '블러프 실패']
  });

  const CLASS_PCT = new Map();
  const COMBOS = [];

  /**
   * 순위표에서 핸드 종류별 백분위와, 백분위 순으로 정렬된 1326개 조합 목록을 만든다 (모듈 로드 시 1회).
   * 백분위는 그 종류까지 누적 조합 수의 중간값 ÷ 1326 (0에 가까울수록 강함).
   * @returns {void}
   */
  function buildPreflopTables() {
    const order = PREFLOP_ORDER.split(' ');
    let cum = 0;
    order.forEach(name => {
      const n = name.length === 2 ? 6 : name[2] === 's' ? 4 : 12;
      CLASS_PCT.set(name, (cum + n / 2) / 1326);
      cum += n;
    });
    for (let a = 8; a < 60; a++) {
      for (let b = a + 1; b < 60; b++) COMBOS.push({ a, b, pct: CLASS_PCT.get(classOf(a, b)) });
    }
    COMBOS.sort((x, y) => x.pct - y.pct);
  }

  /**
   * 카드 두 장의 핸드 종류 이름을 만든다.
   * @param {number} a 카드 정수
   * @param {number} b 카드 정수
   * @returns {string} 예: 'AKs', 'T9o', '77'
   */
  function classOf(a, b) {
    const ra = rankOf(a);
    const rb = rankOf(b);
    const hi = Math.max(ra, rb);
    const lo = Math.min(ra, rb);
    const name = RANK_CHARS[hi - 2] + RANK_CHARS[lo - 2];
    if (hi === lo) return name;
    return name + (suitOf(a) === suitOf(b) ? 's' : 'o');
  }

  /**
   * 카드 두 장이 전체 핸드 중 상위 몇 %인지 돌려준다.
   * @param {number[]} hole 카드 두 장
   * @returns {number} 0~1 (작을수록 강함)
   */
  function handPct(hole) {
    return CLASS_PCT.get(classOf(hole[0], hole[1]));
  }

  /**
   * 레벨 구조를 사람이 읽는 문장으로 만든다.
   * @param {{sb:number,bb:number,ante:number}} L 레벨
   * @returns {string} 예: '블라인드 100/200 · BB 앤티 200'
   */
  function levelText(L) {
    return `블라인드 ${fmt(L.sb)}/${fmt(L.bb)} · BB 앤티 ${fmt(L.ante)}`;
  }

  /**
   * 공개 행동 통계의 빈 값.
   * @returns {object} 통계 (hands, vpip, pfr, tbOpp, tb, stealOpp, steal, ftsOpp, fts, agg, pas, ftbOpp, ftb, cbOpp, cb, sd, bluffsShown)
   */
  function newStats() {
    return { hands: 0, vpip: 0, pfr: 0, tbOpp: 0, tb: 0, stealOpp: 0, steal: 0, ftsOpp: 0, fts: 0, agg: 0, pas: 0, ftbOpp: 0, ftb: 0, cbOpp: 0, cb: 0, sd: 0, bluffsShown: 0 };
  }

  /**
   * 컴퓨터 한 명의 사람 같은 상태 (틸트 0~1, 이미지 -1~1, 기어 -1/0/1과 남은 핸드).
   * @param {function(): number} rng 난수 함수
   * @returns {object} 상태
   */
  function newMind(rng) {
    return { tilt: 0, image: 0, gear: 0, gearLeft: 6 + Math.floor(rng() * 10) };
  }

  /**
   * 플레이어 스타일에 기본값을 채워 돌려준다.
   * @param {object} p 플레이어
   * @returns {object} 스타일 값
   */
  function styleOf(p) {
    return Object.assign({ slowplay: 0, semibluff: 0, chase: 0, focus: 0.97, tiltProne: 0.4, recover: 0.18, shift: 0, adapt: 0.5, icm: 0.8, talk: 0.15 }, p.persona || STYLES[2]);
  }

  /**
   * 표본이 적을 때 사전값 쪽으로 당긴 비율 (베이지안 평활).
   * @param {number} x 횟수
   * @param {number} n 기회 수
   * @param {number} prior 사전 비율
   * @param {number} k 사전 표본 크기
   * @returns {number} 평활된 비율
   */
  function rate(x, n, prior, k) {
    return (x + prior * k) / (n + k);
  }

  /**
   * 값을 범위 안으로 자른다.
   * @param {number} v 값
   * @param {number} lo 최솟값
   * @param {number} hi 최댓값
   * @returns {number} 잘린 값
   */
  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  /**
   * 홀카드가 보드와 어울려 만든 패의 단계를 매긴다 (보드만으로 된 족보는 치지 않음).
   * 0 없음 · 1 약한 페어(보드 최고 숫자 아래) · 2 탑 페어/오버페어 · 3 투페어·트리플 · 4 스트레이트 이상
   * @param {number[]} hole 카드 두 장
   * @param {number[]} board 보드 3~5장
   * @returns {number} 0~4
   */
  function madeLevel(hole, board) {
    const full = evaluate(hole.concat(board));
    const bScore = evaluate(board);
    const cat = scoreCategory(full);
    const bcat = scoreCategory(bScore);
    const top = Math.max(...board.map(rankOf));
    if (cat >= 4) return cat > bcat ? 4 : 1;
    if (cat === 3) return bcat === 3 ? 0 : 3;
    if (cat === 2) {
      if (bcat === 2) return 0;
      if (bcat === 0) return 3;
      const bp = scoreRanks(bScore)[0];
      const fr = scoreRanks(full);
      const mine = fr[0] === bp ? fr[1] : fr[0];
      return mine >= top ? 2 : 1;
    }
    if (cat === 1) {
      if (bcat === 1) return 0;
      return scoreRanks(full)[0] >= top ? 2 : 1;
    }
    return 0;
  }

  /**
   * 아직 카드가 남은 스트리트에서 드로우의 세기를 매긴다 (홀카드가 한 장 이상 관여한 것만).
   * 0 없음 · 1 거트샷·백도어급 · 2 플러시 드로우 또는 양방향 스트레이트 드로우 · 3 둘 다(콤보 드로우)
   * @param {number[]} hole 카드 두 장
   * @param {number[]} board 보드 3~4장
   * @returns {number} 0~3
   */
  function drawLevel(hole, board) {
    if (board.length >= 5) return 0;
    const all = hole.concat(board);
    let fd = false;
    for (let s = 0; s < 4; s++) {
      const n = all.filter(c => suitOf(c) === s).length;
      if (n === 4 && hole.some(c => suitOf(c) === s)) fd = true;
    }
    const maskOf = cards => {
      let m = 0;
      cards.forEach(c => { m |= 1 << rankOf(c); });
      if (m & (1 << 14)) m |= 2;
      return m;
    };
    const m = maskOf(all);
    const bm = maskOf(board);
    let oesd = false;
    let gut = false;
    for (let lo = 1; lo <= 10; lo++) {
      const win = ((1 << 5) - 1) << lo;
      const k = popcount(m & win);
      if (k === 4 && popcount(bm & win) < 4) {
        const inner = ((1 << 4) - 1) << lo;
        const inner2 = ((1 << 4) - 1) << (lo + 1);
        if (popcount(m & inner) === 4 || popcount(m & inner2) === 4) oesd = true;
        else gut = true;
      }
    }
    if (scoreCategory(evaluate(all)) >= 4) return 0;
    if (fd && (oesd || gut)) return 3;
    if (fd || oesd) return 2;
    return gut ? 1 : 0;
  }

  /**
   * 보드가 얼마나 연결돼 있는지 매긴다 (컨티뉴에이션 베트 빈도 조절용).
   * 같은 무늬 2장 이상이면 +1, 서로 다른 숫자 두 장이 3칸 이내로 붙어 있으면 +1.
   * @param {number[]} board 보드 카드
   * @returns {number} 0 마른 보드 ~ 2 젖은 보드
   */
  function wetness(board) {
    const sc = [0, 0, 0, 0];
    board.forEach(c => { sc[suitOf(c)]++; });
    const rs = Array.from(new Set(board.map(rankOf)));
    if (rs.indexOf(14) >= 0) rs.push(1);
    const close = rs.some((a, i) => rs.some((b, j) => i !== j && Math.abs(a - b) <= 3));
    return (Math.max(...sc) >= 2 ? 1 : 0) + (close ? 1 : 0);
  }

  /**
   * 비트 개수를 센다.
   * @param {number} x 정수
   * @returns {number} 켜진 비트 수
   */
  function popcount(x) {
    let n = 0;
    let v = x;
    while (v) {
      v &= v - 1;
      n++;
    }
    return n;
  }

  /**
   * 토너먼트 한 개를 진행하는 클래스.
   * 내부 요소
   *  - players: 좌석 순으로 정렬된 플레이어 (stack, hole, bet, contrib, folded, allIn, busted, place, st 통계, mind 상태 ...)
   *  - hand: 현재 핸드 상태 (street 0~3, board, buttonSeat/sbSeat/bbSeat, currentBet, minRaise, raises, dead(앤티), pots ...)
   *  - prevBB / prevSB: 데드 버튼 규칙을 위한 직전 핸드의 블라인드 좌석
   *  - ctl: 화면 쪽 컨트롤러 (onEvent, wait, humanAction, afterHand)
   *  - log: 핸드 기록
   */
  class Tournament {
    /**
     * 토너먼트를 만든다.
     * @param {object} opts 설정
     * @param {{name:string,isHuman?:boolean,persona?:object}[]} opts.players 참가자 (최대 9명)
     * @param {object} opts.controller 화면 컨트롤러
     * @param {number} [opts.handsPerLevel=10] 레벨업 간격(핸드 수)
     * @param {number} [opts.startingStack=20000] 시작 스택
     * @param {number} [opts.sims=120] AI 승률 추정 시뮬레이션 횟수
     * @param {function(): number} [opts.rng] 난수 함수
     * @param {number} [opts.paidPlaces] 입상 인원 (버블 판단용)
     * @param {function(number): number[]} [opts.deckFactory] 핸드 번호로 덱을 만드는 함수 (테스트용, pop 순서로 딜)
     */
    constructor(opts) {
      this.rng = opts.rng || Math.random;
      this.deckFactory = opts.deckFactory || null;
      this.ctl = opts.controller;
      this.handsPerLevel = opts.handsPerLevel || 10;
      this.startingStack = opts.startingStack || STARTING_STACK;
      this.sims = opts.sims || 120;
      const n = opts.players.length;
      this.paidPlaces = opts.paidPlaces || (n >= 6 ? 3 : n >= 4 ? 2 : 1);
      this.handNo = 0;
      this.hand = null;
      this.log = [];
      this.finished = false;
      this.prevBB = null;
      this.prevSB = null;
      const seats = shuffle(Array.from({ length: n }, (_, i) => i + 1), this.rng);
      this.players = opts.players.map((p, i) => ({
        id: i,
        name: p.name,
        isHuman: !!p.isHuman,
        persona: p.persona || null,
        seat: seats[i],
        stack: this.startingStack,
        busted: false,
        place: null,
        hole: [],
        bet: 0,
        contrib: 0,
        folded: true,
        allIn: false,
        inHand: false,
        st: newStats(),
        mind: p.persona ? newMind(this.rng) : null
      }));
      this.players.sort((a, b) => a.seat - b.seat);
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
     * 현재 레벨 구조(블라인드·앤티)를 돌려준다.
     * @returns {{sb:number,bb:number,ante:number}} 레벨 구조
     */
    get level() {
      return LEVELS[this.levelIndex()];
    }

    /**
     * 탈락하지 않은 플레이어 목록 (좌석 순).
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
     * 이번 핸드의 총 팟 (베팅 기여 + 앤티).
     * @returns {number} 팟 크기
     */
    potTotal() {
      return this.players.reduce((a, p) => a + p.contrib, 0) + (this.hand ? this.hand.dead : 0);
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
      if (this.log.length > 800) this.log.splice(0, this.log.length - 800);
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
          this.addLog(`레벨 ${this.levelIndex() + 1} 시작 · ${levelText(this.level)}`, 'level');
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
     * 칩을 팟에 넣는다. 블라인드·베트는 베팅 기여(contrib)로, 앤티는 누구의 몫도 아닌 데드 머니로 들어간다.
     * @param {object} p 플레이어
     * @param {number} amount 넣을 금액
     * @param {boolean} isBet 베팅 여부 (앤티는 false)
     * @returns {number} 실제로 넣은 금액
     */
    commit(p, amount, isBet) {
      const amt = Math.max(0, Math.min(amount, p.stack));
      p.stack -= amt;
      if (isBet) {
        p.contrib += amt;
        p.bet += amt;
      } else {
        this.hand.dead += amt;
        p.antePaid = (p.antePaid || 0) + amt;
      }
      if (p.stack === 0) p.allIn = true;
      return amt;
    }

    /**
     * 살아 있는 좌석 중 지정 좌석 다음(시계방향)을 찾는다. 지정 좌석은 비어 있어도 된다(데드 버튼·데드 블라인드).
     * @param {number} seat 기준 좌석 번호
     * @param {object[]} [pool] 대상 플레이어 (기본: 탈락하지 않은 사람)
     * @returns {object} 다음 플레이어
     */
    nextAfter(seat, pool) {
      const ps = pool || this.alive();
      return ps.find(p => p.seat > seat) || ps[0];
    }

    /**
     * 이번 핸드의 버튼·스몰·빅 블라인드 좌석을 정한다 (데드 버튼 규칙).
     * 빅블라인드는 항상 직전 빅블라인드 다음 사람으로 한 칸씩 움직이고, 직전 빅블라인드 자리가 스몰블라인드(탈락했으면 데드 스몰),
     * 직전 스몰블라인드 자리가 버튼(탈락했으면 데드 버튼)이 된다. 헤즈업은 버튼이 스몰블라인드이고, 같은 사람이 빅블라인드를 두 번 연속 내지 않게 맞춘다.
     * @returns {{button:number, sb:number, bb:number}} 좌석 번호
     */
    assignPositions() {
      const alive = this.alive();
      let button;
      let sb;
      let bb;
      if (this.prevBB === null) {
        button = alive[Math.floor(this.rng() * alive.length)].seat;
        sb = alive.length === 2 ? button : this.nextAfter(button).seat;
        bb = this.nextAfter(sb).seat;
      } else if (alive.length === 2) {
        bb = this.nextAfter(this.prevBB).seat;
        sb = alive.find(p => p.seat !== bb).seat;
        button = sb;
      } else {
        bb = this.nextAfter(this.prevBB).seat;
        sb = this.prevBB;
        button = this.prevSB;
      }
      this.prevBB = bb;
      this.prevSB = sb;
      return { button, sb, bb };
    }

    /**
     * 좌석 번호의 플레이어 (이번 핸드 참가자만).
     * @param {number} seat 좌석 번호
     * @returns {object|undefined} 플레이어
     */
    playerAt(seat) {
      return this.players.find(p => p.seat === seat && p.inHand);
    }

    /**
     * 지정 좌석 다음부터 시계방향으로 이번 핸드 참가자를 나열한다.
     * @param {number} seat 기준 좌석 (이 좌석 다음 사람부터)
     * @returns {object[]} 순서대로의 플레이어
     */
    orderAfter(seat) {
      const ps = this.players.filter(p => p.inHand);
      const idx = ps.findIndex(p => p.seat > seat);
      const k = idx < 0 ? 0 : idx;
      return ps.slice(k).concat(ps.slice(0, k));
    }

    /**
     * 핸드 하나를 진행한다: 블라인드·BB 앤티 → 홀카드 2장 → 프리플랍 → 플랍 → 턴 → 리버 → 쇼다운/정산.
     * @returns {Promise<void>} 핸드가 끝나면 끝나는 Promise
     */
    async playHand() {
      const L = this.level;
      const deck = this.deckFactory ? this.deckFactory(this.handNo) : newDeck(this.rng);
      this.players.forEach(p => {
        Object.assign(p, {
          hole: [], bet: 0, contrib: 0, antePaid: 0, allIn: false, acted: false, facedAt: 0,
          lastAction: '', shown: false, result: '', won: 0, refund: 0, score: 0,
          inHand: !p.busted, folded: p.busted, startStack: p.stack,
          handAgg: 0, postAgg: 0, postCalls: 0, vpipHand: false, pfrHand: false, rangeW: 1, allInEq: undefined
        });
      });
      this.beginHandMinds();
      const pos = this.assignPositions();
      this.hand = {
        no: this.handNo, levelIndex: this.levelIndex(), deck, street: 0, board: [],
        buttonSeat: pos.button, sbSeat: pos.sb, bbSeat: pos.bb,
        currentBet: 0, minRaise: L.bb, raises: 0, limpers: 0, actingSeat: null, dead: 0,
        pots: [], showdown: false, runout: false, done: false, lastAgg: {}, pfAggressor: null, stealer: null
      };
      const h = this.hand;
      const btnP = this.playerAt(pos.button);
      this.addLog(`핸드 #${this.handNo} · 레벨 ${this.levelIndex() + 1} (${levelText(L)})`, 'head');
      const sbP = this.playerAt(pos.sb);
      const bbP = this.playerAt(pos.bb);
      const parts = [`버튼 ${btnP ? btnP.name : `S${pos.button} (빈자리)`}`];
      if (sbP) {
        const amt = this.commit(sbP, L.sb, true);
        sbP.lastAction = `SB ${fmt(amt)}`;
        parts.push(`SB ${sbP.name} ${fmt(amt)}${sbP.allIn ? ' (올인)' : ''}`);
      } else {
        parts.push('SB 없음 (데드 스몰)');
      }
      const bAmt = this.commit(bbP, L.bb, true);
      const aAmt = this.commit(bbP, L.ante, false);
      bbP.lastAction = `BB ${fmt(bAmt)}`;
      parts.push(`BB ${bbP.name} ${fmt(bAmt)} + 앤티 ${fmt(aAmt)}${bbP.allIn ? ' (올인)' : ''}`);
      this.addLog(parts.join(' · '), 'street');
      h.currentBet = L.bb;
      const dealOrder = this.orderAfter(pos.button);
      for (let r = 0; r < 2; r++) dealOrder.forEach(p => p.hole.push(deck.pop()));
      this.emit('deal');
      if (this.live().length > 1 && this.actors().length >= 1) await this.bettingRound(0);
      for (let street = 1; street <= 3; street++) {
        if (this.live().length <= 1) break;
        h.street = street;
        deck.pop();
        const add = street === 1 ? 3 : 1;
        for (let i = 0; i < add; i++) h.board.push(deck.pop());
        this.players.forEach(p => { p.bet = 0; if (!p.folded) p.lastAction = ''; });
        const boardText = h.board.map(cardLabel).join(' ');
        if (this.actors().length >= 2) {
          this.emit('deal');
          await this.bettingRound(street);
        } else {
          if (!h.runout) {
            h.runout = true;
            this.noteAllInEquity();
            this.live().forEach(p => { p.shown = true; });
            this.addLog(`올인 · 카드 공개: ${this.live().map(p => `${p.name} ${p.hole.map(cardLabel).join(' ')}`).join(' / ')}`, 'street');
          }
          this.addLog(`${STREETS[street]} [${boardText}] (런아웃)`, 'street');
          this.emit('deal');
          await this.ctl.wait(null, this, 'runout');
        }
      }
      this.settle();
      this.emit('settle');
    }

    /**
     * 한 스트리트의 베팅 라운드를 진행한다. 프리플랍은 빅블라인드 다음 사람부터(헤즈업은 버튼=스몰부터),
     * 플랍부터는 버튼 다음 사람부터 액션한다.
     * @param {number} street 0 프리플랍 ~ 3 리버
     * @returns {Promise<void>} 라운드가 끝나면 끝나는 Promise
     */
    async bettingRound(street) {
      const h = this.hand;
      const L = this.level;
      h.street = street;
      h.raises = 0;
      if (street > 0) {
        h.currentBet = 0;
        h.minRaise = L.bb;
        this.addLog(`${STREETS[street]} [${h.board.map(cardLabel).join(' ')}] · 팟 ${fmt(this.potTotal())}`, 'street');
      }
      this.players.forEach(p => { p.acted = false; p.facedAt = 0; });
      const order = street === 0 ? this.orderAfter(h.bbSeat) : this.orderAfter(h.buttonSeat);
      let i = 0;
      let guard = 0;
      while (this.live().length > 1) {
        const actors = this.actors();
        const pending = actors.filter(p => !p.acted || p.bet < h.currentBet);
        if (!pending.length) break;
        if (actors.length === 1 && actors[0].bet >= h.currentBet) break;
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
        if (++guard > 500) throw new Error('betting loop guard');
      }
    }

    /**
     * 이미 액션한 사람이 다시 레이즈할 수 있는지: 액션 뒤로 풀 레이즈 이상(여러 숏 올인 합산 포함)을 마주했을 때만.
     * @param {object} p 플레이어
     * @returns {boolean} 레이즈 가능 여부
     */
    mayRaise(p) {
      const h = this.hand;
      return !p.acted || h.currentBet - p.facedAt >= h.minRaise;
    }

    /**
     * 플레이어가 지금 할 수 있는 액션 목록을 만든다.
     * 베트/레이즈는 min~max(올인) 범위를 가지며, 스택이 최소 레이즈보다 적으면 올인 한 가지 금액만 된다.
     * @param {object} p 플레이어
     * @returns {{type:string,amount?:number,to?:number,min?:number,max?:number,allIn?:boolean}[]} 가능한 액션
     */
    legalActions(p) {
      const h = this.hand;
      const toCall = Math.max(0, h.currentBet - p.bet);
      const others = this.actors().filter(o => o !== p).length;
      const maxTo = p.bet + p.stack;
      const canRaise = this.mayRaise(p) && others > 0 && p.stack > toCall;
      const minTo = Math.min(h.currentBet + h.minRaise, maxTo);
      const raise = type => ({ type, min: minTo, max: maxTo, to: minTo, amount: minTo - p.bet, allIn: minTo === maxTo });
      const acts = [];
      if (toCall === 0) {
        acts.push({ type: 'check' });
        if (canRaise) acts.push(raise(h.currentBet === 0 ? 'bet' : 'raise'));
      } else {
        acts.push({ type: 'fold' });
        const callAmt = Math.min(toCall, p.stack);
        acts.push({ type: 'call', amount: callAmt, to: p.bet + callAmt, allIn: callAmt === p.stack });
        if (canRaise) acts.push(raise('raise'));
      }
      return acts;
    }

    /**
     * 액션을 적용하고 기록을 남긴다. 풀 레이즈는 최소 레이즈 크기를 바꾸고 모두에게 액션을 다시 연다.
     * 풀 레이즈보다 적은 올인은 현재 베트만 올리고, 이미 액션한 사람의 레이즈 권한은 mayRaise()가 판단한다.
     * @param {object} p 플레이어
     * @param {{type:string,to?:number}} a 액션
     * @returns {void}
     */
    applyAction(p, a) {
      const h = this.hand;
      const allInTag = () => (p.allIn ? ' (올인)' : '');
      this.recordStats(p, a);
      if (a.type === 'fold') {
        p.folded = true;
        p.acted = true;
        p.lastAction = 'Fold';
        this.addLog(`${p.name}: fold`);
      } else if (a.type === 'check') {
        p.acted = true;
        p.facedAt = h.currentBet;
        p.lastAction = 'Check';
        this.addLog(`${p.name}: check`);
      } else if (a.type === 'call') {
        const amt = this.commit(p, h.currentBet - p.bet, true);
        p.acted = true;
        p.facedAt = h.currentBet;
        if (h.street === 0 && h.raises === 0) h.limpers++;
        if (h.street > 0) p.postCalls++;
        p.lastAction = p.allIn ? `All-in ${fmt(p.bet)}` : `Call ${fmt(amt)}`;
        this.addLog(`${p.name}: call ${fmt(amt)}${allInTag()}`);
      } else {
        const maxTo = p.bet + p.stack;
        const minTo = Math.min(h.currentBet + h.minRaise, maxTo);
        const to = clamp(Math.round(a.to || minTo), minTo, maxTo);
        const prev = h.currentBet;
        this.commit(p, to - p.bet, true);
        const size = p.bet - prev;
        if (size >= h.minRaise) {
          h.minRaise = size;
          h.raises++;
          this.players.forEach(o => { if (o !== p) o.acted = false; });
        }
        if (p.bet > h.currentBet) h.currentBet = p.bet;
        p.acted = true;
        p.facedAt = h.currentBet;
        p.handAgg++;
        if (h.street > 0) p.postAgg++;
        h.lastAgg[h.street] = p.id;
        if (h.street === 0) h.pfAggressor = p.id;
        const word = p.allIn ? 'All-in' : prev === 0 ? 'Bet' : 'Raise';
        p.lastAction = `${word} ${fmt(p.bet)}`;
        this.addLog(`${p.name}: ${prev === 0 ? 'bet' : 'raise →'} ${fmt(p.bet)}${allInTag()}`);
      }
    }

    /**
     * 프리플랍에서 이 플레이어 뒤에 아직 액션이 남은(폴드 안 한) 사람 수. 블라인드까지 포함한다.
     * @param {object} p 플레이어
     * @returns {number} 뒤에 남은 사람 수
     */
    behind(p) {
      const order = this.orderAfter(this.hand.bbSeat);
      const idx = order.indexOf(p);
      return order.slice(idx + 1).filter(o => !o.folded && !o.allIn).length;
    }

    /**
     * 이 플레이어가 플랍 이후 남은 사람 중 가장 늦게 액션하는지(포지션 우위).
     * @param {object} p 플레이어
     * @returns {boolean} 인 포지션 여부
     */
    inPosition(p) {
      const live = this.orderAfter(this.hand.buttonSeat).filter(o => o.inHand && !o.folded);
      return live[live.length - 1] === p;
    }

    /**
     * 스틸 자리인지: 프리플랍에 아무도 들어오지 않았고, 뒤에 블라인드 포함 3명 이하만 남음(컷오프·버튼·스몰).
     * @param {object} p 플레이어
     * @returns {boolean} 스틸 자리 여부
     */
    isStealSpot(p) {
      const h = this.hand;
      if (h.street !== 0 || h.raises !== 0 || h.limpers !== 0 || p.seat === h.bbSeat) return false;
      return this.behind(p) <= 3;
    }

    /**
     * 모두가 볼 수 있는 행동 통계를 쌓는다 (컴퓨터들이 상대 습관을 읽는 데 씀, 사람도 포함).
     * 프리플랍: 참가·레이즈, 3벳 기회와 시도, 스틸 시도, 블라인드의 스틸 폴드. 플랍 이후: 공격/콜, 베트에 대한 폴드, 컨티뉴에이션 베트.
     * 이어서 상대가 보는 이 사람의 프리플랍 레인지 폭(rangeW)을 행동에 맞춰 좁힌다.
     * @param {object} p 액션하는 플레이어
     * @param {{type:string,to?:number}} a 액션 (적용 전 상태 기준으로 기록)
     * @returns {void}
     */
    recordStats(p, a) {
      const h = this.hand;
      const st = p.st;
      const toCall = Math.max(0, h.currentBet - p.bet);
      const aggressive = a.type === 'bet' || a.type === 'raise';
      if (h.street === 0) {
        if (a.type === 'call' || aggressive) p.vpipHand = true;
        if (aggressive) p.pfrHand = true;
        if (this.isStealSpot(p)) {
          st.stealOpp++;
          if (aggressive) {
            st.steal++;
            h.stealer = p.id;
          }
        } else if (h.stealer !== null && h.stealer !== p.id && h.raises === 1 && (p.seat === h.sbSeat || p.seat === h.bbSeat)) {
          st.ftsOpp++;
          if (a.type === 'fold') st.fts++;
        }
        if (h.raises === 1 && toCall > 0) {
          st.tbOpp++;
          if (aggressive) st.tb++;
        }
        this.narrowRange(p, a);
      } else {
        if (aggressive) st.agg++;
        else if (a.type === 'call') st.pas++;
        if (toCall > 0) {
          st.ftbOpp++;
          if (a.type === 'fold') st.ftb++;
        }
        if (h.street === 1 && h.pfAggressor === p.id && h.raises === 0) {
          st.cbOpp++;
          if (aggressive) st.cb++;
        }
      }
    }

    /**
     * 프리플랍 행동으로 상대가 짐작할 이 사람의 레인지 폭(상위 몇 %)을 갱신한다. 공개 통계만 쓴다.
     * 오픈 레이즈는 평소 레이즈 비율 × 포지션, 3벳·4벳은 평소 3벳 비율, 콜·림프는 평소 참가율, 짧은 스택 올인은 넓게.
     * @param {object} p 플레이어
     * @param {{type:string,to?:number}} a 액션
     * @returns {void}
     */
    narrowRange(p, a) {
      const h = this.hand;
      const st = p.st;
      const bb = this.level.bb;
      const vpip = rate(st.vpip, st.hands, 0.28, 12);
      const pfr = rate(st.pfr, st.hands, 0.16, 12);
      const heads = this.alive().length === 2;
      let w = p.rangeW;
      if (a.type === 'bet' || a.type === 'raise') {
        if (h.raises === 0) {
          const beh = this.behind(p);
          const posMul = heads ? 3 : beh >= 6 ? 0.6 : beh >= 4 ? 0.85 : beh === 3 ? 1.1 : 1.6;
          w = clamp(pfr * posMul, 0.04, 0.85);
        } else if (h.raises === 1) {
          w = clamp(rate(st.tb, st.tbOpp, 0.07, 10) * (heads ? 2 : 1), 0.025, 0.4);
        } else {
          w = clamp(rate(st.tb, st.tbOpp, 0.07, 10) * 0.45, 0.015, 0.25);
        }
        const stackBB = (p.stack + p.bet) / bb;
        if ((a.to || 0) >= p.bet + p.stack && stackBB <= 15) w = Math.max(w, clamp(pfr * 1.8 * Math.pow(10 / Math.max(stackBB, 2), 0.6), 0.08, 0.9));
      } else if (a.type === 'call') {
        w = h.raises === 0 ? clamp(vpip * 1.15, 0.1, 0.9) : clamp(vpip * (heads ? 1.4 : 0.9), 0.06, 0.85);
      } else {
        return;
      }
      p.rangeW = Math.min(p.rangeW, w);
    }

    /**
     * 핸드 시작 시 사람 같은 상태를 갱신한다: 핸드별 표시 초기화, 틸트·이미지 회복, 기어 변속.
     * @returns {void}
     */
    beginHandMinds() {
      this.players.forEach(p => {
        if (!p.inHand) return;
        p.st.hands++;
        const m = p.mind;
        if (!m) return;
        const P = styleOf(p);
        m.tilt *= 1 - P.recover;
        if (m.tilt < 0.03) m.tilt = 0;
        m.image *= 0.88;
        if (P.shift > 0 && --m.gearLeft <= 0) {
          const r = this.rng();
          m.gear = r < P.shift / 2 ? -1 : r < P.shift ? 1 : 0;
          m.gearLeft = 10 + Math.floor(this.rng() * 10);
        }
      });
    }

    /**
     * 핸드가 끝난 뒤 사람처럼 반응한다: 참가·쇼다운 통계, 블러프가 들켰는지(이미지),
     * 큰 손실·역전패에 따른 틸트, 그리고 가끔 채팅 한마디(핸드당 최대 1명).
     * @returns {void}
     */
    reflect() {
      const h = this.hand;
      const streets = Object.keys(h.lastAgg).map(Number);
      const finalStreet = streets.length ? Math.max(...streets) : -1;
      const lastAggId = finalStreet >= 0 ? h.lastAgg[finalStreet] : null;
      let talk = null;
      this.players.filter(p => p.inHand).forEach(p => {
        if (p.vpipHand) p.st.vpip++;
        if (p.pfrHand) p.st.pfr++;
        const lost = Math.max(0, p.startStack - p.stack);
        const frac = p.startStack ? lost / p.startStack : 0;
        const m = p.mind;
        if (h.showdown && !p.folded) {
          p.st.sd++;
          const level = h.board.length >= 3 ? madeLevel(p.hole, h.board) : 0;
          const caught = p.id === lastAggId && finalStreet >= 2 && level <= 1 && p.won === 0;
          if (caught) p.st.bluffsShown++;
          if (!m) return;
          const P = styleOf(p);
          if (caught) {
            m.image = -1;
            talk = talk || this.pickTalk(p, 'caught');
          } else if (p.won > 0 && level >= 3 && p.handAgg > 0) {
            m.image = Math.max(m.image, 0.6);
          }
          const badBeat = p.won === 0 && p.allInEq !== undefined && p.allInEq >= 0.6 && frac >= 0.15;
          if (frac >= 0.15) {
            m.tilt = Math.min(1, m.tilt + P.tiltProne * Math.min(1, frac * 2) * (badBeat ? 1.6 : 1));
            talk = talk || this.pickTalk(p, badBeat ? 'badBeat' : 'lose');
          } else if (p.won > 0 && p.won >= p.startStack * 0.6) {
            talk = talk || this.pickTalk(p, 'win');
          }
        } else if (m && p.folded && frac >= 0.4) {
          m.tilt = Math.min(1, m.tilt + styleOf(p).tiltProne * Math.min(1, frac * 2) * 0.6);
        }
      });
      if (talk) this.emit('talk', talk);
    }

    /**
     * 스타일별 수다 확률에 따라 채팅 한마디를 고른다.
     * @param {object} p 컴퓨터 플레이어
     * @param {string} kind TALK의 상황 이름
     * @returns {{id:number,name:string,text:string}|null} 한마디 또는 null
     */
    pickTalk(p, kind) {
      if (this.rng() >= styleOf(p).talk) return null;
      const lines = TALK[kind];
      return { id: p.id, name: p.name, text: lines[Math.floor(this.rng() * lines.length)] };
    }

    /**
     * AI 플레이어의 액션을 정한다. 먼저 판단하고, 폴드는 짧게·나머지는 생각하는 시간만큼 기다린다.
     * @param {object} p AI 플레이어
     * @param {object[]} legal 가능한 액션
     * @returns {Promise<object>} 고른 액션
     */
    async aiAction(p, legal) {
      const a = aiDecide(this, p, legal);
      await this.ctl.wait(p, this, a.type === 'fold' ? 'fold' : 'think');
      return a;
    }

    /**
     * 올인 런아웃이 시작될 때 남은 사람들의 그 시점 승률을 적어 둔다 (역전패 틸트 판단용).
     * @returns {void}
     */
    noteAllInEquity() {
      const h = this.hand;
      const live = this.live();
      if (live.length < 2 || h.board.length >= 5) return;
      const res = exactishEquity(live.map(p => p.hole), h.board, 300, this.rng);
      live.forEach((p, i) => { p.allInEq = res[i]; });
    }

    /**
     * 기여 금액 기준으로 메인 팟과 사이드 팟을 만들고, 앤티(데드 머니)는 메인 팟에 넣는다.
     * @returns {{amount:number,eligible:object[]}[]} 팟 목록 (메인 팟부터)
     */
    buildPots() {
      const contenders = this.players.filter(p => p.inHand);
      const levels = Array.from(new Set(contenders.map(p => p.contrib).filter(x => x > 0))).sort((a, b) => a - b);
      const pots = [];
      let carry = this.hand.dead;
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
      if (carry && pots.length) pots[0].amount += carry;
      return pots;
    }

    /**
     * 콜 받지 못한 베트를 돌려준다: 가장 많이 넣은 사람의 기여 중 두 번째로 많이 넣은 사람을 넘는 부분.
     * @returns {void}
     */
    returnUncalled() {
      const ps = this.players.filter(p => p.inHand).sort((a, b) => b.contrib - a.contrib);
      if (ps.length < 2 || ps[0].contrib <= ps[1].contrib) return;
      const top = ps[0];
      const extra = top.contrib - ps[1].contrib;
      top.contrib -= extra;
      top.stack += extra;
      top.refund = extra;
      this.addLog(`${top.name}: 콜 받지 못한 ${fmt(extra)} 반환`);
    }

    /**
     * 동점 팟의 남는 칩 순서: 버튼 왼쪽에 가까운 사람부터.
     * @param {object} p 플레이어
     * @returns {number} 버튼에서 시계방향 거리 (작을수록 우선)
     */
    distFromButton(p) {
      const n = MAX_SEATS + 1;
      return (p.seat - this.hand.buttonSeat + n) % n || n;
    }

    /**
     * 핸드를 정산한다. 콜 받지 못한 베트를 돌려준 뒤, 혼자 남으면 팟 전체를, 쇼다운이면 팟별로 승자를 가려 나눈다.
     * @returns {void}
     */
    settle() {
      const h = this.hand;
      this.returnUncalled();
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
          p.score = evaluate(p.hole.concat(h.board));
          p.result = describeScore(p.score);
          this.addLog(`${p.name} 쇼다운: ${p.hole.map(cardLabel).join(' ')} → ${p.result}`);
        });
        const pots = this.buildPots();
        pots.forEach((pot, idx) => {
          const best = Math.max(...pot.eligible.map(p => p.score));
          const winners = pot.eligible.filter(p => p.score === best).sort((a, b) => this.distFromButton(a) - this.distFromButton(b));
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
          this.addLog(`${winners.map(w => w.name).join(', ')}: ${potName} ${fmt(pot.amount)} 획득${winners.length > 1 ? ' (분할)' : ''} · ${winners[0].result}`, 'win');
        });
      }
      h.done = true;
      h.actingSeat = null;
      this.reflect();
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
        if (p.mind) {
          const line = this.pickTalk(p, 'bust');
          if (line) this.emit('talk', line);
        }
      });
    }
  }

  /**
   * 홀카드가 모두 공개된 상태의 승률을 몬테카를로로 구한다 (남은 보드만 무작위).
   * @param {number[][]} holes 사람별 홀카드
   * @param {number[]} board 현재 보드
   * @param {number} sims 시뮬레이션 수
   * @param {function(): number} rng 난수 함수
   * @returns {number[]} 사람별 승률
   */
  function exactishEquity(holes, board, sims, rng) {
    const known = new Set(board);
    holes.forEach(hc => hc.forEach(c => known.add(c)));
    const pool = [];
    for (let c = 8; c < 60; c++) if (!known.has(c)) pool.push(c);
    const need = 5 - board.length;
    const acc = holes.map(() => 0);
    for (let n = 0; n < sims; n++) {
      for (let i = 0; i < need; i++) {
        const j = i + Math.floor(rng() * (pool.length - i));
        const tmp = pool[i];
        pool[i] = pool[j];
        pool[j] = tmp;
      }
      const b = board.concat(pool.slice(0, need));
      const scores = holes.map(hc => evaluate(hc.concat(b)));
      const best = Math.max(...scores);
      const winners = scores.filter(s => s === best).length;
      scores.forEach((s, i) => { if (s === best) acc[i] += 1 / winners; });
    }
    return acc.map(x => x / sims);
  }

  /**
   * 상대 레인지(상위 w)에서 홀카드 두 장을 뽑는다. 가끔(RANGE_EPS) 레인지 밖의 아무 패도 뽑아 실수·블러프를 반영한다.
   * @param {number} w 레인지 폭 0~1
   * @param {Uint32Array} mark 사용 중인 카드 표시 (mark[c] === stamp면 사용 중)
   * @param {number} stamp 이번 시뮬레이션 번호
   * @param {function(): number} rng 난수 함수
   * @returns {number[]} 홀카드 두 장
   */
  function sampleFromRange(w, mark, stamp, rng) {
    if (w < 0.999 && rng() >= RANGE_EPS) {
      const cut = Math.max(6, Math.ceil(w * COMBOS.length));
      for (let tries = 0; tries < 24; tries++) {
        const cb = COMBOS[Math.floor(rng() * cut)];
        if (mark[cb.a] !== stamp && mark[cb.b] !== stamp) return [cb.a, cb.b];
      }
    }
    return [drawFree(mark, stamp, rng), drawFree(mark, stamp, rng)];
  }

  /**
   * 아직 쓰이지 않은 카드를 무작위로 한 장 뽑아 사용 표시한다.
   * @param {Uint32Array} mark 사용 중인 카드 표시
   * @param {number} stamp 이번 시뮬레이션 번호
   * @param {function(): number} rng 난수 함수
   * @returns {number} 카드 정수
   */
  function drawFree(mark, stamp, rng) {
    for (;;) {
      const c = 8 + Math.floor(rng() * 52);
      if (mark[c] !== stamp) {
        mark[c] = stamp;
        return c;
      }
    }
  }

  /**
   * 상대가 이번 핸드에 플랍 이후 공격했을 때, 그 상대의 현재 패가 그럴듯한 정도(가중치).
   * @param {number} level madeLevel 결과
   * @param {number} draw drawLevel 결과
   * @param {number} agg 플랍 이후 공격 횟수
   * @param {number} bluffy 약한 패 가중 배수 (공격적이거나 블러프가 들킨 상대일수록 큼)
   * @returns {number} 0~1 가중치
   */
  function aggWeight(level, draw, agg, bluffy) {
    if (level >= 3) return 1;
    const strong = agg >= 2;
    let w = level === 2 ? (strong ? 0.55 : 0.9) : level === 1 ? (strong ? 0.2 : 0.45) : (strong ? 0.06 : 0.16);
    if (draw >= 2) w = Math.max(w, strong ? 0.4 : 0.7);
    else if (draw === 1) w = Math.max(w, strong ? 0.12 : 0.3);
    return Math.min(1, w * bluffy);
  }

  /**
   * 상대가 플랍 이후 콜만 했을 때 그 상대의 현재 패가 그럴듯한 정도(가중치). 잘 안 접는 상대는 약한 패도 넓게 본다.
   * @param {number} level madeLevel 결과
   * @param {number} draw drawLevel 결과
   * @param {number} loose 잘 안 접는 정도 (1 보통)
   * @returns {number} 0~1 가중치
   */
  function callWeight(level, draw, loose) {
    if (level >= 2 || draw >= 2) return 1;
    const w = level === 1 ? 0.7 : draw === 1 ? 0.45 : 0.25;
    return Math.min(1, w * loose);
  }

  /**
   * 상대의 평소 공격 비율(베트·레이즈 ÷ 베트·레이즈·콜, 표본이 적으면 0.4 쪽으로 당김).
   * @param {object} o 플레이어
   * @returns {number} 0~1
   */
  function aggFreq(o) {
    return rate(o.st.agg, o.st.agg + o.st.pas, 0.4, 8);
  }

  /**
   * 손읽기 승률: 몬테카를로로 상대 홀카드와 남은 보드를 뽑되, 상대 홀카드는 프리플랍 행동으로 좁힌 레인지에서 뽑고,
   * 플랍 이후 공격·콜과 어울리는 패일수록 가중치를 준다. 집중력이 떨어지면(틸트) 판단에 잡음이 섞인다.
   * @param {Tournament} t 토너먼트
   * @param {object} p 판단하는 플레이어
   * @param {number} sims 시뮬레이션 횟수
   * @param {number} respect 상대 레인지를 더 좁게 보는 정도 (0~1)
   * @returns {number} 0~1 가중 승률
   */
  function readEquity(t, p, sims, respect) {
    const h = t.hand;
    const rng = t.rng;
    const opps = t.live().filter(o => o !== p);
    if (!opps.length) return 1;
    const info = opps.map(o => {
      const af = aggFreq(o);
      return {
        w: clamp(o.rangeW * (1 - 0.5 * respect), 0.012, 1),
        agg: o.postAgg,
        calls: o.postCalls,
        bluffy: Math.min(3, Math.pow(af / 0.4, 1.4) * (1 + 0.2 * o.st.bluffsShown)),
        loose: rate(o.st.ftb, o.st.ftbOpp, 0.45, 8) < 0.3 ? 1.6 : 1
      };
    });
    const mark = new Uint32Array(60);
    const board = h.board;
    let acc = 0;
    let wsum = 0;
    for (let n = 1; n <= sims; n++) {
      p.hole.forEach(c => { mark[c] = n; });
      board.forEach(c => { mark[c] = n; });
      const hands = info.map(o => {
        const hc = sampleFromRange(o.w, mark, n, rng);
        mark[hc[0]] = n;
        mark[hc[1]] = n;
        return hc;
      });
      let w = 1;
      if (board.length >= 3) {
        info.forEach((o, i) => {
          if (o.agg > 0) w *= aggWeight(madeLevel(hands[i], board), drawLevel(hands[i], board), o.agg, o.bluffy);
          else if (o.calls > 0) w *= callWeight(madeLevel(hands[i], board), drawLevel(hands[i], board), o.loose);
        });
      }
      const full = board.slice();
      while (full.length < 5) full.push(drawFree(mark, n, rng));
      const mine = evaluate(p.hole.concat(full));
      let lost = false;
      let ties = 0;
      for (let i = 0; i < hands.length && !lost; i++) {
        const s = evaluate(hands[i].concat(full));
        if (s > mine) lost = true;
        else if (s === mine) ties++;
      }
      wsum += w;
      if (!lost) acc += w / (ties + 1);
    }
    return wsum > 0 ? acc / wsum : 1 / (opps.length + 1);
  }

  /**
   * 컴퓨터 참가자를 만든다: 10가지 스타일과 이름 풀에서 겹치지 않게 무작위로 뽑는다.
   * @param {number} n 컴퓨터 수 (최대 8)
   * @param {function(): number} rng 난수 함수
   * @returns {{name:string, persona:object}[]} 참가자 목록
   */
  function pickAiPlayers(n, rng) {
    const styles = shuffle(STYLES.slice(), rng);
    const names = shuffle(S.AI_NAMES.slice(), rng);
    return Array.from({ length: Math.min(n, STYLES.length) }, (_, i) => ({ name: names[i], persona: styles[i] }));
  }

  /**
   * 지금 상황에 맞춰 스타일 값을 조정한다 ("실제 사람이라면"):
   *  - 기어: 정해진 핸드마다 타이트/루즈로 바꿔 읽히지 않게
   *  - 틸트: 참가·공격·블러프·콜↑, 상대를 덜 존중하고 판단에 잡음
   *  - 이미지: 블러프가 들킨 뒤에는 블러프를 줄이고, 센 패를 보여준 뒤에는 늘림
   *  - 스택(M = 스택 ÷ 한 바퀴 비용 SB+BB+앤티): 짧으면 푸시/폴드로, 크면 작은 스택들을 압박
   *  - 버블: 중간 스택은 몸을 사리고 칩 리더는 스틸을 늘림. 헤즈업은 모두 느슨하게
   * 그리고 홀덤 판단용 기준값(vb 밸류 베트, vr 밸류 레이즈, vPre 프리플랍 리레이즈, pushBB 푸시 시작 스택)을 만든다.
   * @param {Tournament} t 토너먼트
   * @param {object} p 컴퓨터 플레이어
   * @returns {object} 조정된 스타일 값
   */
  function effectiveStyle(t, p) {
    const P = styleOf(p);
    const m = p.mind || { tilt: 0, image: 0, gear: 0 };
    const L = t.level;
    const alive = t.alive();
    const stacks = alive.map(o => o.stack + (o.inHand ? o.bet : 0));
    const avg = stacks.reduce((a, b) => a + b, 0) / alive.length;
    const myStack = p.stack + p.bet;
    const mRatio = myStack / (L.sb + L.bb + L.ante);
    const bubble = alive.length === t.paidPlaces + 1;
    const nearBubble = alive.length === t.paidPlaces + 2 && t.paidPlaces >= 2;
    const leader = myStack === Math.max(...stacks);
    const shortest = myStack === Math.min(...stacks);
    P.open *= 1 + 0.25 * m.gear + 0.6 * m.tilt;
    P.call *= 1 + 0.1 * m.gear + 0.5 * m.tilt;
    P.threeBet *= 1 + 0.3 * m.gear + 0.8 * m.tilt;
    P.aggr += 0.08 * m.gear + 0.25 * m.tilt;
    P.steal += 0.15 * m.gear;
    P.bluff += 0.04 * m.gear + 0.12 * m.tilt;
    P.sticky += 0.2 * m.tilt;
    P.respect *= 1 - 0.6 * m.tilt;
    P.focus -= 0.3 * m.tilt;
    P.bluff *= 1 + 0.8 * m.image;
    P.cbet *= 1 + 0.25 * m.image;
    P.pushBB = 10 + 3 * (P.aggr - 0.5) + (mRatio < 6 ? 3 : 0);
    if (mRatio < 10) {
      P.open *= 1.15;
      P.steal += 0.1;
    }
    if (myStack > avg * 1.6) {
      P.steal += 0.15;
      P.open *= 1.1;
      P.aggr += 0.05;
    }
    const press = bubble ? 1 : nearBubble ? 0.5 : 0;
    P.icmPress = 0;
    if (press && !leader && !shortest) {
      P.icmPress = P.icm * press;
      P.open *= 1 - 0.2 * P.icmPress;
      P.call *= 1 - 0.3 * P.icmPress;
      P.bluff *= 1 - 0.5 * P.icmPress;
      P.respect += 0.1 * P.icmPress;
    }
    if (press && leader) {
      P.steal += 0.2 * press;
      P.open *= 1 + 0.2 * press;
      P.aggr += 0.1 * press;
    }
    if (alive.length === 2) {
      P.call *= 1.25;
      P.threeBet *= 1.3;
      P.aggr += 0.1;
      P.sticky += 0.08;
    }
    ['aggr', 'bluff', 'steal', 'sticky', 'respect'].forEach(k => { P[k] = clamp(P[k], 0, 0.98); });
    P.focus = clamp(P.focus, 0.5, 1);
    P.vb = (0.32 + 0.17 * P.raise) - 0.04 * m.tilt;
    P.vr = P.vb + 0.12;
    P.vPre = clamp(0.64 - 0.1 * (P.threeBet - 1), 0.5, 0.72);
    return P;
  }

  /**
   * 베트·레이즈 액션을 원하는 금액으로 만든다. 사람처럼 스몰블라인드 단위로 반올림하고, 레이즈가 불가능하면 콜/체크로 바꾸고,
   * 남는 스택이 팟에 비해 너무 적으면 올인으로 올린다.
   * @param {Tournament} t 토너먼트
   * @param {object} p 플레이어
   * @param {object[]} legal 가능한 액션
   * @param {number} to 원하는 총 베팅 금액
   * @returns {object} 액션
   */
  function sized(t, p, legal, to) {
    const a = legal.find(x => x.type === 'bet' || x.type === 'raise');
    if (!a) return legal.find(x => x.type === 'call') || legal.find(x => x.type === 'check');
    const unit = t.level.sb;
    let v = clamp(Math.round(to / unit) * unit, a.min, a.max);
    const left = a.max - v;
    if (left < (t.potTotal() + v) * 0.35 || v >= a.max * 0.8) v = a.max;
    return Object.assign({}, a, { to: v, amount: v - p.bet, allIn: v === a.max });
  }

  /**
   * 레인지 대비 프리플랍 승률: 내 홀카드와, 이미 돈을 넣은 상대(콜·레이즈한 사람과 블라인드)의 레인지에서 뽑은 패로 보드 5장을 끝까지 돌린다.
   * @param {Tournament} t 토너먼트
   * @param {object} p 판단하는 플레이어
   * @param {object[]} opps 상대들
   * @param {number} respect 상대 레인지를 더 좁게 보는 정도
   * @param {number} sims 시뮬레이션 수
   * @returns {number} 0~1 승률
   */
  function preflopEquity(t, p, opps, respect, sims) {
    if (!opps.length) return 1;
    const rng = t.rng;
    const mark = new Uint32Array(60);
    let acc = 0;
    for (let n = 1; n <= sims; n++) {
      p.hole.forEach(c => { mark[c] = n; });
      const hands = opps.map(o => {
        const hc = sampleFromRange(clamp(o.rangeW * (1 - 0.5 * respect), 0.012, 1), mark, n, rng);
        mark[hc[0]] = n;
        mark[hc[1]] = n;
        return hc;
      });
      const board = [];
      for (let i = 0; i < 5; i++) board.push(drawFree(mark, n, rng));
      const mine = evaluate(p.hole.concat(board));
      let lost = false;
      let ties = 0;
      for (let i = 0; i < hands.length && !lost; i++) {
        const s = evaluate(hands[i].concat(board));
        if (s > mine) lost = true;
        else if (s === mine) ties++;
      }
      if (!lost) acc += 1 / (ties + 1);
    }
    return acc / sims;
  }

  /**
   * 프리플랍 판단.
   *  - 아무도 안 들어왔을 때: 스택이 짧으면 포지션별 푸시 레인지, 아니면 포지션별 오픈 레인지 × 스타일(림프하는 스타일도 있음).
   *    스틸 자리에서는 블라인드가 스틸에 잘 접을수록 넓힌다
   *  - 레이즈를 마주했을 때: 상대 레인지 대비 승률로 리레이즈(밸류 또는 가끔 블러프) / 콜(팟 오즈 + 포지션·임플라이드 오즈) / 폴드
   * @param {Tournament} t 토너먼트
   * @param {object} p AI 플레이어
   * @param {object[]} legal 가능한 액션
   * @param {object} P effectiveStyle 결과
   * @returns {object} 고른 액션
   */
  function preflopDecide(t, p, legal, P) {
    const h = t.hand;
    const L = t.level;
    const bb = L.bb;
    const rnd = t.rng();
    const find = type => legal.find(a => a.type === type);
    const passive = find('check') || find('call');
    const fold = find('fold') || find('check');
    const toCall = Math.max(0, h.currentBet - p.bet);
    const pct = clamp(handPct(p.hole) + (t.rng() - 0.5) * 0.1 * (1 - P.focus) * 4, 0, 1);
    const beh = t.behind(p);
    const opps = t.live().filter(o => o !== p);
    const deepest = Math.max(...opps.map(o => o.stack + o.bet));
    const effBB = Math.min(p.stack + p.bet, deepest) / bb;
    const heads = t.alive().length === 2;
    const pot = t.potTotal();
    if (h.raises === 0) {
      let stealMul = 1;
      if (t.isStealSpot(p)) {
        const blinds = opps.filter(o => o.seat === h.sbSeat || o.seat === h.bbSeat);
        const fts = blinds.length ? blinds.reduce((s, o) => s + rate(o.st.fts, o.st.ftsOpp, 0.6, 6), 0) / blinds.length : 0.6;
        stealMul = (1 + (P.steal - 0.45) * 0.8) * (1 + P.adapt * (fts / 0.6 - 1) * 0.6);
      }
      if (effBB <= P.pushBB) {
        let push = Math.min(0.95, (heads ? 0.75 : PUSH_BASE[Math.min(beh, 9)]) * Math.pow(10 / Math.max(effBB, 1.5), 0.8) * Math.sqrt(P.open) * stealMul);
        if (h.limpers) push *= 0.75;
        if (pct <= push) return sized(t, p, legal, p.bet + p.stack);
        return toCall === 0 ? passive : fold;
      }
      let open = (heads ? 0.75 : OPEN_BASE[Math.min(beh, 9)]) * P.open * stealMul;
      if (h.limpers) open *= 0.65;
      if (toCall === 0) {
        if (pct <= Math.min(0.5, 0.14 * P.open) && rnd < 0.5 + P.aggr * 0.5) return sized(t, p, legal, (3 + h.limpers) * bb);
        return passive;
      }
      if (pct <= open) {
        const trap = pct <= 0.025 && rnd < P.slowplay * 0.35;
        if ((P.limp > 0 && rnd < P.limp && pct > 0.05) || trap) return passive;
        const mult = (heads ? 2.2 : beh >= 5 ? 2.5 : 2.2) * P.size;
        return sized(t, p, legal, (effBB < 25 ? 2 : mult) * bb + h.limpers * bb);
      }
      if (h.limpers && pct <= open * 1.9 && rnd < P.limp + 0.15 * P.call) return passive;
      if (p.seat === h.sbSeat && toCall <= bb && pct <= 0.5 * P.call && rnd < 0.35 + P.limp * 0.6) return passive;
      return fold;
    }
    const callAmt = Math.min(toCall, p.stack);
    const involved = opps.filter(o => o.vpipHand);
    const raiser = t.players.find(o => o.id === h.lastAgg[0]);
    let respect = P.respect;
    if (raiser && P.adapt) {
      const af = rate(raiser.st.pfr, raiser.st.hands, 0.16, 12);
      respect = clamp(respect * (1 + P.adapt * (clamp(0.16 / af, 0.3, 1.6) - 1)), 0, 0.9);
    }
    const eq = clamp(preflopEquity(t, p, involved.length ? involved : opps, respect, Math.max(80, t.sims)) + (t.rng() - 0.5) * (1 - P.focus) * 0.6, 0, 1);
    const n = Math.max(1, involved.length);
    const rel = n === 1 ? eq : eq * (n + 1) / 2;
    const need = callAmt / (pot + callAmt);
    const allInCall = callAmt >= p.stack;
    const short = effBB <= 22;
    if (rel >= P.vPre + (h.raises - 1) * 0.03) {
      const trap = h.raises === 1 && rel >= P.vPre + 0.12 && rnd < P.slowplay * 0.5 && !short;
      if (!trap && find('raise')) {
        const ip = !(p.seat === h.sbSeat || p.seat === h.bbSeat);
        const target = short ? p.bet + p.stack : h.raises === 1 ? h.currentBet * (ip ? 3 : 3.6) * P.size : h.currentBet * 2.3;
        return sized(t, p, legal, target);
      }
    }
    if (h.raises === 1 && n === 1 && find('raise') && !short && pct <= 0.4 && raiser && raiser.rangeW >= 0.12) {
      const blocker = rankOf(p.hole[0]) === 14 || rankOf(p.hole[1]) === 14 || suitOf(p.hole[0]) === suitOf(p.hole[1]);
      if (blocker && rnd < P.bluff * 0.45 * P.threeBet) return sized(t, p, legal, h.currentBet * 3.2);
    }
    if (short && !allInCall && find('raise') && rel >= P.vPre - 0.08 && raiser && raiser.rangeW >= 0.15) return sized(t, p, legal, p.bet + p.stack);
    const suited = suitOf(p.hole[0]) === suitOf(p.hole[1]);
    const gap = Math.abs(rankOf(p.hole[0]) - rankOf(p.hole[1]));
    const spec = (rankOf(p.hole[0]) === rankOf(p.hole[1])) || (suited && gap <= 2);
    const implied = !allInCall && effBB > 35 && spec ? 0.05 : 0;
    const oop = (p.seat === h.sbSeat || p.seat === h.bbSeat) && !heads ? 0.03 : 0;
    const icm = allInCall ? 0.1 * P.icmPress + 0.02 * (P.icm - 0.8) : 0.04 * P.icmPress;
    const needAdj = need + (allInCall ? 0 : 0.05) + oop + beh * 0.012 + icm - implied - P.sticky * 0.12 - (P.call - 1) * 0.05;
    if (eq >= needAdj && (allInCall || pct <= Math.max(0.35, (raiser ? raiser.rangeW : 0.3) * 2.6 * P.call) || need < 0.22)) return passive;
    return fold;
  }

  /**
   * 플랍 이후 판단.
   *  - 손읽기 승률(readEquity)을 남은 상대 수로 정규화한 세기로 밸류 베트/레이즈
   *  - 프리플랍 레이저의 컨티뉴에이션 베트와 턴 배럴, 드로우 세미블러프, 체크로 넘어오면 포지션에서 찔러보기
   *  - 베트를 마주하면 팟 오즈(드로우는 남은 스트리트 임플라이드 오즈)로 콜, 팟에 많이 넣었으면 쉽게 안 접음
   *  - 상대 통계로 적응: 잘 접는 상대에게 블러프↑, 잘 안 접는 상대에게 블러프↓·얇은 밸류↑
   *  - 아주 강한 패는 스타일에 따라 플랍·턴에서 체크·콜로 숨김
   * @param {Tournament} t 토너먼트
   * @param {object} p AI 플레이어
   * @param {object[]} legal 가능한 액션
   * @param {object} P effectiveStyle 결과
   * @returns {object} 고른 액션
   */
  function postflopDecide(t, p, legal, P) {
    const h = t.hand;
    const rnd = t.rng();
    const find = type => legal.find(a => a.type === type);
    const passive = find('check') || find('call');
    const fold = find('fold') || find('check');
    const opps = t.live().filter(o => o !== p);
    const n = opps.length;
    const raiser = h.lastAgg[h.street] !== undefined && h.lastAgg[h.street] !== p.id ? t.players.find(o => o.id === h.lastAgg[h.street]) : null;
    let respect = P.respect;
    if (raiser && P.adapt) respect = clamp(respect * (1 + P.adapt * (clamp(0.4 / aggFreq(raiser), 0.3, 1.5) - 1)), 0, 0.9);
    const eq = clamp(readEquity(t, p, t.sims, respect * 0.5) + (t.rng() - 0.5) * (1 - P.focus) * 0.6, 0, 1);
    const rel = n === 1 ? eq : Math.min(1, eq * (n + 1) / 2);
    const pot = t.potTotal();
    const toCall = Math.max(0, h.currentBet - p.bet);
    const draw = drawLevel(p.hole, h.board);
    const level = madeLevel(p.hole, h.board);
    const ftb = opps.reduce((s, o) => s + rate(o.st.ftb, o.st.ftbOpp, 0.45, 8), 0) / n;
    const bluffMul = clamp(1 + P.adapt * (ftb / 0.45 - 1), 0.2, 2);
    const valueMul = 1 - P.adapt * 0.12 * Math.max(0, (0.45 - ftb) / 0.45);
    const ip = t.inPosition(p);
    const pfa = h.pfAggressor === p.id;
    const trap = rel >= 0.85 && h.street < 3 && rnd < P.slowplay;
    const committed = p.contrib >= (p.contrib + p.stack) * 0.45 || p.stack <= pot * 0.5;
    const bet = frac => sized(t, p, legal, p.bet + pot * frac * P.size);
    if (toCall === 0) {
      if (trap) return passive;
      if (rel >= P.vb * valueMul) return bet(rel >= 0.8 ? 0.7 : 0.6);
      if (h.street === 1 && pfa && n <= 2 && rnd < P.cbet * (1.15 - 0.15 * wetness(h.board)) * bluffMul / n) return bet(0.4);
      if (h.street === 2 && pfa && h.lastAgg[1] === p.id && n === 1 && (draw >= 2 || rnd < P.bluff * 1.3 * bluffMul)) return bet(0.6);
      if (draw >= 2 && rnd < P.semibluff) return bet(0.6);
      if (ip && n === 1 && level <= 1 && rnd < P.bluff * bluffMul * 0.8) return bet(0.5);
      return passive;
    }
    const callAmt = Math.min(toCall, p.stack);
    const need = callAmt / (pot + callAmt);
    const implied = draw >= 2 && h.street < 3 && callAmt < p.stack ? 0.06 + 0.03 * (draw - 2) : 0;
    const eqAdj = eq + P.sticky * 0.1 + implied - (callAmt >= p.stack ? 0.06 * P.icmPress : 0);
    if (find('raise') && rel >= P.vr && rnd < P.aggr + 0.15 && !(trap && h.street < 2)) return sized(t, p, legal, h.currentBet * 2.8 + (pot - h.currentBet) * 0.3);
    if (find('raise') && draw >= 2 && h.street < 3 && rnd < P.semibluff * 0.35) return sized(t, p, legal, h.currentBet * 2.8);
    if (find('raise') && n === 1 && h.street < 3 && level <= 1 && rnd < P.bluff * 0.12 * bluffMul) return sized(t, p, legal, h.currentBet * 2.6);
    if (eqAdj >= need) return passive;
    if (committed && eqAdj >= need * 0.65) return passive;
    if (draw >= 1 && h.street < 3 && callAmt <= p.stack * 0.25 && rnd < P.chase) return passive;
    return fold;
  }

  /**
   * AI 판단 진입점 ("지역 대회 Day1 우승 경험자" 수준을 기준으로, 스타일과 상황에 따라 흔들림).
   * @param {Tournament} t 토너먼트
   * @param {object} p AI 플레이어
   * @param {object[]} legal 가능한 액션
   * @returns {object} 고른 액션 (legal 중 하나, 베트·레이즈는 금액 포함)
   */
  function aiDecide(t, p, legal) {
    const P = effectiveStyle(t, p);
    return t.hand.street === 0 ? preflopDecide(t, p, legal, P) : postflopDecide(t, p, legal, P);
  }

  /**
   * 연습 모드 힌트: 무작위 상대 대비 승률, 팟 오즈, 지금 패, 다음 카드에 족보가 오르는 장수, 프리플랍 핸드 순위.
   * @param {{hole:number[],board:number[],opponents:number,toCall:number,pot:number}} s 내 상황
   * @param {number} [sims=1500] 시뮬레이션 수
   * @returns {object} 힌트 데이터
   */
  function analyze(s, sims) {
    const rng = Math.random;
    const known = new Set(s.hole.concat(s.board));
    const pool = [];
    for (let c = 8; c < 60; c++) if (!known.has(c)) pool.push(c);
    const total = 5 - s.board.length + s.opponents * 2;
    let acc = 0;
    const runs = sims || 1500;
    for (let n = 0; n < runs; n++) {
      for (let i = 0; i < total; i++) {
        const j = i + Math.floor(rng() * (pool.length - i));
        const tmp = pool[i];
        pool[i] = pool[j];
        pool[j] = tmp;
      }
      const board = s.board.concat(pool.slice(0, 5 - s.board.length));
      let k = 5 - s.board.length;
      const mine = evaluate(s.hole.concat(board));
      let lost = false;
      let ties = 0;
      for (let o = 0; o < s.opponents && !lost; o++) {
        const sc = evaluate([pool[k], pool[k + 1]].concat(board));
        k += 2;
        if (sc > mine) lost = true;
        else if (sc === mine) ties++;
      }
      if (!lost) acc += 1 / (ties + 1);
    }
    const eq = s.opponents ? acc / runs : 1;
    let improving = 0;
    let unseen = 0;
    const cur = s.board.length >= 3 ? evaluate(s.hole.concat(s.board)) : 0;
    if (s.board.length >= 3 && s.board.length < 5) {
      const cat = scoreCategory(cur);
      pool.forEach(c => {
        unseen++;
        if (scoreCategory(evaluate(s.hole.concat(s.board, [c]))) > cat) improving++;
      });
    }
    return {
      eq, toCall: s.toCall, pot: s.pot, need: s.toCall > 0 ? s.toCall / (s.pot + s.toCall) : 0,
      improving, unseen, opponents: s.opponents,
      pct: handPct(s.hole), handClass: classOf(s.hole[0], s.hole[1]),
      current: s.board.length >= 3 ? describeScore(cur) : (rankOf(s.hole[0]) === rankOf(s.hole[1]) ? `${S.RANK_LABELS[rankOf(s.hole[0])]} 포켓 페어` : '하이카드'),
      draw: s.board.length >= 3 ? drawLevel(s.hole, s.board) : 0,
      nextStreet: s.board.length === 3 ? STREETS[2] : s.board.length === 4 ? STREETS[3] : null
    };
  }

  buildPreflopTables();

  return {
    LEVELS, STYLES, STREETS, STREETS_EN, STARTING_STACK, MAX_SEATS, TALK,
    levelText, classOf, handPct, madeLevel, drawLevel, pickAiPlayers, effectiveStyle, readEquity, exactishEquity,
    aiDecide, analyze, makeRng, fmt, Tournament
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Holdem;
