/**
 * 타입과 표시용 헬퍼. 클라이언트 컴포넌트에서도 쓰이므로
 * node 전용 API를 여기에 두지 않는다. (로딩은 pay.server.ts)
 */

export type Breakdown = {
  /** 예: 급여, 상여, 주식매수선택권 행사이익, 기타 근로소득, 퇴직소득 */
  label: string;
  /** 원 단위. 원문에 금액이 없고 설명만 있으면 null */
  amount: number | null;
  note?: string;
};

/**
 * 집계 기간. annual=사업보고서(12개월), half=반기보고서(1~6월 누적).
 * 두 기간의 total은 서로 비교할 수 없다.
 */
export type Period = "annual" | "half";

export type PayRecord = {
  year: string;
  /** 없으면 annual (period 도입 이전에 수집한 데이터) */
  period: Period;
  corpCode: string;
  corpName: string;
  stockCode: string;
  rceptNo: string;
  name: string;
  position: string;
  /** 보수 총액(원). period가 half면 상반기 누적 금액이다. */
  total: number;
  /**
   * 보수 종류별 내역. enrich 전이면 undefined, 원문에서 못 찾았으면 빈 배열이다.
   * 이 구분이 있어야 일별 수집에서 실패 건을 매번 다시 받지 않는다.
   */
  breakdown?: Breakdown[];
};

export type PayDataset = {
  years: string[];
  updatedAt: string | null;
  records: PayRecord[];
};

/** 연도 칩·행에 쓰는 짧은 표기. "2025" / "2026 상반기" */
export function yearLabel(year: string, period: Period): string {
  return period === "half" ? `${year} 상반기` : year;
}

/** 안내 문구용 긴 표기. "2025 사업연도" / "2026 사업연도 상반기(누적)" */
export function periodLabel(year: string, period: Period): string {
  return period === "half"
    ? `${year} 사업연도 상반기(누적)`
    : `${year} 사업연도`;
}

/** 1억 이상은 "12.3억", 그 아래는 "8,400만" 처럼 읽기 쉽게 */
export function formatKRW(won: number): string {
  if (won >= 100_000_000) {
    const eok = won / 100_000_000;
    return `${eok >= 100 ? Math.round(eok) : eok.toFixed(1)}억`;
  }
  if (won >= 10_000) return `${Math.round(won / 10_000).toLocaleString("ko-KR")}만`;
  return won.toLocaleString("ko-KR");
}

export function formatFullKRW(won: number): string {
  return `${won.toLocaleString("ko-KR")}원`;
}
