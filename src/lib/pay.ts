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

export type PayRecord = {
  year: string;
  corpCode: string;
  corpName: string;
  stockCode: string;
  rceptNo: string;
  name: string;
  position: string;
  /** 보수 총액(원) */
  total: number;
  breakdown: Breakdown[];
};

export type PayDataset = {
  years: string[];
  updatedAt: string | null;
  records: PayRecord[];
};

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
