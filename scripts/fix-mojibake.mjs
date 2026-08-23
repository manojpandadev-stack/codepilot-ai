import { readFileSync, writeFileSync } from "node:fs";

// Reverses Windows-1252 mojibake introduced by a PowerShell re-encode.
const pairs = [
  ["ðŸ”—", "🔗"],
  ["ðŸ“„", "📄"],
  ["ðŸ“\u0081", "📁"],
  ["ðŸ“\u009D", "📝"],
  ["â€”", "—"],
  ["â€“", "–"],
  ["â€¦", "…"],
  ["âœ“", "✓"],
  ["âš\u00A0", "⚠"],
  ["Â·", "·"],
  ["Ã¢", "â"],
];

const file = "apps/webview/src/lib/messages.ts";
let s = readFileSync(file, "utf8").replace(/^\uFEFF/, "");
for (const [bad, good] of pairs) s = s.split(bad).join(good);
writeFileSync(file, s, "utf8");
console.log("mojibake fixed");
