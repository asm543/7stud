'use strict';

/**
 * 온라인 통합 테스트
 * 서버를 임의 포트로 띄우고 WebSocket 봇들로 다음을 확인한다.
 *  1) 사람 2명 + 컴퓨터 5명 대회 완주, 중간에 한 명 끊겼다가 같은 토큰으로 재접속
 *  2) 모든 화면 상태에서 남의 히든 카드가 새지 않음 (쇼다운 공개분 제외), 실전 모드는 폴드 카드·죽은 카드 미전송
 *  3) 대회 중 들어온 사람은 관전자
 *  4) 리매치 후 사람 2명 헤즈업(컴퓨터 0명) 완주
 *  5) 채팅: 전달, 연속 전송 제한, 길이 제한, 시스템 안내, 재접속 시 기록 복원, 관전자 채팅, 컴퓨터 한마디 개수 출력
 *  6) 홀덤: 로비에서 게임 전환(최대 인원 9 ↔ 7에 맞춰 관전자 조정, 레벨업 간격 기본값), 사람 2 + 컴퓨터 7 완주,
 *     범위 밖 레이즈 금액은 서버가 min~max로 맞춤, 남의 홀카드는 쇼다운·올인 공개 때만, 폴드한 남의 카드는 미전송
 */
process.env.STUD_TIME_SCALE = '0.004';
const crypto = require('crypto');
const WebSocket = require('ws');
const { start, stop } = require('../server.js');

/**
 * 조건이 거짓이면 예외를 던진다.
 * @param {boolean} cond 조건
 * @param {string} msg 메시지
 * @returns {void}
 */
function assert(cond, msg) {
  if (!cond) throw new Error('ASSERT: ' + msg);
}

/**
 * 지정 시간만큼 기다린다.
 * @param {number} ms 밀리초
 * @returns {Promise<void>} 대기 Promise
 */
function sleep(ms) {
  return new Promise(res => setTimeout(res, ms));
}

/**
 * 테스트용 봇 클라이언트.
 * 내부 요소: ws 연결, 토큰, 마지막 화면 상태, 자동 액션·준비, 히든 카드 유출 검사 카운터
 */
class Bot {
  /**
   * 봇을 만든다.
   * @param {string} name 닉네임
   * @param {number} port 서버 포트
   * @param {string} [mode] 'practice' | 'real'
   */
  constructor(name, port, mode) {
    this.name = name;
    this.port = port;
    this.mode = mode || 'practice';
    this.token = crypto.randomUUID();
    this.state = null;
    this.code = null;
    this.states = 0;
    this.acts = 0;
    this.sentKey = '';
    this.auto = true;
    this.errors = [];
    this.chat = [];
  }

  /**
   * 서버에 연결한다.
   * @returns {Promise<void>} 연결되면 끝나는 Promise
   */
  connect() {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(`ws://127.0.0.1:${this.port}/ws`);
      this.ws.on('open', () => res());
      this.ws.on('error', rej);
      this.ws.on('message', raw => this.onMessage(JSON.parse(raw.toString())));
    });
  }

  /**
   * 메시지를 보낸다.
   * @param {object} msg 메시지
   * @returns {void}
   */
  send(msg) {
    this.ws.send(JSON.stringify(msg));
  }

  /**
   * 서버 메시지 처리: 상태 저장, 유출 검사, 자동 액션·준비.
   * @param {object} msg 메시지
   * @returns {void}
   */
  onMessage(msg) {
    if (msg.t === 'joined') {
      this.code = msg.code;
      this.send({ t: 'mode', mode: this.mode });
    }
    if (msg.t === 'error') this.errors.push(msg.code);
    if (msg.t === 'chat') this.chat = msg.reset ? msg.items.slice() : this.chat.concat(msg.items);
    if (msg.t !== 'state') return;
    this.state = msg;
    this.states++;
    this.checkPrivacy(msg);
    if (!this.auto) return;
    if (msg.yourTurn) {
      const key = `${msg.yourTurn.handNo}-${msg.game.hand.street}-${msg.game.hand.raises}-${msg.game.hand.currentBet}`;
      if (key === this.sentKey) return;
      this.sentKey = key;
      const legal = msg.yourTurn.legal;
      const r = Math.random();
      const pick = (r < 0.15 && legal.find(a => ['raise', 'complete', 'bet'].includes(a.type))) ||
        (r < 0.25 && legal.find(a => a.type === 'fold')) ||
        legal.find(a => ['check', 'call', 'bringin'].includes(a.type)) || legal[0];
      this.acts++;
      const out = { t: 'act', handNo: msg.yourTurn.handNo, i: legal.indexOf(pick), type: pick.type };
      if (pick.min !== undefined) {
        const q = Math.random();
        out.to = q < 0.1 ? 1 : q < 0.2 ? 1e12 : Math.round(pick.min + (pick.max - pick.min) * Math.random() ** 3);
        this.raises = (this.raises || 0) + 1;
      }
      this.send(out);
    }
    if (msg.next && !msg.next.you && msg.you.playerId !== null && this.readyFor !== msg.next.deadline) {
      this.readyFor = msg.next.deadline;
      this.send({ t: 'ready' });
    }
  }

  /**
   * 화면 상태에서 남의 히든 카드가 보이는지 검사한다.
   * @param {object} msg state 메시지
   * @returns {void}
   */
  checkPrivacy(msg) {
    if (!msg.game) return;
    if (msg.game.type === 'holdem') {
      msg.game.players.forEach(p => {
        const mine = p.id === msg.you.playerId;
        if (!mine && !p.shown) assert(p.hole.every(c => c === null), `${this.name} saw hole cards of ${p.name}`);
        if (!mine && p.folded) assert(p.hole.length === 0, 'folded hole cards sent');
        if (!mine && p.hole.some(c => c !== null)) this.sawShown = (this.sawShown || 0) + 1;
      });
      return;
    }
    msg.game.players.forEach(p => {
      const mine = p.id === msg.you.playerId;
      p.cards.forEach(x => {
        if (!x.up && !mine && !p.shown) assert(x.c === null, `${this.name} saw hidden card of ${p.name}`);
      });
      if (this.mode === 'real' && p.folded && !mine) assert(p.cards.length === 0, 'real mode got folded cards');
    });
    if (this.mode === 'real' && msg.game.hand) assert(msg.game.hand.deadUp.length === 0, 'real mode got dead cards');
  }

  /**
   * 조건이 참이 될 때까지 기다린다.
   * @param {function(): boolean} fn 조건
   * @param {number} ms 최대 대기
   * @param {string} what 설명
   * @returns {Promise<void>} 대기 Promise
   */
  async until(fn, ms, what) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (fn()) return;
      await sleep(20);
    }
    throw new Error('timeout: ' + what);
  }
}

(async () => {
  const port = await start(0);
  const A = new Bot('호스트', port, 'practice');
  const B = new Bot('친구', port, 'real');
  await A.connect();
  A.send({ t: 'create', token: A.token, name: A.name, game: 'stud' });
  await A.until(() => A.code, 2000, 'room created');
  await B.connect();
  B.send({ t: 'join', code: A.code.toLowerCase(), token: B.token, name: B.name });
  await B.until(() => B.state && B.state.room.members.length === 2, 2000, 'B joined');
  assert(A.state.you.host && !B.state.you.host, 'host flag');
  assert(A.state.room.settings.game === 'stud', 'room created as stud');
  A.send({ t: 'chat', text: '  안녕\n하세요  ' });
  A.send({ t: 'chat', text: '바로 또 보냄' });
  await B.until(() => B.chat.some(c => c.kind === 'user'), 2000, 'chat delivered');
  await sleep(700);
  A.send({ t: 'chat', text: 'x'.repeat(300) });
  await B.until(() => B.chat.filter(c => c.kind === 'user').length === 2, 2000, 'second chat');
  const users = B.chat.filter(c => c.kind === 'user');
  assert(users[0].text === '안녕 하세요' && users[0].name === '호스트', 'chat cleaned: ' + users[0].text);
  assert(users[1].text.length === 200, 'chat length capped');
  assert(B.chat.some(c => c.kind === 'system' && c.text.includes('방을 만들었어요')), 'create notice in history');
  assert(A.chat.some(c => c.kind === 'system' && c.text.includes('친구 님이 들어왔어요')), 'join notice');
  console.log('chat basics ok');
  B.send({ t: 'settings', patch: { ais: 0 } });
  await sleep(50);
  assert(A.state.room.settings.ais === 5, 'non-host cannot change settings');
  A.send({ t: 'settings', patch: { ais: 9, hpl: 3, speed: 'fast', turnSecs: 20 } });
  await A.until(() => A.state.room.settings.hpl === 3, 2000, 'settings');
  assert(A.state.room.settings.ais === 5, 'ais clamped to 5 with 2 humans');
  A.send({ t: 'start' });
  await A.until(() => A.state.room.phase === 'playing' && A.state.game, 2000, 'started');
  const myIdA = A.state.you.playerId;
  const myIdB = B.state.you.playerId;
  assert(myIdA !== null && myIdB !== null && myIdA !== myIdB, 'both seated');
  assert(A.state.game.players.length === 7, '7 players');

  await A.until(() => A.state.game.handNo >= 5, 60000, 'hand 5');
  const stackBefore = B.state.game.players.find(p => p.id === myIdB);
  B.ws.terminate();
  await sleep(100);
  const C = new Bot('관전자', port, 'practice');
  await C.connect();
  C.send({ t: 'join', code: A.code, token: C.token, name: C.name });
  await C.until(() => C.state && C.state.game, 2000, 'spectator state');
  assert(C.state.you.playerId === null, 'late joiner is spectator');
  const reB = new Bot('친구', port, 'real');
  reB.token = B.token;
  await reB.connect();
  reB.send({ t: 'join', code: A.code, token: reB.token, name: 'ignored' });
  await reB.until(() => reB.state && reB.state.game, 3000, 'B reconnected');
  assert(reB.state.you.playerId === myIdB, 'B got same seat back');
  assert(reB.state.room.members.length === 3, 'no duplicate member on reconnect');
  assert(reB.chat.some(c => c.kind === 'user' && c.text === '안녕 하세요'), 'chat history restored on reconnect');
  assert(reB.chat.some(c => c.text.startsWith('7카드 스터드 대회 시작')), 'start notice');
  C.send({ t: 'chat', text: '관전 중' });
  await A.until(() => A.chat.some(c => c.text === '관전 중' && c.name === '관전자'), 2000, 'spectator chat');
  console.log(`reconnect ok (B stack was ${stackBefore.stack}, hand ${reB.state.game.handNo})`);

  await A.until(() => A.state.room.phase === 'finished', 240000, 'tournament 1 finished');
  const g = A.state.game;
  const places = g.players.map(p => p.place).sort((a, b) => a - b).join(',');
  assert(places === '1,2,3,4,5,6,7', 'places ' + places);
  assert(g.players.reduce((s, p) => s + p.stack, 0) === 70000, 'chips conserved');
  await A.until(() => A.chat.some(c => c.text.startsWith('대회 종료')), 2000, 'end notice');
  console.log(`computer chat lines in history: ${A.chat.filter(c => String(c.from).startsWith('ai-')).length}`);
  assert(A.chat.length <= 80, 'chat history capped');
  console.log(`tournament 1: ${g.handNo} hands, winner ${g.players.find(p => p.place === 1).name}, A acts ${A.acts}, B acts ${reB.acts}, states A ${A.states}`);

  reB.send({ t: 'rematch' });
  await sleep(50);
  assert(A.state.room.phase === 'finished', 'non-host cannot rematch');
  A.send({ t: 'rematch' });
  await A.until(() => A.state.room.phase === 'lobby', 2000, 'back to lobby');
  assert(A.state.room.members.filter(m => !m.spectator).length === 3, 'spectator seated after rematch');
  C.send({ t: 'leave' });
  await A.until(() => A.state.room.members.length === 2, 2000, 'C left');
  A.send({ t: 'settings', patch: { ais: 0 } });
  await A.until(() => A.state.room.settings.ais === 0, 2000, 'ais 0');
  A.send({ t: 'start' });
  await A.until(() => A.state.room.phase === 'playing' && A.state.game && A.state.game.players.length === 2, 2000, 'heads-up started');
  await A.until(() => A.state.room.phase === 'finished', 240000, 'heads-up finished');
  const hu = A.state.game;
  assert(hu.players.reduce((s, p) => s + p.stack, 0) === 20000, 'heads-up chips');
  console.log(`heads-up: ${hu.handNo} hands, winner ${hu.players.find(p => p.place === 1).name}`);

  A.send({ t: 'rematch' });
  await A.until(() => A.state.room.phase === 'lobby', 2000, 'lobby before holdem');
  const extras = [];
  for (let i = 0; i < 6; i++) {
    const x = new Bot(`손님${i + 1}`, port, 'practice');
    x.auto = false;
    await x.connect();
    x.send({ t: 'join', code: A.code, token: x.token, name: x.name });
    extras.push(x);
  }
  await A.until(() => A.state.room.members.length === 8, 3000, '8 members');
  assert(A.state.room.members.filter(m => m.spectator).length === 1, 'stud lobby seats 7, 8th is spectator');
  A.send({ t: 'settings', patch: { game: 'holdem' } });
  await A.until(() => A.state.room.settings.game === 'holdem', 2000, 'switched to holdem');
  assert(A.state.room.members.filter(m => m.spectator).length === 0, 'holdem seats 8');
  assert(A.state.room.settings.hpl === 10, 'holdem default hpl');
  assert(A.state.room.settings.ais <= 1, 'ais clamped to 9 - 8');
  A.send({ t: 'settings', patch: { game: 'stud' } });
  await A.until(() => A.state.room.settings.game === 'stud', 2000, 'back to stud');
  assert(A.state.room.members.filter(m => m.spectator).length === 1, 'stud again: one spectator');
  A.send({ t: 'settings', patch: { game: 'holdem' } });
  await A.until(() => A.state.room.settings.game === 'holdem', 2000, 'holdem again');
  extras.forEach(x => x.send({ t: 'leave' }));
  await A.until(() => A.state.room.members.length === 2, 3000, 'extras left');
  A.send({ t: 'settings', patch: { ais: 7, hpl: 5 } });
  await A.until(() => A.state.room.settings.ais === 7 && A.state.room.settings.hpl === 5, 2000, 'holdem settings');
  A.acts = 0;
  reB.acts = 0;
  A.send({ t: 'start' });
  await A.until(() => A.state.room.phase === 'playing' && A.state.game && A.state.game.type === 'holdem', 2000, 'holdem started');
  assert(A.state.game.players.length === 9, '9 players');
  assert(A.chat.some(c => c.text.startsWith('노리밋 홀덤 대회 시작') && c.text.includes('20,000')), 'holdem start notice');
  await A.until(() => A.state.room.phase === 'finished', 300000, 'holdem finished');
  const hg = A.state.game;
  const hp = hg.players.map(p => p.place).sort((a, b) => a - b).join(',');
  assert(hp === '1,2,3,4,5,6,7,8,9', 'holdem places ' + hp);
  assert(hg.players.reduce((s2, p) => s2 + p.stack, 0) === 180000, 'holdem chips conserved');
  assert((A.raises || 0) + (reB.raises || 0) > 0, 'bots sent raises with amounts');
  console.log(`holdem: ${hg.handNo} hands, winner ${hg.players.find(p => p.place === 1).name}, acts A ${A.acts} / B ${reB.acts}, raises ${(A.raises || 0) + (reB.raises || 0)}, shown-card states ${(A.sawShown || 0) + (reB.sawShown || 0)}`);

  const D = new Bot('없는방', port);
  await D.connect();
  D.send({ t: 'join', code: 'ZZZZZ', token: D.token, name: 'x' });
  await D.until(() => D.errors.includes('noroom'), 2000, 'noroom error');
  console.log('all online checks passed');
  [A, reB, C, D].concat(extras).forEach(b => b.ws.close());
  await stop();
  process.exit(0);
})().catch(async e => {
  console.error(e);
  process.exit(1);
});
