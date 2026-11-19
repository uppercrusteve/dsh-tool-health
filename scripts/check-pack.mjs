// 声明了却打不进包的文件，等于发布残缺。
import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync("package.json", "utf8"));
const packed = new Set(
  JSON.parse(readFileSync("pack.json", "utf8"))[0].files.map((file) => file.path),
);
const missing = [];
const need = [
  manifest.main,
  ...Object.values(manifest.exports || {}).map((value) =>
    typeof value === "string" ? value : value.default
  ),
].filter(Boolean);
for (const file of need) if (!packed.has(file.replace(/^\.\//, ""))) missing.push(file);
for (const entry of manifest.files || []) {
  const clean = entry.replace(/^\.\//, "").replace(/\/$/, "");
  const hit = packed.has(clean) || [...packed].some((path) => path.startsWith(clean + "/"));
  if (!hit) missing.push(entry);
}
if (missing.length) {
  console.error("包里缺:", missing.join(", "));
  process.exit(1);
}
console.log(`包里 ${packed.size} 个文件，声明项齐全`);
