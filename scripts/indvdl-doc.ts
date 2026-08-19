/**
 * 보고서 원문에서 "보수지급금액 5억원 이상 중 상위 5명의 개인별 보수현황" 표를
 * 뽑아 indvdlByPay API와 같은 형태로 만든다.
 *
 * OpenDART의 indvdlByPay는 원문 접수 후 적재까지 시차가 있어, 공시가 이미
 * 올라왔는데도 한동안 013(데이터 없음)이 나온다. 그동안 원문에서 직접 읽는다.
 *
 * 표는 사람 하나가 TABLE-GROUP 하나이고, 그 안에 당기·전기·전전기 블록이 있다.
 *
 *   이름   | 사업연도 | 직위       | 보수총액 | …
 *   신윤철 | 당기     | 영업지점장 |    1,469 | …   ← CFY, 반기보고서면 상반기
 *          | 전기     | 영업지점장 |    1,698 | …   ← PFY, 연간
 *          | 전전기   | 영업지점장 |    1,328 | …   ← BPFY, 연간
 *
 * 칸은 위치가 아니라 ACODE 속성으로 집는다(CMPK_NM/CMPK_LEV/CMPK_PAY).
 * 회사마다 표 폭과 헤더 문구가 달라도 이 코드는 DART 서식이 강제한다.
 */
import * as cheerio from "cheerio";

export type IndvdlDocRow = {
  name: string;
  position: string;
  /** 원 단위로 환산한 보수 총액 */
  total: number;
};

const UNIT_MULTIPLIER: Record<string, number> = {
  원: 1,
  천원: 1_000,
  만원: 10_000,
  백만원: 1_000_000,
  억원: 100_000_000,
};

/** 당기 = 이 보고서의 대상 기간. 반기보고서면 상반기다. */
const CURRENT_TERM = "CFY";

/**
 * 상위 5명 표는 ACLASS="SUB_CMPK_HIGH" 인 TABLE-GROUP 으로 나온다.
 * 이사·감사 표는 ACLASS 가 달라서 이것만 집으면 섞이지 않는다.
 *
 * 제목으로 구간을 잘라내는 방식은 쓰지 않는다. 표가 문서 끝에 있으면 끝 경계를
 * 못 찾아 뒤따르는 다른 표까지 삼킨다(키움 문서에서 119만 자가 딸려왔다).
 */
const GROUP_PATTERN =
  /<TABLE-GROUP[^>]*ACLASS="SUB_CMPK_HIGH"[^>]*>[\s\S]*?<\/TABLE-GROUP>/g;

/**
 * 단위 표기는 그룹 밖 별도 표에 한 번만 적히고 뒤따르는 표들이 공유한다.
 * 그래서 그룹 앞쪽에서 가장 가까운 것을 찾아 이어받는다.
 */
function unitBefore(doc: string, at: number): number {
  const window = doc.slice(Math.max(0, at - 20_000), at);
  const matches = [...window.matchAll(/\(단위\s*:\s*([^)]*)\)/g)];
  const text = matches.at(-1)?.[1] ?? "";

  for (const unit of ["백만원", "억원", "만원", "천원", "원"]) {
    if (text.includes(unit)) return UNIT_MULTIPLIER[unit];
  }
  return 1;
}

function toNumber(raw: string): number | null {
  const cleaned = raw.replace(/[,\s]/g, "").replace(/[()]/g, "");
  if (!cleaned || cleaned === "-") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * 그룹 하나에서 당기 행만 뽑는다.
 *
 * 전기·전전기는 연간 금액이라 반기 데이터에 섞이면 안 된다. 각주의
 * "각 사업연도 마지막월 평균종가 … 2026년 6월" 표기가 이 구분을 뒷받침한다.
 */
function parseGroup(group: string, multiplier: number): IndvdlDocRow | null {
  const $ = cheerio.load(group, { xml: true });

  const name = $('[ACODE="CMPK_NM"]').first().text().trim();
  if (!name) return null;

  // 당기 표시가 붙은 행에 직위와 보수총액이 같이 들어 있다.
  const $current = $(`[AUNITVALUE="${CURRENT_TERM}"]`).first().closest("TR");
  if (!$current.length) return null;

  const position = $current.find('[ACODE="CMPK_LEV"]').first().text().trim();
  const amount = toNumber($current.find('[ACODE="CMPK_PAY"]').first().text().trim());
  if (amount === null) return null;

  return {
    name,
    position: position || "-",
    total: Math.round(amount * multiplier),
  };
}

export function parseIndvdlDoc(doc: string): IndvdlDocRow[] {
  const rows: IndvdlDocRow[] = [];

  for (const match of doc.matchAll(GROUP_PATTERN)) {
    const row = parseGroup(match[0], unitBefore(doc, match.index ?? 0));
    if (row) rows.push(row);
  }
  return dedupe(rows);
}

/** 같은 사람이 여러 표에 반복되는 경우가 있어 이름+직위로 한 번 걸러낸다. */
function dedupe(rows: IndvdlDocRow[]): IndvdlDocRow[] {
  const seen = new Set<string>();
  return rows.filter((r) => {
    const key = `${r.name}|${r.position}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
