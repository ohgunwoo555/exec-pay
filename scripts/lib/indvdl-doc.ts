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

/** 상위 5명 표의 제목. 이사·감사 표(제목이 다르다)와 섞이면 안 된다. */
const SECTION_MARKER = "상위 5명의 개인별 보수현황";

/** 당기 = 이 보고서의 대상 기간. 반기보고서면 상반기다. */
const CURRENT_TERM = "CFY";

/**
 * 상위 5명 구간만 잘라낸다. 보고서 하나가 14MB를 넘어서 통째로 파싱하지 않는다.
 * 구간 끝은 다음 대제목이거나 문서 끝으로 본다.
 */
function sliceSection(doc: string): string | null {
  const at = doc.indexOf(SECTION_MARKER);
  if (at === -1) return null;

  // 제목 다음의 LIBRARY 들이 사람별 표다.
  const start = doc.indexOf("<LIBRARY", at);
  if (start === -1) return null;

  // 다음 대제목(ENG 속성이 붙은 TD 제목 칸)이 나오면 거기서 끊는다.
  const nextTitle = doc.indexOf("<보수지급금액", at + SECTION_MARKER.length);
  const end = nextTitle === -1 ? doc.length : nextTitle;

  return doc.slice(start, end);
}

/** "(단위 : 백만원, 주)" 같은 표기에서 배수를 찾는다. 못 찾으면 원 단위로 본다. */
function unitMultiplier(section: string): number {
  const text = /\(단위\s*:\s*([^)]*)\)/.exec(section)?.[1] ?? "";
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
 * 표를 파싱해 당기 행만 뽑는다.
 *
 * 전기·전전기는 연간 금액이라 반기 데이터에 섞이면 안 된다. 각주의
 * "각 사업연도 마지막월 평균종가 … 2026년 6월" 표기가 이 구분을 뒷받침한다.
 */
export function parseIndvdlDoc(doc: string): IndvdlDocRow[] {
  const section = sliceSection(doc);
  if (!section) return [];

  const multiplier = unitMultiplier(section);
  const $ = cheerio.load(section, { xml: true });
  const rows: IndvdlDocRow[] = [];

  $("TABLE-GROUP").each((_, group) => {
    const $group = $(group);

    const name = $group.find('[ACODE="CMPK_NM"]').first().text().trim();
    if (!name) return;

    // 당기 표시가 붙은 행을 찾는다. 그 행에 직위와 보수총액이 같이 들어 있다.
    const $current = $group
      .find(`[AUNITVALUE="${CURRENT_TERM}"]`)
      .first()
      .closest("TR");
    if (!$current.length) return;

    const position = $current.find('[ACODE="CMPK_LEV"]').first().text().trim();
    const raw = $current.find('[ACODE="CMPK_PAY"]').first().text().trim();

    const amount = toNumber(raw);
    if (amount === null) return;

    rows.push({
      name,
      position: position || "-",
      total: Math.round(amount * multiplier),
    });
  });

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
