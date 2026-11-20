'use strict';

/**
 * 프리플랍 169개 핸드 순위표 생성기
 * 각 핸드 종류(AA, AKs, AKo ...)의 승률을 몬테카를로로 구해서 강한 순서로 정렬한 문자열을 출력한다.
 * 순위 점수 = 무작위 1명 상대 승률 × 0.65 + 무작위 3명 상대 승률(인원 보정) × 0.35
 *  - 1명 상대 승률만 쓰면 오프수트 하이카드가 과대평가되고, 멀티웨이 승률을 섞으면 수딧 커넥터·포켓 페어가 제자리를 찾는다.
 * 출력 결과는 public/holdem.js의 PREFLOP_ORDER에 붙여 넣는다.
 * 사용법: node scripts/gen-preflop.js [시뮬레이션 수=6000]
 */
const Stud = require('../public/engine.js');

const RANKS = 'AKQJT98765432';

/**
 * 핸드 종류 이름에 맞는 카드 두 장(무늬는 대표값)을 만든다.
 * @param {number} hi 높은 숫자 (2~14)
 * @param {number} lo 낮은 숫자 (2~14)
 * @param {boolean} suited 같은 무늬 여부
 * @returns {number[]} 카드 정수 두 장
 */
function cardsFor(hi, lo, suited) {
  return [hi * 4 + 3, lo * 4 + (suited ? 3 : 2)];
}

/**
 * 무작위 상대 n명에 대한 승률을 몬테카를로로 구한다.
 * @param {number[]} hole 내 카드 두 장
 * @param {number} opps 상대 수
 * @param {number} sims 시뮬레이션 수
 * @param {function(): number} rng 난수 함수
 * @returns {number} 0~1 승률 (무승부는 나눠서 반영)
 */
function equity(hole, opps, sims, rng) {
  const pool = [];
  for (let c = 8; c < 60; c++) if (hole.indexOf(c) < 0) pool.push(c);
  const need = 5 + opps * 2;
  let acc = 0;
  for (let n = 0; n < sims; n++) {
    for (let i = 0; i < need; i++) {
      const j = i + Math.floor(rng() * (pool.length - i));
      const tmp = pool[i];
      pool[i] = pool[j];
      pool[j] = tmp;
    }
    const board = pool.slice(0, 5);
    const mine = Stud.evaluate(hole.concat(board));
    let lost = false;
    let ties = 0;
    for (let o = 0; o < opps && !lost; o++) {
      const s = Stud.evaluate([pool[5 + o * 2], pool[6 + o * 2]].concat(board));
      if (s > mine) lost = true;
      else if (s === mine) ties++;
    }
    if (!lost) acc += 1 / (ties + 1);
  }
  return acc / sims;
}

/**
 * 169개 핸드 종류를 모두 평가해 순위 문자열을 출력한다.
 * @returns {void}
 */
function main() {
  const sims = Number(process.argv[2]) || 6000;
  const rng = Stud.makeRng(20261120);
  const rows = [];
  for (let i = 0; i < 13; i++) {
    for (let j = i; j < 13; j++) {
      const hi = 14 - i;
      const lo = 14 - j;
      const kinds = i === j ? [[RANKS[i] + RANKS[j], false]] : [[RANKS[i] + RANKS[j] + 's', true], [RANKS[i] + RANKS[j] + 'o', false]];
      kinds.forEach(([name, suited]) => {
        const hole = cardsFor(hi, lo, suited);
        const e1 = equity(hole, 1, sims, rng);
        const e3 = equity(hole, 3, sims, rng);
        rows.push({ name, e1, e3, score: e1 * 0.65 + e3 * 2 * 0.35 });
      });
    }
  }
  rows.sort((a, b) => b.score - a.score);
  console.log(rows.map(r => r.name).join(' '));
  console.error(rows.slice(0, 40).map(r => `${r.name} ${r.e1.toFixed(3)} ${r.e3.toFixed(3)}`).join('\n'));
}

main();
