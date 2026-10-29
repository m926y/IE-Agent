import { access, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";

const projectRoot = new URL("../", import.meta.url);
const publishRoot = new URL("../.qw-pages/publish/", import.meta.url);

async function requireFile(relativePath) {
  const url = new URL(relativePath, projectRoot);
  await access(url);
  return url;
}

await Promise.all([
  requireFile("dist/index.html"),
  requireFile("server.mjs"),
  requireFile("package.json"),
  requireFile("package-lock.json"),
]);

await rm(publishRoot, { force: true, recursive: true });
await mkdir(publishRoot, { recursive: true });

await Promise.all([
  cp(new URL("dist/", projectRoot), new URL("dist/", publishRoot), {
    recursive: true,
  }),
  cp(new URL("server.mjs", projectRoot), new URL("server.mjs", publishRoot)),
  cp(new URL("package.json", projectRoot), new URL("package.json", publishRoot)),
  cp(
    new URL("package-lock.json", projectRoot),
    new URL("package-lock.json", publishRoot),
  ),
]);

try {
  await access(new URL("server/", projectRoot));
  await cp(new URL("server/", projectRoot), new URL("server/", publishRoot), {
    recursive: true,
  });
} catch (error) {
  if (error?.code !== "ENOENT") {
    throw error;
  }
}

const packageJson = JSON.parse(
  await readFile(new URL("package.json", publishRoot), "utf8"),
);
if (packageJson.type !== "module") {
  throw new Error('Dynamic publish package must use "type": "module"');
}
// The legacy hosted artifact keeps its standalone entry; the source tree defaults to source-only local mode.
packageJson.scripts = { start: "node server.mjs" };
// Hosted platform runtime is Node.js 22; server.mjs has no Node24/sqlite requirement (those belong to local-workbench scripts).
packageJson.engines = { node: ">=22" };
await writeFile(new URL("package.json", publishRoot), JSON.stringify(packageJson, null, 2) + "\n");
