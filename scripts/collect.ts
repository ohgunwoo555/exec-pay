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
import { fetchIndvdlPay, sleep, type IndvdlPayRow } from "./lib/dart.js";
import { resolveCompanies, type Company } from "./lib/companies.js";
import type { PayRecord } from "./lib/types.js";

process.loadEnvFile(".env.local");

const ROOT = process.cwd();
const DATA_DIR = resolve(ROOT, "data");

/** DART 일일 한도(2만 건)와 무관하게, 서버에 부담을 주지 않도록 동시 요청을 제한한다. */
const CONCURRENCY = 4;

/** 수집 대상 시장. Y=유가증권, K=코스닥 (N=코넥스, E=기타는 제외) */
const MARKETS = new Set(["Y", "K"]);

function recentYears(count: number): string[] {
  // 사업보고서는 회계연도 종료 후 3개월 안에 나오므로 올해 것은 아직 없을 수 있다.
  const latest = new Date().getFullYear() - 1;
  return Array.from({ length: count }, (_, i) => String(latest - i)).reverse();
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
  const years = args.length ? args : recentYears(5);
  mkdirSync(DATA_DIR, { recursive: true });

  console.log("회사 목록을 가져오는 중...");
  const candidates = await resolveCompanies();
  console.log(`  키워드 후보 ${candidates.length}개사`);

  const jobs = candidates.flatMap((company) =>
    years.map((year) => ({ company, year }))
  );

  console.log(`보수 데이터 수집 중 (${jobs.length}건 조회)...`);
  const fetched = await mapWithLimit(jobs, CONCURRENCY, async ({ company, year }) => {
    try {
      const rows = await fetchIndvdlPay(company.corp_code, year);
      return { company, year, rows };
    } catch (err) {
      console.warn(`  ! ${company.corp_name} ${year}: ${(err as Error).message}`);
      return { company, year, rows: [] as IndvdlPayRow[] };
    }
  });

  const records: PayRecord[] = [];
  const confirmed = new Map<string, Company>();

  for (const { company, year, rows } of fetched) {
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
