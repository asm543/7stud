'use strict';

/**
 * 7스터드 온라인 서버
 * 구성 요소
 *  - HTTP: public/ 정적 파일과 /healthz (Render 헬스 체크)
 *  - WebSocket(/ws): 방 만들기·참가·재접속, 설정, 시작, 액션, 다음 핸드 준비, 리매치, 채팅
 *  - Room: 방 하나의 멤버·설정·대회(Tournament)를 관리하고, 서버가 딜러로서 엔진을 돌린다
 *  - 화면 상태(view): 접속자마다 따로 만들며, 히든 카드는 본인 것과 쇼다운 공개분만 담는다
 * 상태는 모두 메모리에만 있어서 서버가 재시작되면 진행 중인 방은 사라진다.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const Stud = require('./public/engine.js');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 5;
const MAX_ROOMS = 200;
const MAX_PLAYERS = 7;
const MAX_MEMBERS = 16;
const ROOM_IDLE_MS = 30 * 60 * 1000;
const DISCONNECTED_TURN_SECS = 45;
const SPEED_MS = { slow: 1100, normal: 650, fast: 260 };
const LOG_LIMIT = 150;
const RATE_WINDOW_MS = 1000;
const RATE_MAX = 30;
const TIME_SCALE = Number(process.env.STUD_TIME_SCALE) || 1;
const CHAT_KEEP = 80;
const CHAT_MAX_LEN = 200;
const CHAT_MIN_INTERVAL_MS = 600;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8'
};

const rooms = new Map();

/**
 * 지정 시간만큼 기다린다.
 * @param {number} ms 밀리초
 * @returns {Promise<void>} 대기 Promise
 */
function sleep(ms) {
  return new Promise(res => setTimeout(res, ms));
}

/**
 * 아직 쓰이지 않은 방 코드를 만든다 (헷갈리는 글자 0/O/1/I 제외).
 * @returns {string} 5자리 방 코드
 */
function makeCode() {
  for (;;) {
    let code = '';
    for (let i = 0; i < CODE_LENGTH; i++) code += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
    if (!rooms.has(code)) return code;
  }
}

/**
 * 공개용 무작위 식별자를 만든다 (재접속 토큰과는 별개).
 * @returns {string} 16자리 hex
 */
function newId() {
  return crypto.randomBytes(8).toString('hex');
}

/**
 * 닉네임을 정리한다: 제어문자·꺾쇠 제거, 앞뒤 공백 제거, 최대 12자.
 * @param {*} s 입력값
 * @returns {string} 정리된 닉네임
 */
function cleanName(s) {
  const name = String(s || '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 12);
  return name || '플레이어';
}

/**
 * 채팅 문장을 정리한다: 제어문자 제거(줄바꿈은 공백), 앞뒤 공백 제거, 최대 200자.
 * @param {*} s 입력값
 * @returns {string} 정리된 문장 (비었으면 빈 문자열)
 */
function cleanChat(s) {
  return String(s || '').replace(/[\r\n\t]+/g, ' ').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, CHAT_MAX_LEN);
}

/**
 * 재접속 토큰 형식을 검사한다.
 * @param {*} token 입력값
 * @returns {boolean} 유효 여부
 */
function validToken(token) {
  return typeof token === 'string' && /^[\w-]{16,64}$/.test(token);
}

/**
 * 참가 인원에 따른 입상 비율.
 * @param {number} n 참가 인원
 * @returns {number[]} 순위별 상금 비율
 */
function payoutTable(n) {
  if (n >= 6) return [0.5, 0.3, 0.2];
  if (n >= 4) return [0.65, 0.35];
  return [1];
}

/**
 * 웹소켓으로 JSON 메시지를 보낸다 (열려 있을 때만).
 * @param {WebSocket} ws 연결
 * @param {object} msg 메시지
 * @returns {void}
 */
function send(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

/**
 * 방 하나.
 * 내부 요소
 *  - members: {clientId, token, name, mode, ws, connected, playerId, spectator}
 *  - settings: ais(컴퓨터 수), hpl(레벨업 간격), speed(진행 속도), turnSecs(턴 제한, 0이면 없음)
 *  - t: 진행 중인 Tournament, runId: 리매치 시 이전 대회를 멈추기 위한 실행 번호
 *  - pending: 사람 차례 대기 정보, next: 다음 핸드 준비 대기 정보
 *  - chat: 최근 채팅·시스템 메시지 (방이 살아 있는 동안 리매치를 넘어 유지)
 */
class Room {
  /**
   * 빈 방을 만든다.
   * @param {string} code 방 코드
   */
  constructor(code) {
    this.code = code;
    this.members = [];
    this.hostId = null;
    this.phase = 'lobby';
    this.settings = { ais: 5, hpl: 6, speed: 'normal', turnSecs: 30 };
    this.t = null;
    this.runId = 0;
    this.pending = null;
    this.next = null;
    this.fast = false;
    this.payout = [];
    this.flushTimer = null;
    this.lastFlush = 0;
    this.lastActive = Date.now();
    this.gateWaiters = [];
    this.chat = [];
    this.chatSeq = 0;
    this.lastLevel = 0;
    this.reportedBusts = new Set();
  }

  /**
   * 채팅 기록에 한 줄을 추가하고 접속자 모두에게 보낸다.
   * @param {{kind:string,from:string|null,name:string,text:string}} item 메시지
   * @returns {void}
   */
  pushChat(item) {
    const msg = Object.assign({ id: ++this.chatSeq, ts: Date.now() }, item);
    this.chat.push(msg);
    if (this.chat.length > CHAT_KEEP) this.chat.splice(0, this.chat.length - CHAT_KEEP);
    this.members.forEach(m => { if (m.connected) send(m.ws, { t: 'chat', items: [msg] }); });
  }

  /**
   * 시스템 안내를 채팅에 남긴다 (입장, 대회 시작, 레벨업, 사람의 팟 획득·탈락, 우승).
   * @param {string} text 안내 문장
   * @returns {void}
   */
  system(text) {
    this.pushChat({ kind: 'system', from: null, name: '', text });
  }

  /**
   * 멤버의 채팅을 받는다. 0.6초 안에 연달아 보내면 버린다.
   * @param {object} m 멤버
   * @param {*} raw 보낸 문장
   * @returns {void}
   */
  say(m, raw) {
    const text = cleanChat(raw);
    const now = Date.now();
    if (!text || now - (m.lastChat || 0) < CHAT_MIN_INTERVAL_MS) return;
    m.lastChat = now;
    this.pushChat({ kind: 'user', from: m.clientId, name: m.name, text });
  }

  /**
   * 마지막 활동 시각을 갱신한다 (빈 방 정리 기준).
   * @returns {void}
   */
  touch() {
    this.lastActive = Date.now();
  }

  /**
   * 대회에서 자리를 가진(관전자가 아닌) 멤버들.
   * @returns {object[]} 멤버 배열
   */
  seated() {
    return this.members.filter(m => !m.spectator);
  }

  /**
   * 접속 중인 멤버가 있는지.
   * @returns {boolean} 여부
   */
  anyConnected() {
    return this.members.some(m => m.connected);
  }

  /**
   * 엔진 플레이어 id로 그 자리의 멤버를 찾는다.
   * @param {number} playerId 엔진 플레이어 id
   * @returns {object|undefined} 멤버
   */
  memberOf(playerId) {
    return this.members.find(m => m.playerId === playerId);
  }

  /**
   * 멤버를 추가하거나, 같은 토큰이면 재접속으로 처리한다.
   * 로비에서는 자리가 남아 있으면 선수로, 아니면 관전자로 들어온다.
   * @param {string} token 재접속 토큰
   * @param {string} name 닉네임
   * @param {WebSocket} ws 연결
   * @returns {object} 멤버
   */
  addMember(token, name, ws) {
    let m = this.members.find(x => x.token === token);
    if (m) {
      if (m.ws && m.ws !== ws) {
        send(m.ws, { t: 'error', code: 'replaced', msg: '다른 창에서 같은 자리로 접속했어요.' });
        m.ws.ctx = null;
      }
      m.ws = ws;
      m.connected = true;
      if (this.phase === 'lobby') m.name = name;
    } else {
      const spectator = this.phase !== 'lobby' || this.seated().length >= MAX_PLAYERS;
      m = { clientId: newId(), token, name, mode: 'practice', ws, connected: true, playerId: null, spectator, lastChat: 0 };
      this.members.push(m);
      this.clampAis();
      this.system(this.members.length === 1 ? `${name} 님이 방을 만들었어요` : `${name} 님이 들어왔어요${spectator ? ' (관전)' : ''}`);
    }
    if (!this.hostId || !this.members.some(x => x.clientId === this.hostId && x.connected)) this.hostId = m.clientId;
    this.touch();
    this.openGate();
    if (this.pending && this.pending.playerId === m.playerId && m.playerId !== null) this.armTurnTimer();
    return m;
  }

  /**
   * 멤버의 연결이 끊겼을 때 처리한다. 방장이면 접속 중인 다른 사람에게 넘기고, 본인 차례면 제한 시간을 건다.
   * @param {object} m 멤버
   * @returns {void}
   */
  onDisconnect(m) {
    m.connected = false;
    m.ws = null;
    if (this.hostId === m.clientId) {
      const other = this.members.find(x => x.connected);
      if (other) this.hostId = other.clientId;
    }
    if (this.pending && this.pending.playerId === m.playerId) this.armTurnTimer();
    if (this.next) this.maybeResolveNext();
    this.queueFlush();
  }

  /**
   * 멤버를 방에서 내보낸다. 대회 중이면 자리는 유지하고 연결만 끊은 것으로 처리한다.
   * @param {object} m 멤버
   * @returns {void}
   */
  leave(m) {
    this.system(`${m.name} 님이 나갔어요`);
    if (this.phase === 'lobby' || m.playerId === null) {
      this.members = this.members.filter(x => x !== m);
      if (this.hostId === m.clientId) this.hostId = (this.members.find(x => x.connected) || this.members[0] || {}).clientId || null;
      this.queueFlush();
    } else {
      this.onDisconnect(m);
    }
  }

  /**
   * 사람 수에 맞춰 컴퓨터 수를 총 2~7명 범위로 맞춘다.
   * @returns {void}
   */
  clampAis() {
    const humans = this.seated().length;
    this.settings.ais = Math.max(0, Math.min(this.settings.ais, MAX_PLAYERS - humans));
  }

  /**
   * 방장이 바꾼 설정을 검증해서 적용한다.
   * @param {object} patch 바꿀 설정
   * @returns {void}
   */
  applySettings(patch) {
    const s = this.settings;
    if (Number.isInteger(patch.ais)) s.ais = patch.ais;
    if ([3, 4, 6].includes(patch.hpl)) s.hpl = patch.hpl;
    if (SPEED_MS[patch.speed]) s.speed = patch.speed;
    if ([0, 20, 30, 60].includes(patch.turnSecs)) s.turnSecs = patch.turnSecs;
    this.clampAis();
  }

  /**
   * 대회를 시작한다. 접속이 끊긴 로비 멤버는 빼고, 남는 자리는 컴퓨터로 채운다.
   * @returns {string|null} 실패 사유, 성공 시 null
   */
  start() {
    this.members = this.members.filter(m => m.connected);
    const humans = this.seated().filter(m => m.connected);
    this.clampAis();
    if (humans.length + this.settings.ais < 2) return '사람과 컴퓨터를 합쳐 2명 이상이어야 해요.';
    const personas = Stud.pickAiPlayers(this.settings.ais, Math.random);
    const players = humans.map(m => ({ name: m.name, isHuman: true })).concat(personas);
    this.members.forEach(m => { m.playerId = null; });
    humans.forEach((m, i) => { m.playerId = i; });
    this.runId++;
    this.fast = false;
    this.pending = null;
    this.clearNext();
    this.payout = payoutTable(players.length);
    this.lastLevel = 0;
    this.reportedBusts = new Set();
    this.system(`대회 시작 · ${players.length}명 (사람 ${humans.length} + 컴퓨터 ${personas.length}) · 시작 스택 10,000`);
    this.t = new Stud.Tournament({ players, controller: this.controller(this.runId), handsPerLevel: this.settings.hpl, sims: 160, paidPlaces: this.payout.length });
    this.phase = 'playing';
    const runId = this.runId;
    const t = this.t;
    t.run().then(() => {
      if (runId !== this.runId) return;
      this.phase = 'finished';
      this.queueFlush();
    }).catch(err => {
      console.error(`[${this.code}] tournament error`, err);
      t.addLog('서버 오류로 대회가 중단됐어요: ' + err.message, 'bust');
      this.phase = 'finished';
      this.queueFlush();
    });
    this.queueFlush();
    return null;
  }

  /**
   * 리매치: 같은 멤버로 로비로 돌아간다. 관전자도 자리가 남으면 선수가 된다.
   * @returns {void}
   */
  rematch() {
    this.runId++;
    if (this.pending) clearTimeout(this.pending.timer);
    this.pending = null;
    this.clearNext();
    this.t = null;
    this.phase = 'lobby';
    this.system('같은 방에서 새 대회를 준비해요');
    this.members = this.members.filter(m => m.connected);
    this.members.forEach((m, i) => { m.playerId = null; m.spectator = i >= MAX_PLAYERS; });
    this.clampAis();
    this.queueFlush();
  }

  /**
   * 접속자가 아무도 없으면 누군가 돌아올 때까지 진행을 멈추는 대기 Promise.
   * @returns {Promise<void>} 진행 가능해지면 끝나는 Promise
   */
  gate() {
    if (this.anyConnected()) return Promise.resolve();
    return new Promise(res => this.gateWaiters.push(res));
  }

  /**
   * gate()로 멈춘 진행을 재개한다.
   * @returns {void}
   */
  openGate() {
    const waiters = this.gateWaiters;
    this.gateWaiters = [];
    waiters.forEach(res => res());
  }

  /**
   * 이번 핸드에 아직 살아 있는(폴드 안 한) 사람이 있는지.
   * @returns {boolean} 여부
   */
  humanInHand() {
    return !!this.t && this.t.players.some(p => p.isHuman && p.inHand && !p.folded);
  }

  /**
   * 엔진 이벤트 중 사람에게 의미 있는 것만 채팅 안내로 남긴다.
   * @param {string} type 엔진 이벤트 종류
   * @param {object} t Tournament
   * @returns {void}
   */
  announce(type, t) {
    if (!t) return;
    if (type === 'deal' && t.hand && t.hand.street === 3) {
      const idx = t.levelIndex();
      if (idx !== this.lastLevel) {
        this.lastLevel = idx;
        const L = Stud.LEVELS[idx];
        this.system(`레벨 ${idx + 1} 시작 · 앤티 ${Stud.fmt(L.ante)} / 브링인 ${Stud.fmt(L.bringIn)} / ${Stud.fmt(L.small)}-${Stud.fmt(L.big)}`);
      }
    } else if (type === 'settle') {
      t.players.filter(p => p.isHuman && p.won > 0).forEach(p => {
        this.system(`핸드 #${t.handNo} · ${p.name} +${Stud.fmt(p.won)}${p.result ? ` (${p.result})` : ' (상대 전원 폴드)'}`);
      });
    } else if (type === 'handEnd') {
      t.players.filter(p => p.isHuman && p.busted && !this.reportedBusts.has(p.id)).forEach(p => {
        this.reportedBusts.add(p.id);
        this.system(`${p.name} 님이 ${p.place}위로 탈락했어요`);
      });
    } else if (type === 'tournamentEnd') {
      const w = t.players.find(p => p.place === 1);
      if (w) this.system(`대회 종료 · 우승 ${w.name}${w.isHuman ? '' : ' (컴퓨터)'} · ${t.handNo}핸드`);
    }
  }

  /**
   * 엔진과 방을 잇는 컨트롤러를 만든다. 리매치로 runId가 바뀌면 이전 대회는 영원히 멈춘다.
   * @param {number} runId 이 대회의 실행 번호
   * @returns {object} onEvent / wait / humanAction / afterHand
   */
  controller(runId) {
    const alive = () => runId === this.runId;
    const never = () => new Promise(() => {});
    return {
      onEvent: (type, data, t) => {
        if (!alive()) return;
        this.touch();
        if (type === 'talk' && data) this.pushChat({ kind: 'user', from: `ai-${data.id}`, name: data.name, text: data.text });
        this.announce(type, t);
        if (type === 'tournamentEnd') this.phase = 'finished';
        this.queueFlush();
      },
      wait: async (p, t, kind) => {
        if (!alive()) return never();
        await this.gate();
        if (this.fast) return undefined;
        const base = SPEED_MS[this.settings.speed];
        return sleep(TIME_SCALE * (kind === 'runout' ? base * 1.3 : this.humanInHand() ? base : base * 0.35));
      },
      humanAction: (p, legal, t) => {
        if (!alive()) return never();
        return new Promise(res => {
          this.pending = { playerId: p.id, legal, res, handNo: t.handNo, deadline: null, timer: null };
          this.armTurnTimer();
          this.queueFlush();
        });
      },
      afterHand: async t => {
        if (!alive()) return never();
        if (this.t.players.filter(p => p.isHuman).every(p => p.busted)) {
          this.fast = true;
          this.t.sims = 50;
        }
        if (this.fast) return sleep(0);
        await this.gate();
        const involved = t.players.some(p => p.isHuman && p.inHand && !p.folded);
        const waitMs = TIME_SCALE * (involved ? 15000 : 2500);
        return new Promise(res => {
          this.next = { res, ready: new Set(), deadline: Date.now() + waitMs, timer: setTimeout(() => this.resolveNext(), waitMs) };
          this.queueFlush();
          this.maybeResolveNext();
        });
      }
    };
  }

  /**
   * 현재 사람 차례의 제한 시간을 건다. 연결이 끊긴 사람은 제한 시간이 없어도 45초 뒤 자동 액션.
   * @returns {void}
   */
  armTurnTimer() {
    const pd = this.pending;
    if (!pd) return;
    clearTimeout(pd.timer);
    const m = this.memberOf(pd.playerId);
    let secs = this.settings.turnSecs;
    if (!m || !m.connected) secs = secs ? Math.min(secs, DISCONNECTED_TURN_SECS) : DISCONNECTED_TURN_SECS;
    if (secs) {
      pd.deadline = Date.now() + secs * 1000 * TIME_SCALE;
      pd.timer = setTimeout(() => this.autoAct(), secs * 1000 * TIME_SCALE);
    } else {
      pd.deadline = null;
      pd.timer = null;
    }
    this.queueFlush();
  }

  /**
   * 시간 초과 시 자동 액션: 체크 > 브링인 > 폴드 순.
   * @returns {void}
   */
  autoAct() {
    const pd = this.pending;
    if (!pd) return;
    const a = pd.legal.find(x => x.type === 'check') || pd.legal.find(x => x.type === 'bringin') || pd.legal.find(x => x.type === 'fold');
    const p = this.t.players.find(x => x.id === pd.playerId);
    this.t.addLog(`${p.name}: 시간 초과 → ${a.type}`, 'street');
    this.pending = null;
    pd.res(a);
  }

  /**
   * 사람이 보낸 액션을 검증해서 엔진에 넘긴다.
   * @param {object} m 멤버
   * @param {object} msg {handNo, i, type}
   * @returns {void}
   */
  submitAct(m, msg) {
    const pd = this.pending;
    if (!pd || m.playerId === null || pd.playerId !== m.playerId || msg.handNo !== pd.handNo) return;
    const a = pd.legal[msg.i];
    if (!a || a.type !== msg.type) return;
    clearTimeout(pd.timer);
    this.pending = null;
    pd.res(a);
  }

  /**
   * 다음 핸드 준비 표시를 받는다.
   * @param {object} m 멤버
   * @returns {void}
   */
  ready(m) {
    if (!this.next) return;
    this.next.ready.add(m.clientId);
    this.queueFlush();
    this.maybeResolveNext();
  }

  /**
   * 접속 중이고 탈락하지 않은 사람이 모두 준비했으면 다음 핸드로 넘어간다.
   * @returns {void}
   */
  maybeResolveNext() {
    if (!this.next || !this.t) return;
    const need = this.members.filter(m => m.connected && m.playerId !== null && !this.t.players[this.playerIndex(m.playerId)].busted);
    if (need.length && need.every(m => this.next.ready.has(m.clientId))) this.resolveNext();
  }

  /**
   * 엔진 플레이어 id로 t.players 배열 위치를 찾는다 (좌석 순 정렬이라 id와 다름).
   * @param {number} playerId 엔진 플레이어 id
   * @returns {number} 배열 인덱스
   */
  playerIndex(playerId) {
    return this.t.players.findIndex(p => p.id === playerId);
  }

  /**
   * 다음 핸드 대기를 끝낸다.
   * @returns {void}
   */
  resolveNext() {
    const nx = this.next;
    if (!nx) return;
    clearTimeout(nx.timer);
    this.next = null;
    nx.res();
    this.queueFlush();
  }

  /**
   * 다음 핸드 대기를 결과 없이 정리한다 (리매치·재시작용).
   * @returns {void}
   */
  clearNext() {
    if (this.next) clearTimeout(this.next.timer);
    this.next = null;
  }

  /**
   * 화면 상태 전송을 예약한다. 같은 틱의 여러 이벤트는 한 번으로 묶고, 빠른 진행 중에는 0.25초 간격으로 줄인다.
   * @returns {void}
   */
  queueFlush() {
    if (this.flushTimer) return;
    const delay = this.fast ? Math.max(0, 250 - (Date.now() - this.lastFlush)) : 0;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.lastFlush = Date.now();
      this.members.forEach(m => { if (m.connected) send(m.ws, this.viewFor(m)); });
    }, delay);
  }

  /**
   * 멤버 한 명에게 보낼 화면 상태를 만든다.
   * 히든 카드는 본인 것과 쇼다운에서 공개된 것만 담고, 실전 모드 멤버에게는 폴드한 사람의 오픈 카드도 빼서 보낸다.
   * @param {object} m 멤버
   * @returns {object} state 메시지
   */
  viewFor(m) {
    const view = {
      t: 'state',
      serverNow: Date.now(),
      room: {
        code: this.code,
        phase: this.phase,
        hostId: this.hostId,
        settings: this.settings,
        payout: this.payout,
        members: this.members.map(x => ({
          clientId: x.clientId, name: x.name, connected: x.connected, spectator: x.spectator, playerId: x.playerId, mode: x.mode
        }))
      },
      you: { clientId: m.clientId, playerId: m.playerId, mode: m.mode, host: m.clientId === this.hostId },
      game: null
    };
    const t = this.t;
    if (!t) return view;
    const practice = m.mode === 'practice';
    const h = t.hand;
    view.game = {
      handNo: t.handNo,
      levelIndex: t.levelIndex(),
      handsPerLevel: t.handsPerLevel,
      startingStack: t.startingStack,
      finished: t.finished,
      fast: this.fast,
      players: t.players.map(p => {
        const owner = p.isHuman ? this.memberOf(p.id) : null;
        const mine = p.id === m.playerId;
        const hideAll = p.folded && !practice && !mine;
        return {
          id: p.id, name: p.name, isHuman: p.isHuman, seat: p.seat, stack: p.stack, busted: p.busted, place: p.place,
          inHand: p.inHand, folded: p.folded, allIn: p.allIn, bet: p.bet, lastAction: p.lastAction || '',
          shown: !!p.shown, result: p.result || '', won: p.won || 0,
          connected: owner ? owner.connected : true,
          cards: hideAll ? [] : p.cards.map(x => ({ up: x.up, c: x.up || mine || p.shown ? x.c : null }))
        };
      }),
      hand: h ? {
        street: h.street, unit: h.unit, currentBet: h.currentBet, raises: h.raises, bringInSeat: h.bringInSeat,
        actingSeat: h.actingSeat, done: h.done, showdown: h.showdown, pot: t.potTotal(),
        deadUp: practice ? h.deadUp.slice() : [],
        pots: (h.pots || []).map(pt => ({ amount: pt.amount, winners: pt.winners.map(w => w.id) }))
      } : null,
      log: t.log.slice(-LOG_LIMIT)
    };
    if (this.pending) {
      view.turn = { playerId: this.pending.playerId, deadline: this.pending.deadline };
      if (this.pending.playerId === m.playerId) view.yourTurn = { handNo: this.pending.handNo, legal: this.pending.legal };
    }
    if (this.next) {
      view.next = { deadline: this.next.deadline, ready: Array.from(this.next.ready), you: this.next.ready.has(m.clientId) };
    }
    return view;
  }
}

/**
 * 연결을 방에 붙인다 (새 참가 또는 재접속).
 * @param {WebSocket} ws 연결
 * @param {Room} room 방
 * @param {object} msg {token, name}
 * @returns {void}
 */
function attach(ws, room, msg) {
  if (!validToken(msg.token)) return send(ws, { t: 'error', code: 'token', msg: '접속 정보가 올바르지 않아요. 새로고침해 주세요.' });
  if (ws.ctx && ws.ctx.room && ws.ctx.room !== room) ws.ctx.room.onDisconnect(ws.ctx.member);
  const isNew = !room.members.some(x => x.token === msg.token);
  if (isNew && room.members.length >= MAX_MEMBERS) return send(ws, { t: 'error', code: 'full', msg: '방이 가득 찼어요.' });
  const member = room.addMember(msg.token, cleanName(msg.name), ws);
  ws.ctx = { room, member };
  send(ws, { t: 'joined', code: room.code, clientId: member.clientId });
  send(ws, { t: 'chat', reset: true, items: room.chat });
  room.queueFlush();
}

/**
 * 클라이언트 메시지 하나를 처리한다.
 * @param {WebSocket} ws 연결
 * @param {object} msg 파싱된 메시지
 * @returns {void}
 */
function handle(ws, msg) {
  if (!msg || typeof msg.t !== 'string') return;
  if (msg.t === 'create') {
    if (rooms.size >= MAX_ROOMS) return send(ws, { t: 'error', code: 'busy', msg: '지금은 방을 더 만들 수 없어요. 잠시 뒤에 다시 시도해 주세요.' });
    const room = new Room(makeCode());
    rooms.set(room.code, room);
    return attach(ws, room, msg);
  }
  if (msg.t === 'join') {
    const room = rooms.get(String(msg.code || '').toUpperCase().trim());
    if (!room) return send(ws, { t: 'error', code: 'noroom', msg: '방을 찾을 수 없어요. 코드를 확인하거나, 서버가 재시작돼서 방이 사라졌을 수 있어요.' });
    return attach(ws, room, msg);
  }
  const ctx = ws.ctx;
  if (!ctx || !ctx.room) return;
  const { room, member } = ctx;
  room.touch();
  const isHost = room.hostId === member.clientId;
  switch (msg.t) {
    case 'ping':
      return send(ws, { t: 'pong' });
    case 'mode':
      if (msg.mode === 'practice' || msg.mode === 'real') member.mode = msg.mode;
      return room.queueFlush();
    case 'settings':
      if (isHost && room.phase === 'lobby' && msg.patch && typeof msg.patch === 'object') room.applySettings(msg.patch);
      return room.queueFlush();
    case 'start':
      if (isHost && room.phase === 'lobby') {
        const err = room.start();
        if (err) send(ws, { t: 'error', code: 'start', msg: err });
      }
      return undefined;
    case 'act':
      return room.submitAct(member, msg);
    case 'ready':
      return room.ready(member);
    case 'chat':
      return room.say(member, msg.text);
    case 'rematch':
      if (isHost && room.phase === 'finished') room.rematch();
      return undefined;
    case 'leave':
      room.leave(member);
      ws.ctx = null;
      return send(ws, { t: 'left' });
    default:
      return undefined;
  }
}

/**
 * 오래 비어 있는 방을 지운다.
 * @returns {void}
 */
function sweepRooms() {
  const now = Date.now();
  rooms.forEach((room, code) => {
    if (!room.anyConnected() && now - room.lastActive > ROOM_IDLE_MS) {
      room.runId++;
      if (room.pending) clearTimeout(room.pending.timer);
      room.clearNext();
      rooms.delete(code);
    }
  });
}

/**
 * public/ 아래 정적 파일을 제공한다. 경로 이탈은 막는다.
 * @param {http.IncomingMessage} req 요청
 * @param {http.ServerResponse} res 응답
 * @returns {void}
 */
function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    return;
  }
  const rel = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    res.end();
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    const ext = path.extname(file);
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
      'x-content-type-options': 'nosniff'
    });
    res.end(data);
  });
}

const server = http.createServer(serveStatic);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096 });

wss.on('connection', ws => {
  ws.isAlive = true;
  ws.ctx = null;
  ws.rate = { start: Date.now(), count: 0 };
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', raw => {
    const now = Date.now();
    if (now - ws.rate.start > RATE_WINDOW_MS) ws.rate = { start: now, count: 0 };
    if (++ws.rate.count > RATE_MAX) return;
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      return;
    }
    try {
      handle(ws, msg);
    } catch (e) {
      console.error('handle error', e);
    }
  });
  ws.on('close', () => {
    const ctx = ws.ctx;
    if (ctx && ctx.member && ctx.member.ws === ws) ctx.room.onDisconnect(ctx.member);
  });
});

const heartbeat = setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) {
      ws.terminate();
      return;
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);
const sweeper = setInterval(sweepRooms, 5 * 60 * 1000);

/**
 * 서버를 지정 포트로 띄운다.
 * @param {number} port 포트 (0이면 임의 포트)
 * @returns {Promise<number>} 실제 포트
 */
function start(port) {
  return new Promise(res => server.listen(port, () => res(server.address().port)));
}

/**
 * 서버와 주기 작업을 멈춘다 (테스트·종료용).
 * @returns {Promise<void>} 종료 Promise
 */
function stop() {
  clearInterval(heartbeat);
  clearInterval(sweeper);
  wss.clients.forEach(ws => ws.terminate());
  return new Promise(res => server.close(() => res()));
}

if (require.main === module) {
  start(PORT).then(port => console.log(`7stud server listening on :${port}`));
  process.on('SIGTERM', () => stop().then(() => process.exit(0)));
}

module.exports = { start, stop, rooms, Room };
