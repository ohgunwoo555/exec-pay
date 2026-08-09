/**
 * 사업보고서 원문에서 "산정기준 및 방법" 표를 뽑아 보수 종류별 내역으로 만든다.
 *
 * 표는 대체로 이런 모양이고, rowspan이 이름/대분류에 걸려 있다.
 *
 *   이름          | 보수의 종류        | 총액  | 산정기준 및 방법
 *   부회장 홍길동 | 근로소득 | 급여    | 1,635 | 급여규정 및 …
 *                 |          | 상여    | 3,785 | 가. 성과급 …
 *                 | 퇴직소득           |   -   | …
 */
import * as cheerio from "cheerio";

export type BasisRow = {
  /** 원문 이름 칸. "부회장양 홍 석"처럼 직위가 붙어 있는 경우가 많다. */
  person: string;
  /** 근로소득 / 퇴직소득 / 기타소득 등 대분류. 없을 수도 있다. */
  category: string;
  /** 급여 / 상여 / 주식매수선택권 행사이익 등 소분류 */
  kind: string;
  /** 원 단위로 환산한 금액. 원문이 "-"이거나 숫자가 아니면 null */
  amount: number | null;
  /** 산정기준 및 방법 설명 */
  note: string;
};

const UNIT_MULTIPLIER: Record<string, number> = {
  원: 1,
  천원: 1_000,
  만원: 10_000,
  백만원: 1_000_000,
  억원: 100_000_000,
};

/**
 * 원문에서 "산정기준 및 방법"이 헤더에 있는 TABLE 조각만 잘라낸다.
 * 보고서 하나가 20MB에 가까워서 통째로 파싱하지 않고 조각만 다룬다.
 */
export function sliceBasisTables(doc: string): string[] {
  const slices: string[] = [];
  const seen = new Set<number>();
  const marker = "산정기준 및 방법";

  // 단위는 여러 표 앞에 한 번만 적히기도 한다. 문서 순서대로 직전 값을 이어받는다.
  let carriedUnit = "";

  let from = 0;
  while (true) {
    const at = doc.indexOf(marker, from);
    if (at === -1) break;
    from = at + marker.length;

    const start = doc.lastIndexOf("<TABLE", at);
    if (start === -1 || seen.has(start)) continue;

    const end = doc.indexOf("</TABLE>", at);
    if (end === -1) continue;

    seen.add(start);

    const slice = doc.slice(start, end + "</TABLE>".length);

    // 진짜 산정기준 표는 이름 칸이 같이 있다. 표 앞에 붙는
    // "2. 산정기준 및 방법" 제목만 걸린 경우(직전 표가 잡힌다)를 걸러낸다.
    if (!/이\s*름|성\s*명/.test(slice)) continue;

    carriedUnit = unitBefore(doc, start) || carriedUnit;
    slices.push(carriedUnit ? `<!--UNIT:${carriedUnit}-->${slice}` : slice);
  }
  return slices;
}

/** 표 바로 앞에 적힌 "(단위 : 백만원)" 을 찾는다. */
function unitBefore(doc: string, start: number): string {
  const before = doc.slice(Math.max(0, start - 3000), start);
  const pattern = /단위\s*[::]\s*([가-힣]+)/g;

  let last = "";
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(before))) last = match[1];

  return UNIT_MULTIPLIER[last] ? last : "";
}

function unitOf(slice: string): number {
  const hint = /<!--UNIT:([가-힣]+)-->/.exec(slice)?.[1];
  return (hint && UNIT_MULTIPLIER[hint]) || 1;
}

/**
 * 셀 안의 줄바꿈은 표준 엔티티가 아닌 `&cr;` 로 들어온다.
 * 그대로 두면 화면에 "&cr;"가 노출되므로 실제 줄바꿈으로 바꾼다.
 */
function cellText(raw: string): string {
  return raw
    .replace(/&cr;/gi, "\n")
    .replace(/[ \t ]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim();
}

/** rowspan/colspan을 펼쳐 2차원 격자로 만든다. */
function toGrid($: cheerio.CheerioAPI): string[][] {
  const grid: string[][] = [];

  $("tr").each((r, tr) => {
    grid[r] ??= [];
    let c = 0;

    $(tr)
      .children("td,th")
      .each((_, cell) => {
        while (grid[r][c] !== undefined) c++;

        const $cell = $(cell);
        // <P> 여러 개로 쪼개진 설명은 줄바꿈으로 잇는다
        const paragraphs = $cell.find("p");
        const text = paragraphs.length
          ? paragraphs
              .map((_, p) => cellText($(p).text()))
              .toArray()
              .filter(Boolean)
              .join("\n")
          : cellText($cell.text());

        const rowspan = Number($cell.attr("rowspan") ?? 1) || 1;
        const colspan = Number($cell.attr("colspan") ?? 1) || 1;

        for (let i = 0; i < rowspan; i++) {
          grid[r + i] ??= [];
          for (let j = 0; j < colspan; j++) grid[r + i][c + j] = text;
        }
        c += colspan;
      });
  });

  return grid.map((row) => Array.from(row, (cell) => cell ?? ""));
}

/** 라벨 칸은 <P>로 쪼개져 "근로\n소득"처럼 오므로 한 줄로 편다. */
function inline(raw: string | undefined): string {
  return (raw ?? "").replace(/\s+/g, " ").trim();
}

function parseAmount(raw: string, multiplier: number): number | null {
  const cleaned = raw.replace(/[,\s]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  return Math.round(Number(cleaned) * multiplier);
}

/** 헤더 텍스트로 열 위치를 찾는다. 회사마다 열 순서가 조금씩 다르다. */
function locateColumns(header: string[]) {
  // 헤더는 "이  름"처럼 자간이 벌어져 있는 경우가 많아 공백을 지우고 본다
  const squeezed = header.map((h) => h.replace(/\s/g, ""));
  const find = (...needles: string[]) =>
    squeezed.findIndex((h) => needles.some((n) => h.includes(n)));

  const name = find("이름", "성명");
  const amount = find("총액", "금액");
  const basis = find("산정기준");

  // "보수의 종류"가 colspan=2면 격자에서 같은 텍스트가 연달아 두 칸 나온다
  const kinds: number[] = [];
  squeezed.forEach((h, i) => {
    if (h.includes("보수의종류") || h.includes("보수종류") || h.includes("구분")) {
      kinds.push(i);
    }
  });

  return { name, amount, basis, kinds };
}

export function parseBasisTable(slice: string): BasisRow[] {
  const $ = cheerio.load(slice);
  const grid = toGrid($);
  if (grid.length < 2) return [];

  const headerIndex = grid.findIndex((row) =>
    row.some((cell) => cell.includes("산정기준"))
  );
  if (headerIndex === -1) return [];

  const cols = locateColumns(grid[headerIndex]);
  if (cols.name === -1 || cols.basis === -1 || !cols.kinds.length) return [];

  const multiplier = unitOf(slice);
  const rows: BasisRow[] = [];

  for (const row of grid.slice(headerIndex + 1)) {
    // 이름 칸을 아예 비워둔 보고서도 있어서(우리금융지주 2021 등) 빈 값도 남긴다.
    // 누구 것인지는 붙이는 쪽에서 판단한다.
    const person = inline(row[cols.name]);
    if (person.includes("산정기준")) continue;

    const kindCells = cols.kinds.map((i) => row[i] ?? "").filter(Boolean);
    // 대분류와 소분류가 같은 텍스트면(colspan 확장) 하나로 본다
    const unique = [...new Set(kindCells)];
    // 대분류는 "근로소득"처럼 한 낱말이라 줄바꿈을 그냥 없앤다
    const category = unique.length > 1 ? inline(unique[0]).replace(/\s/g, "") : "";
    const kind = inline(unique.at(-1));
    if (!kind) continue;

    const amountRaw = cols.amount === -1 ? "" : (row[cols.amount] ?? "");
    const note = (row[cols.basis] ?? "").trim();
    const amount = parseAmount(amountRaw, multiplier);

    // 금액도 설명도 없는 칸("-")은 표를 채우기 위한 빈 항목이므로 버린다
    if (amount === null && (note === "" || note === "-")) continue;

    rows.push({ person, category, kind, amount, note });
  }

  return rows;
}

/**
 * 같은 표가 본문과 첨부(정정본)에 함께 들어있어 행이 두 벌씩 나오는 일이 잦다.
 * 사람·종류·금액이 같으면 같은 항목으로 본다.
 */
export function dedupeRows(rows: BasisRow[]): BasisRow[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = `${row.person}|${row.category}|${row.kind}|${row.amount}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function parseBasis(doc: string): BasisRow[] {
  return dedupeRows(sliceBasisTables(doc).flatMap(parseBasisTable));
}

/**
 * 이름 칸("부회장양 홍 석")이 특정 임원("양홍석")의 것인지 판단한다.
 * 공백을 모두 없앤 뒤 포함 관계로 본다.
 */
export function matchesPerson(personCell: string, name: string): boolean {
  const squeeze = (s: string) => s.replace(/\s/g, "");
  return squeeze(personCell).includes(squeeze(name));
}
