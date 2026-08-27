import { execFileSync, spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hermeticPmEnv } from "../../src/rewrite/lockfile.ts";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

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

export function packSlim(): { packDir: string; tarball: string } {
  execFileSync("npm", ["run", "build"], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 60_000,
    env: npmEnv(),
  });
  const packDir = mkdtempSync(join(tmpdir(), "slim-llm-pack-"));
  const tgz = execFileSync(
    "npm",
    ["pack", "--silent", "--ignore-scripts", `--pack-destination=${packDir}`],
    { cwd: ROOT, encoding: "utf8", timeout: 60_000, env: npmEnv() },
  ).trim();
  return { packDir, tarball: join(packDir, tgz.split("\n").pop() ?? tgz) };
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
  execFileSync("npm", ["install", tarball], {
    cwd: dest,
    encoding: "utf8",
    timeout: 120_000,
    env: npmEnv(),
  });
  const slimJs = join(dest, "node_modules", "slim", "dist", "main.js");
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

export function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}
