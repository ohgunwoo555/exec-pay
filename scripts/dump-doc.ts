/**
 * 사업보고서 원문을 받아 .cache/documents 에 저장하고,
 * 임원 보수 관련 구간을 잘라 미리보기한다. 파서를 만들 때 쓰는 도구.
 *
 *   pnpm tsx scripts/dump-doc.ts 20260310002820
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fetchDocument } from "./lib/dart.js";

process.loadEnvFile(".env.local");

const CACHE_DIR = resolve(process.cwd(), ".cache/documents");

async function main() {
  const rceptNo = process.argv[2];
  if (!rceptNo) throw new Error("접수번호를 인자로 넘겨주세요.");

  mkdirSync(CACHE_DIR, { recursive: true });
  const path = resolve(CACHE_DIR, `${rceptNo}.xml`);

  let doc: string;
  if (existsSync(path)) {
    doc = readFileSync(path, "utf8");
    console.log(`캐시 사용: ${path}`);
  } else {
    doc = await fetchDocument(rceptNo);
    writeFileSync(path, doc, "utf8");
    console.log(`저장: ${path}`);
  }

  console.log(`전체 길이 ${doc.length.toLocaleString()}자`);

  const marker = "산정기준 및 방법";
  let from = 0;
  let hit = 0;
  while (true) {
    const at = doc.indexOf(marker, from);
    if (at === -1) break;
    hit++;
    console.log(`\n===== "${marker}" #${hit} @ ${at} =====`);
    console.log(doc.slice(at - 400, at + 2500));
    from = at + marker.length;
    if (hit >= 2) break;
  }
  if (!hit) console.log(`"${marker}" 를 찾지 못했습니다.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
