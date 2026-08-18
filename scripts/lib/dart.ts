import AdmZip from "adm-zip";
import iconv from "iconv-lite";
import { XMLParser } from "fast-xml-parser";

const BASE = "https://opendart.fss.or.kr/api";

/** 사업보고서 — 회계연도 12개월 */
export const REPRT_ANNUAL = "11011";

/** 반기보고서 — 해당 사업연도 1~6월 누적 */
export const REPRT_HALF = "11012";

/** 보고서 종류 코드 */
export type ReprtCode = typeof REPRT_ANNUAL | typeof REPRT_HALF;

/** 조회된 데이터가 없을 때 DART가 돌려주는 상태코드 */
const STATUS_NO_DATA = "013";

export function apiKey(): string {
  const key = process.env.DART_API_KEY;
  if (!key) {
    throw new Error(
      "DART_API_KEY가 없습니다. .env.local에 DART_API_KEY=... 를 넣어주세요."
    );
  }
  return key;
}

function url(path: string, params: Record<string, string>): string {
  const q = new URLSearchParams({ crtfc_key: apiKey(), ...params });
  return `${BASE}/${path}?${q}`;
}

async function fetchWithRetry(target: string, tries = 3): Promise<Response> {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(target);
      if (res.ok) return res;
      // 5xx만 재시도 — 4xx는 요청 자체가 틀린 것이므로 즉시 실패시킨다
      if (res.status < 500) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      if (i === tries - 1) throw err;
    }
    await sleep(500 * 2 ** i);
  }
  throw new Error(`요청 실패: ${target}`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type DartEnvelope<T> = { status: string; message: string; list?: T[] };

/**
 * JSON API 호출. 데이터가 없는 경우(status 013)는 정상적인 상황이므로
 * 예외 대신 빈 배열을 돌려준다.
 */
export async function getList<T>(
  path: string,
  params: Record<string, string>
): Promise<T[]> {
  const res = await fetchWithRetry(url(path, params));
  const body = (await res.json()) as DartEnvelope<T>;

  if (body.status === STATUS_NO_DATA) return [];
  if (body.status !== "000") {
    throw new Error(`DART ${path} 오류 [${body.status}] ${body.message}`);
  }
  return body.list ?? [];
}

// ---------------------------------------------------------------------------
// 고유번호 목록 (corpCode.xml)
// ---------------------------------------------------------------------------

export type CorpCodeEntry = {
  corp_code: string;
  corp_name: string;
  stock_code: string;
};

/**
 * DART는 인증키 오류나 점검 중일 때 ZIP 대신 <result><status>…</status></result>
 * 를 돌려준다. 그대로 ZIP 파서에 넘기면 "Invalid or unsupported zip format" 같은
 * 엉뚱한 메시지가 나와 원인을 못 찾는다. 그래서 여기서 먼저 걸러낸다.
 */
function assertNotErrorXml(body: Buffer, what: string): void {
  if (body.subarray(0, 5).toString("latin1") !== "<?xml") return;

  const text = body.toString("utf8");
  const status = /<status>(\d+)<\/status>/.exec(text)?.[1] ?? "?";
  const message = /<message>([^<]*)<\/message>/.exec(text)?.[1] ?? "알 수 없음";

  const hint =
    status === "010" || status === "011" || status === "012"
      ? " — .env.local의 DART_API_KEY를 확인하세요."
      : "";
  throw new Error(`${what} 실패 [${status}] ${message}${hint}`);
}

/**
 * 전체 공시대상 회사의 고유번호 목록. ZIP 안에 CORPCODE.xml 하나가 들어있다.
 * 10만 건이 넘고 자주 바뀌지 않으므로 호출한 쪽에서 캐시하는 것을 권장.
 */
export async function fetchCorpCodes(): Promise<CorpCodeEntry[]> {
  const res = await fetchWithRetry(url("corpCode.xml", {}));
  const body = Buffer.from(await res.arrayBuffer());
  assertNotErrorXml(body, "고유번호 목록 조회");

  const zip = new AdmZip(body);

  const entry = zip.getEntries().find((e) => e.entryName.endsWith(".xml"));
  if (!entry) throw new Error("corpCode.zip 안에서 XML을 찾지 못했습니다.");

  const parser = new XMLParser({
    // stock_code가 "005930" 같은 값이라 숫자로 바뀌면 앞의 0이 사라진다
    parseTagValue: false,
    trimValues: true,
  });
  const parsed = parser.parse(entry.getData().toString("utf8"));
  const list = parsed?.result?.list ?? [];

  return (Array.isArray(list) ? list : [list]).map(
    (row: Record<string, unknown>) => ({
      corp_code: String(row.corp_code ?? "").trim(),
      corp_name: String(row.corp_name ?? "").trim(),
      stock_code: String(row.stock_code ?? "").trim(),
    })
  );
}

// ---------------------------------------------------------------------------
// 개인별 보수지급 금액 (5억 이상 상위 5인)
//
// Ver 2.0(indvdlByPayV2)은 개발가이드에 올라와 있지만 2026-08 현재 어떤
// 연도로 조회해도 빈 응답이라 V1을 쓴다. V2가 채워지면 주식기준보상
// 세부 필드를 API로 받을 수 있으므로 그때 전환할 것.
// ---------------------------------------------------------------------------

export type IndvdlPayRow = {
  rcept_no: string;
  /** Y=유가증권, K=코스닥, N=코넥스, E=기타 */
  corp_cls: string;
  corp_code: string;
  corp_name: string;
  nm: string;
  ofcps: string;
  mendng_totamt: string;
  /** 보수총액 비포함 보수 — 값이 없으면 "-" */
  mendng_totamt_ct_incls_mendng?: string;
  stlm_dt: string;
};

/**
 * reprtCode에 따라 같은 사업연도라도 집계 기간이 다르다.
 * 11011=연간, 11012=상반기 누적. 공시 기준선(5억원)은 각 기간 지급액에 걸리므로
 * 반기로 조회하면 대상 인원이 연간보다 적게 나온다.
 */
export function fetchIndvdlPay(
  corpCode: string,
  year: string,
  reprtCode: ReprtCode = REPRT_ANNUAL
): Promise<IndvdlPayRow[]> {
  return getList<IndvdlPayRow>("indvdlByPay.json", {
    corp_code: corpCode,
    bsns_year: year,
    reprt_code: reprtCode,
  });
}

// ---------------------------------------------------------------------------
// 공시서류 원문 (document.xml)
// ---------------------------------------------------------------------------

/**
 * 접수번호로 사업보고서 원문을 받아 문자열로 돌려준다.
 *
 * ZIP 안에는 본문({접수번호}.xml) 말고도 첨부 문서가 함께 들어있고
 * 임원 보수 표가 어느 쪽에 있는지 보고서마다 다르다. 그래서 XML을 전부
 * 이어 붙여 돌려준다. 인코딩은 파일마다 선언된 값을 따른다.
 */
export async function fetchDocument(rceptNo: string): Promise<string> {
  const res = await fetchWithRetry(url("document.xml", { rcept_no: rceptNo }));
  const body = Buffer.from(await res.arrayBuffer());

  // 원문이 없으면 ZIP 대신 <result><status>014</status>… 가 온다
  assertNotErrorXml(body, `원문 조회(${rceptNo})`);

  const zip = new AdmZip(body);
  const entries = zip.getEntries().filter((e) => e.entryName.endsWith(".xml"));
  if (!entries.length) throw new Error(`문서 ZIP에 XML이 없습니다: ${rceptNo}`);

  // 본문을 앞에 두면 목차가 아닌 실제 표를 먼저 만난다
  entries.sort((a, b) => {
    const main = `${rceptNo}.xml`;
    return Number(b.entryName.endsWith(main)) - Number(a.entryName.endsWith(main));
  });

  return entries.map((entry) => decodeReport(entry.getData())).join("\n");
}

/**
 * 옛 보고서는 encoding="utf-8"이라고 선언해 놓고 실제로는 EUC-KR(CP949)인
 * 경우가 흔하다. 선언대로 디코딩해서 깨지면 CP949로 다시 읽는다.
 */
function decodeReport(raw: Buffer): string {
  const head = raw.subarray(0, 200).toString("latin1");
  const declared = /encoding=["']?([\w-]+)/i.exec(head)?.[1] ?? "utf-8";

  const decoded = iconv.decode(raw, declared);
  if (!decoded.includes("�")) return decoded;

  const fallback = iconv.decode(raw, "cp949");
  return fallback.includes("�") ? decoded : fallback;
}
