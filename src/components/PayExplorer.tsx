"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  formatFullKRW,
  formatKRW,
  type PayDataset,
  type PayRecord,
} from "@/lib/pay";

const PAGE_SIZE = 30;

type SortKey = "total-desc" | "total-asc" | "name-asc";

const SORTS: { key: SortKey; label: string }[] = [
  { key: "total-desc", label: "보수 많은 순" },
  { key: "total-asc", label: "보수 적은 순" },
  { key: "name-asc", label: "회사 이름순" },
];

export default function PayExplorer({ data }: { data: PayDataset }) {
  const [year, setYear] = useState<string>(data.years.at(-1) ?? "");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("total-desc");
  const [visible, setVisible] = useState(PAGE_SIZE);
  const [openRow, setOpenRow] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = data.records.filter((r) => {
      if (year && r.year !== year) return false;
      if (!q) return true;
      return (
        r.corpName.toLowerCase().includes(q) ||
        r.name.toLowerCase().includes(q) ||
        r.position.toLowerCase().includes(q)
      );
    });

    const sorted = [...rows];
    if (sort === "total-desc") sorted.sort((a, b) => b.total - a.total);
    if (sort === "total-asc") sorted.sort((a, b) => a.total - b.total);
    if (sort === "name-asc")
      sorted.sort(
        (a, b) =>
          a.corpName.localeCompare(b.corpName, "ko") || b.total - a.total
      );
    return sorted;
  }, [data.records, year, query, sort]);

  // 필터가 바뀌면 목록을 처음부터 다시 보여준다
  function reset<T>(apply: (value: T) => void) {
    return (value: T) => {
      apply(value);
      setVisible(PAGE_SIZE);
      setOpenRow(null);
    };
  }

  const changeYear = reset(setYear);
  const changeQuery = reset(setQuery);
  const changeSort = reset(setSort);

  const stats = useMemo(() => {
    if (!filtered.length) return null;
    const totals = filtered.map((r) => r.total).sort((a, b) => a - b);
    const mid = Math.floor(totals.length / 2);
    return {
      people: filtered.length,
      companies: new Set(filtered.map((r) => r.corpCode)).size,
      top: filtered.reduce((a, b) => (a.total > b.total ? a : b)),
      median:
        totals.length % 2 ? totals[mid] : (totals[mid - 1] + totals[mid]) / 2,
    };
  }, [filtered]);

  const max = filtered.length ? Math.max(...filtered.map((r) => r.total)) : 0;
  const shown = filtered.slice(0, visible);

  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = sentinel.current;
    if (!node) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          setVisible((v) => Math.min(v + PAGE_SIZE, filtered.length));
        }
      },
      { rootMargin: "600px" }
    );
    io.observe(node);
    return () => io.disconnect();
  }, [filtered.length]);

  if (!data.records.length) return <EmptyState />;

  return (
    <div className="mx-auto w-full max-w-5xl px-4 pb-24 sm:px-6">
      <Header updatedAt={data.updatedAt} />

      {/* 벤토 그리드 요약 */}
      {stats && (
        <section className="mt-8 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Tile className="col-span-2 lg:col-span-2" label="최고 보수">
            <div className="flex items-baseline gap-2">
              <span className="tnum text-3xl font-semibold tracking-tight sm:text-4xl">
                {formatKRW(stats.top.total)}
              </span>
              <span className="text-sm text-[var(--fg-muted)]">
                {stats.top.name} · {stats.top.corpName}
              </span>
            </div>
          </Tile>
          <Tile label="중앙값">
            <span className="tnum text-2xl font-semibold sm:text-3xl">
              {formatKRW(stats.median)}
            </span>
          </Tile>
          <Tile label="대상">
            <span className="tnum text-2xl font-semibold sm:text-3xl">
              {stats.companies}
              <span className="text-base font-normal text-[var(--fg-muted)]">
                개사
              </span>{" "}
              {stats.people}
              <span className="text-base font-normal text-[var(--fg-muted)]">
                명
              </span>
            </span>
          </Tile>
        </section>
      )}

      {/* 스크롤해도 따라오는 유리 툴바 */}
      <div className="glass squircle sticky top-3 z-20 mt-6 border border-[var(--border)] p-3 shadow-sm">
        <div className="flex flex-col gap-3">
          <input
            type="search"
            value={query}
            onChange={(e) => changeQuery(e.target.value)}
            placeholder="회사명, 이름, 직위로 검색"
            className="squircle w-full border border-[var(--border)] bg-[var(--bg)] px-4 py-2.5 text-[15px] outline-none placeholder:text-[var(--fg-muted)] focus:border-[var(--accent)]"
          />
          <div className="flex flex-wrap items-center gap-2">
            {data.years.map((y) => (
              <Chip key={y} active={year === y} onClick={() => changeYear(y)}>
                {y}
              </Chip>
            ))}
            <Chip active={year === ""} onClick={() => changeYear("")}>
              전체
            </Chip>
            <span className="mx-1 h-4 w-px bg-[var(--border)]" />
            {SORTS.map((s) => (
              <Chip
                key={s.key}
                active={sort === s.key}
                onClick={() => changeSort(s.key)}
              >
                {s.label}
              </Chip>
            ))}
          </div>
        </div>
      </div>

      <p className="mt-4 text-sm text-[var(--fg-muted)]">
        {filtered.length.toLocaleString("ko-KR")}건
        {year && ` · ${year} 사업연도`}
      </p>

      <ol className="mt-3 flex flex-col gap-2">
        {shown.map((record, index) => (
          <Row
            key={`${record.rceptNo}-${record.name}-${index}`}
            record={record}
            rank={sort === "total-desc" ? index + 1 : null}
            ratio={max ? record.total / max : 0}
            open={openRow === rowId(record, index)}
            onToggle={() =>
              setOpenRow((cur) =>
                cur === rowId(record, index) ? null : rowId(record, index)
              )
            }
          />
        ))}
      </ol>

      {visible < filtered.length && (
        <div ref={sentinel} className="py-10 text-center text-sm text-[var(--fg-muted)]">
          불러오는 중…
        </div>
      )}

      {!filtered.length && (
        <p className="py-16 text-center text-[var(--fg-muted)]">
          조건에 맞는 결과가 없습니다.
        </p>
      )}
    </div>
  );
}

function rowId(record: PayRecord, index: number) {
  return `${record.rceptNo}-${record.name}-${index}`;
}

function Header({ updatedAt }: { updatedAt: string | null }) {
  return (
    <header className="pt-12 sm:pt-16">
      <p className="text-sm font-medium text-[var(--accent)]">
        DART 사업보고서 · 유가증권·코스닥 상장 증권·금융·투자
      </p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">
        임원 개인별 보수
      </h1>
      <p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-[var(--fg-muted)]">
        보수 총액 5억원 이상 상위 5인 공시 기준. 행을 누르면 산정기준에 적힌
        보수 종류별 내역을 볼 수 있습니다.
        {updatedAt && (
          <span className="block text-sm">
            수집 시점 {new Date(updatedAt).toLocaleDateString("ko-KR")}
          </span>
        )}
      </p>
    </header>
  );
}

function Tile({
  label,
  children,
  className = "",
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`squircle border border-[var(--border)] bg-[var(--bg-elevated)] p-4 ${className}`}
    >
      <p className="text-xs font-medium tracking-wide text-[var(--fg-muted)]">
        {label}
      </p>
      <div className="mt-2">{children}</div>
    </div>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-full px-3 py-1.5 text-sm transition ${
        active
          ? "bg-[var(--accent)] text-white"
          : "border border-[var(--border)] text-[var(--fg-muted)] hover:text-[var(--fg)]"
      }`}
    >
      {children}
    </button>
  );
}

function Row({
  record,
  rank,
  ratio,
  open,
  onToggle,
}: {
  record: PayRecord;
  rank: number | null;
  ratio: number;
  open: boolean;
  onToggle: () => void;
}) {
  const hasDetail = record.breakdown.length > 0;

  return (
    <li className="squircle overflow-hidden border border-[var(--border)] bg-[var(--bg-elevated)]">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="w-full px-4 py-3.5 text-left transition hover:bg-[var(--accent-soft)]"
      >
        <div className="flex items-center gap-3">
          {rank !== null && (
            <span className="tnum w-7 shrink-0 text-sm font-medium text-[var(--fg-muted)]">
              {rank}
            </span>
          )}
          <div className="min-w-0 flex-1">
            <p className="truncate text-[15px] font-medium">
              {record.name}
              <span className="ml-2 text-sm font-normal text-[var(--fg-muted)]">
                {record.position}
              </span>
            </p>
            <p className="truncate text-sm text-[var(--fg-muted)]">
              {record.corpName} · {record.year}
            </p>
          </div>
          <div className="shrink-0 text-right">
            <span className="tnum text-lg font-semibold">
              {formatKRW(record.total)}
            </span>
            <span
              className={`ml-2 inline-block text-xs text-[var(--fg-muted)] transition-transform ${
                open ? "rotate-180" : ""
              }`}
              aria-hidden
            >
              ▾
            </span>
          </div>
        </div>

        {/* 보수 규모 비교 막대 */}
        <div className="mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-[var(--border)]">
          <div
            className="h-full rounded-full"
            style={{
              width: `${Math.max(ratio * 100, 1.5)}%`,
              background: "linear-gradient(90deg, var(--bar-from), var(--bar-to))",
            }}
          />
        </div>
      </button>

      {open && (
        <div className="border-t border-[var(--border)] px-4 py-4">
          {hasDetail ? (
            <ul className="flex flex-col gap-3">
              {record.breakdown.map((item, i) => (
                <li key={i}>
                  <div className="flex items-baseline justify-between gap-4">
                    <p className="text-sm font-medium">{item.label}</p>
                    <span className="tnum shrink-0 text-sm">
                      {item.amount === null ? "—" : formatFullKRW(item.amount)}
                    </span>
                  </div>
                  {item.note && (
                    <p className="mt-1 text-xs leading-relaxed whitespace-pre-line text-[var(--fg-muted)]">
                      {item.note}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-[var(--fg-muted)]">
              이 건은 산정기준 세부 내역을 아직 수집하지 못했습니다.
            </p>
          )}

          <div className="mt-4 flex items-center justify-between gap-4 border-t border-[var(--border)] pt-3">
            <span className="tnum text-sm text-[var(--fg-muted)]">
              합계 {formatFullKRW(record.total)}
            </span>
            <a
              href={`https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${record.rceptNo}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-[var(--accent)] hover:underline"
            >
              DART 원문 보기 ↗
            </a>
          </div>
        </div>
      )}
    </li>
  );
}

function EmptyState() {
  return (
    <div className="mx-auto w-full max-w-2xl px-6 py-24">
      <h1 className="text-2xl font-semibold tracking-tight">
        아직 수집된 데이터가 없습니다
      </h1>
      <p className="mt-3 leading-relaxed text-[var(--fg-muted)]">
        DART 인증키를 <code className="text-[var(--fg)]">.env.local</code> 의{" "}
        <code className="text-[var(--fg)]">DART_API_KEY</code> 에 넣은 뒤 아래를
        실행하면 이 화면이 채워집니다.
      </p>
      <pre className="squircle mt-4 overflow-x-auto border border-[var(--border)] bg-[var(--bg-elevated)] p-4 text-sm">
        pnpm collect
      </pre>
    </div>
  );
}
