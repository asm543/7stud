# 7스터드 온라인

친구와 방을 만들어 7카드 스터드 토너먼트(고정 리밋, 대회 룰)를 하는 웹 앱이에요.
계정 없이 방 코드나 초대 링크만 있으면 들어올 수 있고, 빈자리는 컴퓨터 상대가 채워요.

- 서버가 딜러: 셔플, 컴퓨터 판단, 룰 판정을 모두 서버에서 해요. 각 브라우저는 **자기 히든 카드만** 받아서, 개발자 도구로 봐도 남의 카드는 없어요.
- 2~7명 (사람 1~7명 + 컴퓨터 0~6명). 사람끼리 헤즈업도 돼요.
- 대회 룰: 앤티 + 브링인(같은 숫자면 ♣ < ♦ < ♥ < ♠), complete, 3·4구 스몰 / 5구부터 빅, 4구 오픈 페어 더블벳 없음, 캡 = 베트 1 + 레이즈 3, 사이드팟, 레벨업.
- 개인별 모드: 연습(죽은 카드·힌트 표시) / 실전(폴드한 카드는 직접 기억). 실전 모드인 사람에게는 서버가 폴드한 카드를 아예 보내지 않아요.
- 턴 제한 시간(20/30/60초/없음), 끊겨도 같은 브라우저로 다시 들어오면 같은 자리로 복귀, 대회 중 들어온 사람은 관전, 끝나면 같은 방에서 한 판 더.

## 로컬에서 실행

Node.js 18 이상이 필요해요.

```bash
npm install
npm start
```

브라우저에서 http://localhost:3000 을 열면 돼요. 같은 와이파이의 친구는 `http://<내 PC IP>:3000` 으로 들어올 수 있어요.
포트는 환경 변수 `PORT`로 바꿀 수 있어요.

테스트:

```bash
npm test
```

- `test/engine.test.js`: 족보 평가 단위 테스트 + 컴퓨터끼리 대회 120번 (칩 보존, 레이즈 캡, 베팅 매칭)
- `test/online.test.js`: 서버를 띄우고 봇 3명으로 대회 완주, 히든 카드 유출 검사, 재접속, 관전, 리매치, 헤즈업

## Render에 무료로 배포

1. GitHub에 새 저장소를 만들고 이 폴더를 올려요.
   ```bash
   git init
   git add .
   git commit -m "7stud online"
   git branch -M main
   git remote add origin https://github.com/<아이디>/<저장소>.git
   git push -u origin main
   ```
2. Render 대시보드에서 **New → Blueprint** → GitHub 저장소 연결 → 저장소 선택. `render.yaml`을 읽어서 무료 웹 서비스를 만들어요.
   - Blueprint 대신 **New → Web Service**로 해도 돼요: Runtime `Node`, Build Command `npm install`, Start Command `npm start`, Instance Type `Free`, Health Check Path `/healthz`.
3. 배포가 끝나면 `https://<서비스 이름>.onrender.com` 으로 접속해서 방을 만들고, 초대 링크를 친구에게 보내면 끝이에요.

이후 `main` 브랜치에 push하면 자동으로 다시 배포돼요.

### 무료 플랜에서 알아둘 점

- 15분 동안 아무 요청도 없으면 서버가 잠들고, 다음 접속 때 깨어나는 데 1분 정도 걸려요. 페이지를 열어 둔 동안에는 클라이언트가 25초마다 신호를 보내서 잠들지 않아요.
- 방과 대회 상태는 메모리에만 있어요. 재배포하거나 서버가 재시작되면 진행 중인 방은 사라져요.
- 서버 인스턴스 하나를 전제로 만들었어요 (여러 대로 늘리면 방이 서로 안 보여요).

## 구조

```
server.js          HTTP(정적 파일, /healthz) + WebSocket(/ws) 방 서버
public/engine.js   게임 엔진 (서버·브라우저 공용): 족보, 승률 추정, 토너먼트 진행, 컴퓨터 판단
public/index.html  화면: 홈(방 만들기/참가), 로비, 테이블, 결과
test/              엔진·온라인 테스트
render.yaml        Render Blueprint
```

### 메시지 (JSON, `/ws`)

브라우저 → 서버

| t | 내용 |
|---|---|
| `create` | `{token, name}` 새 방 |
| `join` | `{code, token, name}` 참가 또는 재접속 (같은 token이면 같은 자리) |
| `mode` | `{mode: 'practice' \| 'real'}` 내 모드 |
| `settings` | `{patch: {ais, hpl, speed, turnSecs}}` 방장만, 로비에서 |
| `start` / `rematch` | 방장만 |
| `act` | `{handNo, i, type}` 내 차례 액션 (legal 배열 인덱스) |
| `ready` | 다음 핸드 준비 |
| `leave` / `ping` | 나가기 / 연결 유지 |

서버 → 브라우저: `joined {code, clientId}`, `state {room, you, game, turn?, yourTurn?, next?}`, `error {code, msg}`, `left`.

### 조정할 만한 값 (`server.js` 위쪽 상수)

- `MAX_ROOMS` 200, `MAX_PLAYERS` 7, `MAX_MEMBERS` 16 (관전 포함)
- `ROOM_IDLE_MS` 아무도 없는 방을 지우는 시간 (30분)
- `SPEED_MS` 컴퓨터 진행 속도, `DISCONNECTED_TURN_SECS` 연결이 끊긴 사람의 자동 액션 대기 (45초)

## 알려진 한계

- 계정·전적 저장이 없어요. 칩은 가상이고 실제 돈과 관계없어요.
- 방 코드를 아는 사람은 누구나 들어올 수 있어요 (자리가 없거나 대회 중이면 관전).
- 컴퓨터 상대와 힌트의 승률은 상대 히든 카드를 무작위로 가정한 추정이라, 실제보다 조금 낙관적일 수 있어요.
