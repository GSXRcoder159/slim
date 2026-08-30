import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
function defaultHasBin(name) {
    try {
        execFileSync(name, ["--version"], { stdio: "ignore" });
        return true;
    }
    catch {
        return false;
    }
}
function defaultExec(file, args, opts) {
    return String(execFileSync(file, [...args], { ...opts, stdio: ["ignore", "pipe", "pipe"] }));
}
export function findBundleEntry(root) {
    if (existsSync(join(root, "wrangler.toml"))) {
        const text = readFileSync(join(root, "wrangler.toml"), "utf8");
        const m = text.match(/^\s*main\s*=\s*["']([^"']+)["']/m);
        if (m?.[1] && existsSync(join(root, m[1])))
            return m[1];
    }
    for (const cand of ["src/worker.ts", "src/worker.js", "src/index.ts", "src/index.js", "src/main.ts"]) {
        if (existsSync(join(root, cand)))
            return cand;
    }
    try {
        const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
        if (pkg.main && existsSync(join(root, pkg.main)))
            return pkg.main;
    }
    catch {
        /* ignore */
    }
    return null;
}
/** Dry-bundle with wrangler or esbuild if on PATH. Missing tools → null. */
export function maybeBundleBytes(root, deps = {}) {
    const entry = findBundleEntry(root);
    if (!entry)
        return null;
    const hasBin = deps.hasBin ?? defaultHasBin;
    const execFile = deps.execFile ?? defaultExec;
    const makeTmp = deps.tmpDir ?? (() => mkdtempSync(join(tmpdir(), "slim-bundle-")));
    if (hasBin("wrangler")) {
        const dir = makeTmp();
        try {
            execFile("wrangler", ["deploy", "--dry-run", "--outdir", dir], {
                cwd: root,
                encoding: "utf8",
                timeout: 60_000,
            });
            const bytes = dirBytes(dir);
            if (bytes > 0)
                return { tool: "wrangler", bytes, entry };
        }
        catch {
            /* fall through to esbuild */
        }
        finally {
            try {
                rmSync(dir, { recursive: true, force: true });
            }
            catch {
                /* ignore */
            }
        }
    }
    if (hasBin("esbuild")) {
        const dir = makeTmp();
        mkdirSync(dir, { recursive: true });
        const out = join(dir, "bundle.js");
        try {
            execFile("esbuild", [entry, "--bundle", "--outfile=" + out, "--platform=neutral", "--format=esm", "--minify"], { cwd: root, encoding: "utf8", timeout: 30_000 });
            if (existsSync(out))
                return { tool: "esbuild", bytes: readFileSync(out).byteLength, entry };
        }
        catch {
            return null;
        }
        finally {
            try {
                rmSync(dir, { recursive: true, force: true });
            }
            catch {
                /* ignore */
            }
        }
    }
    return null;
}
function dirBytes(dir) {
    if (!existsSync(dir))
        return 0;
    let n = 0;
    const stack = [dir];
    while (stack.length) {
        const d = stack.pop();
        let ents;
        try {
            ents = readdirSync(d, { withFileTypes: true });
        }
        catch {
            continue;
        }
        for (const e of ents) {
            const p = join(d, e.name);
            if (e.isDirectory())
                stack.push(p);
            else {
                try {
                    n += statSync(p).size;
                }
                catch {
                    /* ignore */
                }
            }
        }
    }
    return n;
}
void writeFileSync;
//# sourceMappingURL=bundle.js.map