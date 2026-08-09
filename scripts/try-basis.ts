/**
 * 파서 확인용. 접수번호를 여러 개 넘길 수 있다.
 *   pnpm tsx scripts/try-basis.ts 20260319000718 20230316001545
 */
import { fetchDocument } from "./lib/dart.js";
import { parseBasis, sliceBasisTables } from "./lib/basis.js";

process.loadEnvFile(".env.local");

async function main() {
  for (const rceptNo of process.argv.slice(2)) {
    const doc = await fetchDocument(rceptNo);
    const slices = sliceBasisTables(doc);
    const rows = parseBasis(doc);

    console.log(`\n=== ${rceptNo}: 슬라이스 ${slices.length}, 행 ${rows.length}`);
    for (const row of rows.slice(0, 6)) {
      const amount = row.amount === null ? "—" : row.amount.toLocaleString("ko-KR");
      console.log(`  [${row.person}] ${row.category || "-"} / ${row.kind} = ${amount}`);
      if (row.note) console.log(`      ${row.note.slice(0, 80).replace(/\n/g, " ⏎ ")}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
