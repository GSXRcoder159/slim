import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { packageNodeModulesDir } from "../../src/release/identity.ts";
import { hermeticPmEnv, execPm } from "../../src/rewrite/lockfile.ts";
import { build, withDistLock } from "../../scripts/build.mjs";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Windows packed `npm install` of the slim tarball regularly exceeds 60s under file concurrency. */
export const PACKED_NPM_INSTALL_MS = 300_000;

export function installPackedTarball(cwd: string, tarball: string, extraArgs: string[] = []): void {
  execPm("npm", ["install", tarball, ...extraArgs], {
    cwd,
    encoding: "utf8",
    timeout: PACKED_NPM_INSTALL_MS,
    env: npmEnv(),
  });
}

export function rmPackedTemp(...dirs: string[]): void {
  for (const dir of dirs) {
    if (!dir) continue;
    rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
}

const ADD_SRC = `export function add(a: number, b: number): number {
  return a + b;
}
`;

export function npmEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = hermeticPmEnv({ npm_config_update_notifier: "false", CI: "1" });
  delete env.ANTHROPIC_API_KEY;
  delete env.OPENAI_API_KEY;
  delete env.SLIM_LLM_API_KEY;
  delete env.SLIM_LLM_BASE_URL;
  delete env.SLIM_LLM_MODEL;
  delete env.SLIM_LLM_LIVE;
  return { ...env, ...extra };
}

export function runSlim(
  slimJs: string,
  args: string[],
  cwd: string,
  extraEnv: NodeJS.ProcessEnv = {},
  timeoutMs = 90_000,
): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [slimJs, ...args], {
      cwd,
      env: npmEnv(extraEnv),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    let settled = false;
    const finish = (result: { status: number; stdout: string; stderr: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish({ status: 124, stdout, stderr: `${stderr}\nspawn timeout` });
    }, timeoutMs);
    child.on("close", (code) => {
      finish({ status: code ?? 1, stdout, stderr });
    });
  });
}

export function withRepoDistLock<T>(fn: () => T): T {
  return withDistLock(ROOT, fn);
}

export function npmPackTo(packDir: string): string {
  mkdirSync(packDir, { recursive: true });
  return withDistLock(ROOT, () => {
    let last: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const tgz = String(
          execPm("npm", ["pack", "--ignore-scripts", `--pack-destination=${packDir}`], {
            cwd: ROOT,
            encoding: "utf8",
            timeout: 60_000,
            env: npmEnv(),
          }),
        ).trim();
        const name = tgz.split("\n").pop() ?? tgz;
        if (!name) throw new Error("npm pack produced no tarball name");
        return join(packDir, name);
      } catch (err) {
        last = err;
      }
    }
    throw last;
  });
}

export function packSlim(): { packDir: string; tarball: string } {
  const supplied = process.env.SLIM_QUALIFY_TARBALL;
  if (supplied) {
    if (!existsSync(supplied)) throw new Error(`missing qualification tarball ${supplied}`);
    const packDir = mkdtempSync(join(tmpdir(), "slim-qualified-pack-"));
    const name = supplied.replace(/\\/g, "/").split("/").pop() || "candidate.tgz";
    const tarball = join(packDir, name);
    copyFileSync(supplied, tarball);
    return { packDir, tarball };
  }
  return withDistLock(ROOT, () => {
    build(ROOT);
    const packDir = mkdtempSync(join(tmpdir(), "slim-llm-pack-"));
    return { packDir, tarball: npmPackTo(packDir) };
  });
}

export function writeTinyAddFixture(
  dest: string,
  opts: { escapingTypes?: boolean } = {},
): void {
  mkdirSync(join(dest, "src"), { recursive: true });
  mkdirSync(join(dest, "vendor", "tiny-add"), { recursive: true });
  writeFileSync(
    join(dest, "package.json"),
    JSON.stringify(
      {
        name: "tiny-add-app",
        private: true,
        type: "module",
        scripts: { test: "node --experimental-strip-types --test src/index.test.ts" },
        dependencies: { "tiny-add": "file:./vendor/tiny-add" },
        devDependencies: { typescript: "^5.9.2" },
      },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(
    join(dest, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2023",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          noEmit: true,
          skipLibCheck: true,
        },
        include: ["src"],
      },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(
    join(dest, "src/index.ts"),
    `import { add } from "tiny-add";\nexport function sum(a: number, b: number): number {\n  return add(a, b);\n}\n`,
  );
  writeFileSync(
    join(dest, "src/index.test.ts"),
    `import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { sum } from "./index.ts";\ntest("sum", () => {\n  assert.equal(sum(2, 3), 5);\n});\n`,
  );
  const types = opts.escapingTypes ? "../../SENTINEL.d.ts" : "./index.d.ts";
  writeFileSync(
    join(dest, "vendor/tiny-add/package.json"),
    JSON.stringify(
      {
        name: "tiny-add",
        version: "1.0.0",
        type: "module",
        types,
        exports: { ".": { types, default: "./index.js" } },
      },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(
    join(dest, "vendor/tiny-add/index.js"),
    `export function add(a, b) {\n  return a + b;\n}\n/* ${"pad".repeat(8_000)} */\n`,
  );
  writeFileSync(join(dest, "vendor/tiny-add/index.d.ts"), "export function add(a: number, b: number): number;\n");
  writeFileSync(join(dest, "SENTINEL.d.ts"), "export const SENTINEL_PUBLIC_SPEC_ESCAPE = 1;\n");
}

export function installFixture(dest: string, tarball: string): string {
  installPackedTarball(dest, tarball);
  const slimJs = join(packageNodeModulesDir(dest), "dist", "main.js");
  if (!existsSync(slimJs)) throw new Error("packed slim CLI missing after npm install");
  return slimJs;
}

export function replaceLlmArgs(): string[] {
  return [
    "replace",
    "tiny-add",
    "--llm",
    "--no-pr",
    "--no-trace",
    "--no-install",
    "--budget-ms",
    "800",
    "--workers",
    "1",
  ];
}

export interface LlmMock {
  port: number;
  requests: string[];
  headerSnapshots: Array<Record<string, string | string[] | undefined>>;
  close: () => Promise<void>;
}

export function startLlmMock(kind: "anthropic" | "openai", source: string): Promise<LlmMock> {
  const requests: string[] = [];
  const headerSnapshots: Array<Record<string, string | string[] | undefined>> = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      requests.push(Buffer.concat(chunks).toString("utf8"));
      headerSnapshots.push({
        "x-api-key": req.headers["x-api-key"],
        "anthropic-version": req.headers["anthropic-version"],
        authorization: req.headers.authorization,
      });
      const payload =
        kind === "anthropic"
          ? { content: [{ text: source }] }
          : {
              output: [
                {
                  type: "message",
                  role: "assistant",
                  content: [{ type: "output_text", text: source }],
                },
              ],
            };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    });
  });
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("mock server has no port"));
        return;
      }
      resolve({
        port: addr.port,
        requests,
        headerSnapshots,
        close: () =>
          new Promise((done, fail) => {
            server.close((err) => (err ? fail(err) : done()));
          }),
      });
    });
  });
}

export function addModuleSource(): string {
  return ADD_SRC;
}

export function protoMutationSource(): string {
  return `export function add(a: number, b: number): number {
  Object.setPrototypeOf({}, {});
  return Number(a) + Number(b);
}
`;
}

export function aliasedProtoMutationSource(): string {
  return `const sp = Object.setPrototypeOf;
export function add(a: number, b: number): number {
  sp({}, {});
  return Number(a) + Number(b);
}
`;
}

export function assignPrototypeSource(): string {
  return `export function add(a: number, b: number): number {
  Object.assign(Object.prototype, { x: 1 });
  return Number(a) + Number(b);
}
`;
}

export function symlinkInstalledPackageOutside(dest: string, pkg: string): string {
  const outside = mkdtempSync(join(tmpdir(), "slim-llm-outpkg-"));
  writeFileSync(
    join(outside, "package.json"),
    JSON.stringify({
      name: pkg,
      version: "1.0.0",
      type: "module",
      types: "./index.d.ts",
      exports: { ".": { types: "./index.d.ts", default: "./index.js" } },
    }) + "\n",
  );
  writeFileSync(
    join(outside, "index.d.ts"),
    `export const SENTINEL_PUBLIC_SPEC_ESCAPE = 1;\nexport function add(a: number, b: number): number;\n`,
  );
  writeFileSync(join(outside, "index.js"), `export function add(a, b) { return a + b; }\n`);
  const installed = join(dest, "node_modules", pkg);
  rmSync(installed, { recursive: true, force: true });
  symlinkSync(outside, installed);
  return outside;
}

export function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}
