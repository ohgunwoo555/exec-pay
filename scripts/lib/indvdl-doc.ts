/**
 * 보고서 원문에서 "보수지급금액 5억원 이상 중 상위 5명의 개인별 보수현황" 표를
 * 뽑아 indvdlByPay API와 같은 형태로 만든다.
 *
 * OpenDART의 indvdlByPay는 원문 접수 후 적재까지 시차가 있어, 공시가 이미
 * 올라왔는데도 한동안 013(데이터 없음)이 나온다. 그동안 원문에서 직접 읽는다.
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
 * 단위 표기는 그룹 안 첫 표에 <TU>(단위 : 원, 주)</TU> 꼴로 들어 있다.
 * 회사마다 다르다 — 삼성은 백만원, 키움은 원. 그룹 밖을 뒤지면 앞선 다른 표의
 * 단위가 딸려와 배수가 어긋나므로 반드시 그룹 안에서만 찾는다.
 */
function unitOf(group: string): number {
  const text = /\(단위\s*:\s*([^)]*)\)/.exec(group)?.[1] ?? "";
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
 * 전기·전전기는 연간 금액이라 반기 데이터에 섞이면 안 된다.
 */
function parseGroup(group: string, multiplier: number): IndvdlDocRow | null {
  const $ = cheerio.load(group, { xml: true });

  const name = $('[ACODE="CMPK_NM"]').first().text().trim();
  if (!name) return null;

  const $current = $(`[AUNITVALUE="${CURRENT_TERM}"]`).first().closest("TR");
  if (!$current.length) return null;

  const position = $current.find('[ACODE="CMPK_LEV"]').first().text().trim();
  const amount = toNumber(
    $current.find('[ACODE="CMPK_PAY"]').first().text().trim()
  );
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
    const group = match[0];
    const row = parseGroup(group, unitOf(group));
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
