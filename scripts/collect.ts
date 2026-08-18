/**
 * 증권·금융·투자 상장사의 임원 개인별 보수 데이터를 DART에서 수집한다.
 *
 *   pnpm collect              최근 5개년 수집
 *   pnpm collect 2024 2025    연도 지정
 *
 * 보수 종류별 세부 내역은 이어서 pnpm enrich 로 붙인다.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  fetchIndvdlPay,
  sleep,
  REPRT_ANNUAL,
  REPRT_HALF,
  type IndvdlPayRow,
  type ReprtCode,
} from "./lib/dart.js";
import { resolveCompanies, type Company } from "./lib/companies.js";
import type { PayRecord, Period } from "./lib/types.js";

process.loadEnvFile(".env.local");

const ROOT = process.cwd();
const DATA_DIR = resolve(ROOT, "data");

/** DART 일일 한도(2만 건)와 무관하게, 서버에 부담을 주지 않도록 동시 요청을 제한한다. */
const CONCURRENCY = 4;

/** 수집 대상 시장. Y=유가증권, K=코스닥 (N=코넥스, E=기타는 제외) */
const MARKETS = new Set(["Y", "K"]);

type Target = { year: string; reprtCode: ReprtCode; period: Period };

/**
 * 반기보고서 법정 제출기한은 반기 종료 후 45일, 즉 8월 14일이다.
 * 그 전에는 올해 반기 데이터가 아직 없으므로 대상에서 뺀다.
 */
function halfReportAvailable(now = new Date()): boolean {
  const august = now.getMonth() === 7;
  return now.getMonth() > 7 || (august && now.getDate() >= 15);
}

/**
 * 사업보고서 법정 제출기한은 회계연도 종료 후 90일, 즉 이듬해 3월 말이다.
 * 4월부터 있다고 본다.
 */
function annualReportAvailable(year: string, now = new Date()): boolean {
  const due = Number(year) + 1;
  return now.getFullYear() > due || (now.getFullYear() === due && now.getMonth() >= 3);
}

/**
 * 사업보고서가 나왔으면 연간, 아직이면 반기로 받는다.
 *
 * 단순히 "올해면 반기"로 하면 1~3월에 문제가 생긴다. 해가 바뀌자마자 작년이
 * 연간 쪽으로 넘어가는데 사업보고서는 3월 말에나 나오므로, 그 사이에 수집하면
 * 이미 받아둔 작년 반기 데이터가 빈 값으로 덮어써진다.
 */
function reportFor(year: string, now = new Date()): Omit<Target, "year"> {
  return annualReportAvailable(year, now)
    ? { reprtCode: REPRT_ANNUAL, period: "annual" }
    : { reprtCode: REPRT_HALF, period: "half" };
}

/** 사업보고서 기준 최근 count개년 + (가능하면) 올해 반기 */
function defaultTargets(count: number, now = new Date()): Target[] {
  const latest = now.getFullYear() - 1;
  const targets: Target[] = Array.from({ length: count }, (_, i) =>
    String(latest - i)
  )
    .reverse()
    .map((year) => ({ year, ...reportFor(year, now) }));

  if (halfReportAvailable(now)) {
    const year = String(now.getFullYear());
    targets.push({ year, reprtCode: REPRT_HALF, period: "half" });
  }
  return targets;
}

async function mapWithLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index], index);
      await sleep(120);
    }
  });

  await Promise.all(workers);
  return results;
}

/** 개행·중복 공백 정리. 한글 이름은 "양 홍 석"처럼 자간 공백이 들어오므로 붙인다. */
function cleanText(raw: string | undefined): string {
  return (raw ?? "").replace(/\s+/g, " ").trim();
}

function cleanName(raw: string | undefined): string {
  const text = cleanText(raw);
  // 모든 조각이 한 글자면 자간 공백으로 보고 붙인다 ("이 어 룡" → "이어룡")
  const parts = text.split(" ");
  if (parts.length > 1 && parts.every((p) => [...p].length === 1)) {
    return parts.join("");
  }
  return text;
}

/** "1,234,000" → 1234000. 값이 없으면 "-"로 오므로 그때는 NaN. */
function toNumber(raw: string | undefined): number {
  const digits = (raw ?? "").replace(/[^0-9]/g, "");
  return digits ? Number(digits) : NaN;
}

/**
 * 이번에 응답을 받은 (연도·기간·회사) 조각만 새 것으로 갈아끼우고 나머지는 둔다.
 *
 * 공시가 회사별로 며칠에 걸쳐 올라오므로, 아직 안 올라온 회사를 "0건"으로 보고
 * 지워버리면 안 된다. 그래서 응답이 없는 조각은 손대지 않는다.
 */
function mergeRecords(existing: PayRecord[], incoming: PayRecord[]): PayRecord[] {
  const sliceKey = (r: PayRecord) => `${r.year}|${r.period}|${r.corpCode}`;
  const rowKey = (r: PayRecord) => `${r.rceptNo}|${r.name}|${r.position}`;

  const refreshed = new Set(incoming.map(sliceKey));

  // 같은 보고서의 같은 사람이면 이미 파싱해둔 내역을 물려받는다 (원문 재다운로드 방지)
  const previous = new Map(existing.map((r) => [rowKey(r), r]));
  const carried = incoming.map((r) => {
    const old = previous.get(rowKey(r));
    return old?.breakdown !== undefined && r.breakdown === undefined
      ? { ...r, breakdown: old.breakdown }
      : r;
  });

  return [...existing.filter((r) => !refreshed.has(sliceKey(r))), ...carried];
}

function mergeCompanies(existing: Company[], incoming: Company[]): Company[] {
  const byCode = new Map(existing.map((c) => [c.corp_code, c]));
  for (const c of incoming) byCode.set(c.corp_code, c);
  return [...byCode.values()].sort((a, b) =>
    a.corp_name.localeCompare(b.corp_name, "ko")
  );
}

/**
 * 결과가 직전보다 크게 줄면 쓰지 않고 실패시킨다.
 *
 * merge는 조각 단위 유실을 막지만 전체가 망가지는 경우는 못 막는다. DART 응답
 * 형식이 바뀌거나 회사 필터가 어긋나면 이상한 pay.json이 그대로 커밋되고,
 * 자동 배포까지 이어진다. 무인으로 도는 경로라 조용히 틀리는 것보다 멈추는 게 낫다.
 * 강제로 다시 만들어야 할 때는 --force 를 준다.
 */
const COLLAPSE_RATIO = 0.9;

function assertNoCollapse(previous: PayRecord[], next: PayRecord[]): void {
  if (process.argv.includes("--force")) return;
  if (!previous.length) return; // 최초 수집

  const floor = Math.floor(previous.length * COLLAPSE_RATIO);
  if (next.length >= floor) return;

  throw new Error(
    `레코드가 ${previous.length}건 → ${next.length}건으로 급감했습니다 ` +
      `(기준 ${floor}건). 데이터를 쓰지 않고 중단합니다.\n` +
      `  DART 응답이나 회사 필터를 확인하고, 의도한 변경이면 --force 를 붙이세요.`
  );
}

/**
 * 병합 결과에 같은 사람이 두 번 들어가지 않았는지 본다.
 *
 * 병합 키가 어긋나면 기존 레코드가 교체되지 않고 그대로 남아 데이터가 두 배가
 * 된다. 조용히 통과하면 화면에 중복 행이 뜨므로 여기서 멈춘다.
 */
function assertNoDuplicates(records: PayRecord[]): void {
  const seen = new Set<string>();
  const dupes: string[] = [];

  for (const r of records) {
    const key = `${r.year}|${r.period}|${r.corpCode}|${r.name}|${r.rceptNo}`;
    if (seen.has(key)) dupes.push(`${r.year} ${r.corpName} ${r.name}`);
    seen.add(key);
  }

  if (!dupes.length) return;
  throw new Error(
    `병합 결과에 중복 ${dupes.length}건이 있습니다. 데이터를 쓰지 않고 중단합니다.\n` +
      dupes.slice(0, 5).map((d) => `  - ${d}`).join("\n")
  );
}

function loadExisting(): { records: PayRecord[] } {
  try {
    const raw = readFileSync(resolve(DATA_DIR, "pay.json"), "utf8");
    const records: PayRecord[] = JSON.parse(raw).records ?? [];
    // period 도입 전에 만든 pay.json에는 이 필드가 없다. 채워주지 않으면 병합
    // 키가 어긋나 기존 레코드가 교체되지 않고 통째로 중복된다.
    return {
      records: records.map((r) => ({ ...r, period: r.period ?? "annual" })),
    };
  } catch {
    return { records: [] };
  }
}

function loadExistingCompanies(): Company[] {
  try {
    return JSON.parse(readFileSync(resolve(DATA_DIR, "companies.json"), "utf8"));
  } catch {
    return [];
  }
}

async function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  // --half: 지정한 연도를 반기보고서로 강제한다. 과거 연도 반기를 확인할 때 쓴다.
  const forceHalf = process.argv.includes("--half");
  // --merge: 덮어쓰지 않고 이번에 받은 조각만 갈아끼운다 (일별 수집용)
  const mergeMode = process.argv.includes("--merge");
  const targets: Target[] = args.length
    ? args.map((year) => ({
        year,
        ...(forceHalf
          ? { reprtCode: REPRT_HALF, period: "half" as Period }
          : reportFor(year)),
      }))
    : defaultTargets(5);
  mkdirSync(DATA_DIR, { recursive: true });

  console.log(
    "대상 기간: " +
      targets
        .map((t) => `${t.year}${t.period === "half" ? "(반기)" : ""}`)
        .join(", ")
  );

  console.log("회사 목록을 가져오는 중...");
  const candidates = await resolveCompanies();
  console.log(`  키워드 후보 ${candidates.length}개사`);

  const jobs = candidates.flatMap((company) =>
    targets.map((target) => ({ company, target }))
  );

  console.log(`보수 데이터 수집 중 (${jobs.length}건 조회)...`);
  const fetched = await mapWithLimit(jobs, CONCURRENCY, async ({ company, target }) => {
    try {
      const rows = await fetchIndvdlPay(
        company.corp_code,
        target.year,
        target.reprtCode
      );
      return { company, target, rows };
    } catch (err) {
      console.warn(
        `  ! ${company.corp_name} ${target.year}: ${(err as Error).message}`
      );
      return { company, target, rows: [] as IndvdlPayRow[] };
    }
  });

  const records: PayRecord[] = [];
  const confirmed = new Map<string, Company>();

  for (const { company, target, rows } of fetched) {
    const { year, period } = target;
    // 유가증권(Y)·코스닥(K) 상장사만 — 이 정보는 보수 API 응답에만 들어있다.
    const listedRows = rows.filter((row) => MARKETS.has(row.corp_cls));

    for (const row of listedRows) {
      const total = toNumber(row.mendng_totamt);
      const name = cleanName(row.nm);

      // 해당자가 없는 회사는 이름과 금액이 "-"인 빈 행 하나를 올린다.
      // 스팩처럼 실제 공시 대상자가 없는 회사는 목록에도 넣지 않는다.
      if (!Number.isFinite(total) || !name || name === "-") continue;

      confirmed.set(company.corp_code, company);
      records.push({
        year,
        period,
        corpCode: company.corp_code,
        corpName: row.corp_name || company.corp_name,
        stockCode: company.stock_code,
        rceptNo: row.rcept_no,
        name,
        position: cleanName(row.ofcps),
        total,
      });
    }
  }

  console.log(`  ${confirmed.size}개사 / ${records.length}건 수집`);

  // 보수 종류별 세부 내역은 원문을 파싱해야 하므로 pnpm enrich 가 이어서 붙인다.
  const previous = loadExisting().records;
  const merged = mergeMode ? mergeRecords(previous, records) : records;

  if (mergeMode) {
    console.log(`  병합 후 ${merged.length}건 (기존 유지분 포함)`);
  }

  assertNoDuplicates(merged);
  assertNoCollapse(previous, merged);

  // 저장 순서는 화면 정렬과 무관하다(PayExplorer가 다시 정렬한다). 금액순으로
  // 두면 레코드 하나만 늘어도 그 아래가 전부 밀려 매일 수백 줄짜리 diff가 난다.
  // 일별 커밋이 쌓이는 파일이므로 변경분만 남도록 안정적인 키로 정렬한다.
  merged.sort(
    (a, b) =>
      a.year.localeCompare(b.year) ||
      a.period.localeCompare(b.period) ||
      a.corpCode.localeCompare(b.corpCode) ||
      a.name.localeCompare(b.name, "ko") ||
      a.rceptNo.localeCompare(b.rceptNo)
  );

  // 실제로 데이터가 있는 연도만 노출한다
  const years = [...new Set(merged.map((r) => r.year))].sort();

  const companies = mergeMode
    ? mergeCompanies(loadExistingCompanies(), [...confirmed.values()])
    : [...confirmed.values()];

  writeFileSync(
    resolve(DATA_DIR, "pay.json"),
    JSON.stringify({ years, updatedAt: new Date().toISOString(), records: merged }, null, 2)
  );
  writeFileSync(
    resolve(DATA_DIR, "companies.json"),
    JSON.stringify(companies, null, 2)
  );

  console.log("완료: data/pay.json, data/companies.json");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
