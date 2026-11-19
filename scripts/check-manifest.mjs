// 发布前静态体检：清单自洽、声明路径真实存在、patch 与包名对得上。
// 跑不了 dsh 宿主，所以只查能查的——真机安装结论仍以 README 里的实测记录为准。
import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fail = [];
const pass = [];

async function ok(label, path) {
  try {
    await access(resolve(root, path));
    pass.push(label);
  } catch {
    fail.push(`${label}：找不到 ${path}`);
  }
}

const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));

if (!manifest.name?.startsWith("@uppercrusteve/")) fail.push(`包名不对：${manifest.name}`);
if (!manifest.description) fail.push("缺 description");
if (manifest.license !== "MIT") fail.push(`许可证应为 MIT，现在是 ${manifest.license}`);
if (!manifest.repository?.url?.includes(manifest.name?.split("/")[1])) {
  fail.push("repository.url 与包名对不上");
}
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version || "")) {
  fail.push(`版本号不是 semver：${manifest.version}`);
}

for (const entry of manifest.files || []) await ok(`files 项 ${entry}`, entry);
await ok("main", manifest.main);

for (const [key, target] of Object.entries(manifest.exports || {})) {
  const file = typeof target === "string" ? target : target.default;
  if (file) await ok(`exports ${key}`, file);
}

if (manifest.dsh?.client) {
  if (manifest.dsh.client.platform !== "web") fail.push("dsh.client.platform 应为 web");
  if (!manifest.exports?.["./client"]) fail.push("声明了 dsh.client 但没导出 ./client");
}

const patchPath = manifest.dsh?.bundle?.patch;
if (patchPath) {
  await ok("dsh.bundle.patch", patchPath);
  try {
    const patch = await readFile(resolve(root, patchPath), "utf8");
    if (!patch.includes(`'${manifest.name}'`)) fail.push("patch 里没有引用本包名");
    if (!/^\s*-\s*insert:/m.test(patch)) fail.push("patch 没有 insert 段");
  } catch {
    /* ok() 已经记过 */
  }
} else {
  fail.push("没有声明 dsh.bundle.patch");
}

console.log(`通过 ${pass.length} 项`);
for (const line of fail) console.error(`✖ ${line}`);
if (fail.length) process.exit(1);
