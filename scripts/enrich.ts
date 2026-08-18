/**
 * data/pay.json 의 각 임원에게 "산정기준 및 방법" 표에서 뽑은
 * 보수 종류별 내역을 붙인다.
 *
 *   pnpm enrich              전체
 *   pnpm enrich --limit 5      보고서 5건만 (파서 손볼 때)
 *   pnpm enrich --report       붙이지 않고 성공률만 확인
 *   pnpm enrich --only-missing 아직 안 붙인 건만 (일별 수집용)
 *
 * 보고서 원문은 건당 20MB에 가까워서 통째로 캐시하지 않고,
 * 필요한 표 조각만 .cache/slices 에 남긴다.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fetchDocument, sleep } from "./lib/dart.js";
import {
  dedupeRows,
  matchesPerson,
  parseBasisTable,
  sliceBasisTables,
  type BasisRow,
} from "./lib/basis.js";
import type { PayRecord } from "./lib/types.js";

process.loadEnvFile(".env.local");

const SLICE_DIR = resolve(process.cwd(), ".cache/slices");
const DATA_PATH = resolve(process.cwd(), "data/pay.json");

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function flagValue(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
}

/** 표 조각을 캐시와 함께 가져온다. 원문 자체는 남기지 않는다. */
async function slicesFor(rceptNo: string): Promise<string[]> {
  const path = resolve(SLICE_DIR, `${rceptNo}.json`);
  if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8"));

  const doc = await fetchDocument(rceptNo);
  const slices = sliceBasisTables(doc);
  writeFileSync(path, JSON.stringify(slices), "utf8");
  return slices;
}

/**
 * 보고서 한 건에 산정기준 표가 여러 개 있고(본문·첨부·다른 섹션) 같은 사람이
 * 여러 표에 나온다. 항목 합계가 공시된 보수 총액에 가장 가까운 표를 고른다.
 */
function pickClosest(candidates: BasisRow[][], total: number): BasisRow[] {
  if (candidates.length <= 1) return candidates[0] ?? [];

  const distance = (rows: BasisRow[]) =>
    Math.abs(rows.reduce((sum, row) => sum + (row.amount ?? 0), 0) - total);

  return candidates.reduce((best, rows) =>
    distance(rows) < distance(best) ? rows : best
  );
}

async function main() {
  mkdirSync(SLICE_DIR, { recursive: true });

  const dataset = JSON.parse(readFileSync(DATA_PATH, "utf8")) as {
    years: string[];
    updatedAt: string;
    records: PayRecord[];
  };

  // --only-missing: 아직 시도하지 않은 건만 처리한다. 시도했지만 표에서 못 찾은
  // 건은 breakdown이 빈 배열로 남아 있어 매일 원문을 다시 받는 일이 없다.
  const onlyMissing = flag("only-missing");

  const byReport = new Map<string, PayRecord[]>();
  for (const record of dataset.records) {
    if (!record.rceptNo) continue;
    if (onlyMissing && record.breakdown !== undefined) continue;
    const list = byReport.get(record.rceptNo) ?? [];
    list.push(record);
    byReport.set(record.rceptNo, list);
  }

  let reports = [...byReport.entries()];
  const limit = Number(flagValue("limit") ?? 0);
  if (limit > 0) reports = reports.slice(0, limit);

  console.log(`보고서 ${reports.length}건 처리${onlyMissing ? " (미처리분만)" : ""}`);
  if (!reports.length) {
    console.log("새로 붙일 내역이 없습니다.");
    return;
  }

  let matched = 0;
  let unmatched = 0;
  const failures: string[] = [];

  for (const [rceptNo, records] of reports) {
    let tables: BasisRow[][] = [];
    try {
      tables = (await slicesFor(rceptNo))
        .map((slice) => dedupeRows(parseBasisTable(slice)))
        .filter((rows) => rows.length);
    } catch (err) {
      failures.push(`${records[0].corpName} ${records[0].year}: ${(err as Error).message}`);
      continue;
    }

    for (const record of records) {
      let candidates = tables
        .map((rows) => rows.filter((row) => row.person && matchesPerson(row.person, record.name)))
        .filter((rows) => rows.length);

      // 이름 칸을 비워둔 표는 대상자가 한 명일 때만 그 사람 것으로 본다
      if (!candidates.length && records.length === 1) {
        candidates = tables
          .map((rows) => rows.filter((row) => !row.person))
          .filter((rows) => rows.length);
      }

      const mine = pickClosest(candidates, record.total);

      if (!mine.length) {
        // 시도했음을 남긴다 — 다음 실행에서 --only-missing이 건너뛸 수 있도록
        record.breakdown = [];
        unmatched++;
        failures.push(`${record.corpName} ${record.year} ${record.name}: 표에서 못 찾음`);
        continue;
      }
      matched++;
      record.breakdown = mine.map((row) => ({
        label: row.category && row.category !== row.kind
          ? `${row.category} · ${row.kind}`
          : row.kind,
        amount: row.amount,
        note: row.note || undefined,
      }));
    }

    const done = matched + unmatched;
    if (done % 50 < records.length) {
      console.log(`  ...${done}건 처리 (성공 ${matched})`);
    }
    await sleep(200);
  }

  const total = matched + unmatched;
  console.log(
    `\n성공 ${matched}/${total} (${total ? Math.round((matched / total) * 100) : 0}%)`
  );

  if (failures.length) {
    console.log("\n실패 사례 (최대 30건):");
    failures.slice(0, 30).forEach((line) => console.log("  - " + line));
  }

  if (!flag("report")) {
    writeFileSync(DATA_PATH, JSON.stringify(dataset, null, 2));
    console.log("\ndata/pay.json 갱신 완료");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
