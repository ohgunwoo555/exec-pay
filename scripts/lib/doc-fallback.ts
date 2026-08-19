/**
 * indvdlByPay API가 아직 비어 있을 때 보고서 원문에서 직접 읽는 폴백.
 *
 * OpenDART는 원문 접수와 API 적재 사이에 시차가 있다(2026 반기의 경우 8월 14일
 * 접수, 그 뒤로도 013). 원문은 접수 즉시 받을 수 있으므로 그동안은 이쪽을 쓴다.
 * API가 채워지면 API 결과가 우선이라 폴백은 자연히 쓰이지 않게 된다.
 *
 * 원문은 회사당 14MB에 달한다. 그래서 API가 못 준 회사에만, 그것도 이전 연도에
 * 공시 이력이 있는 회사에만 돌린다(전체 149개사가 아니라 20여 개사).
 */
import { fetchDocument, fetchFilings, sleep } from "./dart.js";
import { parseIndvdlDoc } from "./indvdl-doc.js";
import type { Company } from "./companies.js";
import type { PayRecord, Period } from "./types.js";

/** 반기보고서는 8월 14일, 사업보고서는 이듬해 3월 말이 제출기한이다. */
function searchWindow(year: string, period: Period): [string, string] {
  return period === "half"
    ? [`${year}0701`, `${year}1231`]
    : [`${Number(year) + 1}0101`, `${Number(year) + 1}0630`];
}

function reportNamePattern(period: Period): RegExp {
  return period === "half" ? /반기보고서/ : /사업보고서/;
}

/** 해당 기간의 정기보고서 접수번호를 찾는다. 정정 공시가 있으면 최신 것을 쓴다. */
async function findReport(
  corpCode: string,
  year: string,
  period: Period
): Promise<string | null> {
  const [bgn, end] = searchWindow(year, period);
  const filings = await fetchFilings(corpCode, bgn, end);
  const pattern = reportNamePattern(period);

  const matched = filings
    .filter((f) => pattern.test(f.report_nm))
    .sort((a, b) => b.rcept_dt.localeCompare(a.rcept_dt));

  return matched[0]?.rcept_no ?? null;
}

export type FallbackResult = {
  records: PayRecord[];
  /** 원문을 뒤진 회사 수 */
  attempted: number;
  /** 실제로 데이터를 얻은 회사 수 */
  matched: number;
};

/**
 * API가 비어 있던 회사들에 대해 원문에서 보수 데이터를 읽는다.
 *
 * 원문이 크므로 동시 실행하지 않고 하나씩 처리한다. 실패는 건너뛴다 —
 * 폴백이 실패해도 기존 데이터는 merge가 지켜준다.
 */
export async function collectFromDocuments(
  companies: Company[],
  year: string,
  period: Period,
  log: (msg: string) => void = console.log
): Promise<FallbackResult> {
  const records: PayRecord[] = [];
  let attempted = 0;
  let matched = 0;

  for (const company of companies) {
    attempted++;
    try {
      const rceptNo = await findReport(company.corp_code, year, period);
      if (!rceptNo) {
        log(`    - ${company.corp_name}: 보고서 없음`);
        continue;
      }

      const doc = await fetchDocument(rceptNo);
      const rows = parseIndvdlDoc(doc);
      if (!rows.length) {
        log(`    - ${company.corp_name}: 표에서 못 찾음 (${rceptNo})`);
        continue;
      }

      matched++;
      log(`    + ${company.corp_name}: ${rows.length}건 (${rceptNo})`);

      for (const row of rows) {
        records.push({
          year,
          period,
          corpCode: company.corp_code,
          corpName: company.corp_name,
          stockCode: company.stock_code,
          rceptNo,
          name: row.name,
          position: row.position,
          total: row.total,
        });
      }
    } catch (err) {
      log(`    ! ${company.corp_name}: ${(err as Error).message}`);
    }
    await sleep(200);
  }

  return { records, attempted, matched };
}
