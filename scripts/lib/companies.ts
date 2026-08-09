import { readFileSync } from "node:fs";
import { fetchCorpCodes, type CorpCodeEntry } from "./dart.js";

/** 회사명에 이 중 하나가 들어가면 수집 대상 후보로 본다. */
const NAME_KEYWORDS = ["증권", "금융", "투자"];

const OVERRIDE_PATH = new URL("../../data/companies.override.json", import.meta.url);

type Override = {
  /** 키워드에 걸리지만 대상이 아닌 회사 (corp_name 정확히 일치) */
  exclude: string[];
  /** 키워드에 안 걸리지만 대상에 넣을 회사 (예: 신한지주) */
  include: string[];
};

function loadOverride(): Override {
  try {
    const parsed = JSON.parse(readFileSync(OVERRIDE_PATH, "utf8"));
    return {
      exclude: parsed.exclude ?? [],
      include: parsed.include ?? [],
    };
  } catch {
    return { exclude: [], include: [] };
  }
}

export type Company = { corp_code: string; corp_name: string; stock_code: string };

/**
 * 수집 대상 회사 목록.
 *
 * 1차로 이름에 증권/금융/투자가 들어가는 상장사를 고르고,
 * data/companies.override.json 으로 수동 보정한다.
 * 유가증권 상장 여부(corp_cls === "Y")는 corpCode.xml에 없으므로
 * 보수 API 응답을 받은 뒤에 거른다.
 */
export async function resolveCompanies(): Promise<Company[]> {
  const all = await fetchCorpCodes();
  const { exclude, include } = loadOverride();

  const excluded = new Set(exclude);
  const included = new Set(include);

  const listed = (e: CorpCodeEntry) => e.stock_code.length > 0;
  const matches = (e: CorpCodeEntry) =>
    NAME_KEYWORDS.some((kw) => e.corp_name.includes(kw));

  const picked = all.filter(
    (e) =>
      listed(e) && !excluded.has(e.corp_name) && (matches(e) || included.has(e.corp_name))
  );

  return picked
    .map(({ corp_code, corp_name, stock_code }) => ({
      corp_code,
      corp_name,
      stock_code,
    }))
    .sort((a, b) => a.corp_name.localeCompare(b.corp_name, "ko"));
}
