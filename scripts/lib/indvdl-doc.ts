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

const GROUP_PATTERN =
  /<TABLE-GROUP[^>]*ACLASS="SUB_CMPK_HIGH"[^>]*>[\s\S]*?<\/TABLE-GROUP>/g;

/** 단위는 회사마다 다르다 — 삼성은 백만원, 키움은 원. */
function unitOf(text: string): number {
  const found = /\(단위\s*:\s*([^)]*)\)/.exec(text)?.[1] ?? "";
  for (const unit of ["백만원", "억원", "만원", "천원", "원"]) {
    if (found.includes(unit)) return UNIT_MULTIPLIER[unit];
  }
  return 1;
}

function toNumber(raw: string): number | null {
  const cleaned = raw.replace(/[,\s]/g, "").replace(/[()]/g, "");
  if (!cleaned || cleaned === "-") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** DART 표준 서식. 칸을 ACODE 속성으로 집는다. */
function parseGroup(group: string, multiplier: number): IndvdlDocRow[] {
  const $ = cheerio.load(group, { xml: true });
  const rows: IndvdlDocRow[] = [];
  let lastName = "";

  $("TR").each((_, tr) => {
    const $tr = $(tr);

    const name = $tr.find('[ACODE="CMPK_NM"]').first().text().trim();
    if (name) lastName = name;

    if (!$tr.find(`[AUNITVALUE="${CURRENT_TERM}"]`).length) return;
    if (!lastName) return;

    const amount = toNumber($tr.find('[ACODE="CMPK_PAY"]').first().text().trim());
    if (amount === null) return;

    const position = $tr.find('[ACODE="CMPK_LEV"]').first().text().trim();
    rows.push({
      name: lastName,
      position: position || "-",
      total: Math.round(amount * multiplier),
    });
  });

  return rows;
}

/**
 * ACODE가 없는 일반 표에서 읽는다.
 *
 * 회사가 표준 서식 대신 손으로 표를 붙이는 경우가 있다. 한국금융지주는 첫 사람만
 * SUB_CMPK_HIGH 그룹이고 나머지 4명은 ACLASS="NORMAL" 표다. 속성이 없으니 컬럼
 * 위치로 읽는데, 순서는 이름·사업연도·직위·보수총액으로 고정돼 있다.
 *
 *   오태균 | 당기 | 사장 | 3,309 | …
 *          | 전기 | 사장 | 1,869 | …
 */
function parsePlainTable(table: string, multiplier: number): IndvdlDocRow[] {
  const $ = cheerio.load(table, { xml: true });
  const rows: IndvdlDocRow[] = [];
  let lastName = "";

  $("TR").each((_, tr) => {
    const cells = $(tr)
      .find("TD, TE")
      .map((_, td) => $(td).text().trim())
      .get();

    const at = cells.indexOf("당기");
    if (at === -1) return;

    if (at > 0 && cells[at - 1]) lastName = cells[at - 1];
    if (!lastName) return;

    const amount = toNumber(cells[at + 2] ?? "");
    if (amount === null) return;

    rows.push({
      name: lastName,
      position: cells[at + 1] || "-",
      total: Math.round(amount * multiplier),
    });
  });

  return rows;
}

/** 상위 5명 표 구간. 일반 표까지 훑어야 하므로 제목부터 각주까지로 잡는다. */
function sectionAfterTitle(doc: string): { text: string; unit: number } | null {
  const at = doc.indexOf("상위 5명의 개인별 보수현황>");
  if (at === -1) return null;

  const foot = doc.indexOf("* 잔여금액", at);
  const end = foot === -1 ? Math.min(at + 200_000, doc.length) : foot;
  const text = doc.slice(at, end);
  return { text, unit: unitOf(text) };
}

export function parseIndvdlDoc(doc: string): IndvdlDocRow[] {
  const rows: IndvdlDocRow[] = [];

  for (const match of doc.matchAll(GROUP_PATTERN)) {
    const group = match[0];
    rows.push(...parseGroup(group, unitOf(group)));
  }

  const section = sectionAfterTitle(doc);
  if (section) {
    for (const m of section.text.matchAll(/<TABLE[^-][\s\S]*?<\/TABLE>/g)) {
      rows.push(...parsePlainTable(m[0], section.unit));
    }
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
