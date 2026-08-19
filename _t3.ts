import { readFileSync } from "node:fs";
import * as cheerio from "cheerio";

const doc = readFileSync(".cache/documents/20260813001767.xml", "utf8");
const RE = /<TABLE-GROUP[^>]*ACLASS="SUB_CMPK_HIGH"[^>]*>[\s\S]*?<\/TABLE-GROUP>/g;

const groups = [...doc.matchAll(RE)].map((m) => m[0]);
console.log("정규식 매칭:", groups.length, "개");
if (!groups.length) process.exit(0);

groups.forEach((g, i) => {
  const $ = cheerio.load(g, { xml: true });
  const name = $('[ACODE="CMPK_NM"]').first().text().trim();
  const $cur = $('[AUNITVALUE="CFY"]').first().closest("TR");
  console.log(
    `[${i}] 길이=${g.length}` +
      ` 이름="${name}"` +
      ` CFY문자열=${g.includes('AUNITVALUE="CFY"')}` +
      ` CFY선택=${$('[AUNITVALUE="CFY"]').length}` +
      ` TR=${$cur.length}` +
      ` 직위="${$cur.find('[ACODE="CMPK_LEV"]').first().text().trim()}"` +
      ` 금액="${$cur.find('[ACODE="CMPK_PAY"]').first().text().trim()}"`
  );
});

console.log("\n--- 첫 그룹 앞부분 1200자 ---");
console.log(groups[0].slice(0, 1200));
