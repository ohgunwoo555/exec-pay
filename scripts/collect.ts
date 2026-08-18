/**
 * 증권·금융·투자 상장사의 임원 개인별 보수 데이터를 DART에서 수집한다.
 *
 *   pnpm collect              최근 5개년 수집
 *   pnpm collect 2024 2025    연도 지정
 *
 * 보수 종류별 세부 내역은 이어서 pnpm enrich 로 붙인다.
 */
import { mkdirSync, writeFileSync } from "node:fs";
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

async function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  // --half: 지정한 연도를 반기보고서로 강제한다. 과거 연도 반기를 확인할 때 쓴다.
  const forceHalf = process.argv.includes("--half");
  const targets: Target[] = args.length
    ? args.map((year) => ({
        year,
        ...(forceHalf
          ? { reprtCode: REPRT_HALF, period: "half" as Period }
          : reportFor(year)),
      }))
    : defaultTargets(5);
  const years = targets.map((t) => t.year);
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
        breakdown: [],
      });
    }
  }

  console.log(`  ${confirmed.size}개사 / ${records.length}건 수집`);

  // 보수 종류별 세부 내역은 원문을 파싱해야 하므로 pnpm enrich 가 이어서 붙인다.
  records.sort((a, b) => b.total - a.total);

  writeFileSync(
    resolve(DATA_DIR, "pay.json"),
    JSON.stringify({ years, updatedAt: new Date().toISOString(), records }, null, 2)
  );
  writeFileSync(
    resolve(DATA_DIR, "companies.json"),
    JSON.stringify([...confirmed.values()], null, 2)
  );

  console.log("완료: data/pay.json, data/companies.json");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
