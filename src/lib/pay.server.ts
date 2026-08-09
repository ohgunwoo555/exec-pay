import "server-only";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PayDataset, PayRecord } from "./pay";

const EMPTY: PayDataset = { years: [], updatedAt: null, records: [] };

/**
 * data/pay.json 을 읽는다. 아직 수집 전이면 빈 데이터셋을 돌려주고
 * 화면에서 안내를 띄운다.
 */
export function loadPayData(): PayDataset {
  try {
    const raw = readFileSync(resolve(process.cwd(), "data/pay.json"), "utf8");
    const parsed = JSON.parse(raw);
    const records: PayRecord[] = parsed.records ?? [];

    if (!records.length) return EMPTY;

    return {
      years: parsed.years ?? [...new Set(records.map((r) => r.year))].sort(),
      updatedAt: parsed.updatedAt ?? null,
      records,
    };
  } catch {
    return EMPTY;
  }
}
