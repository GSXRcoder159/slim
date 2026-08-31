/**
 * MIT License
 *
 * Git author identity and GitHub HTTPS credentials for CI runners without a TTY.
 */

export const SLIM_GIT_NAME = "slim";
export const SLIM_GIT_EMAIL = "slim@users.noreply.github.com";

export function gitIdentEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env };
  if (!next.GIT_AUTHOR_NAME) next.GIT_AUTHOR_NAME = SLIM_GIT_NAME;
  if (!next.GIT_AUTHOR_EMAIL) next.GIT_AUTHOR_EMAIL = SLIM_GIT_EMAIL;
  if (!next.GIT_COMMITTER_NAME) next.GIT_COMMITTER_NAME = next.GIT_AUTHOR_NAME;
  if (!next.GIT_COMMITTER_EMAIL) next.GIT_COMMITTER_EMAIL = next.GIT_AUTHOR_EMAIL;
  return next;
}

export function gitRemoteEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const next = gitIdentEnv(env);
  const token = next.GITHUB_TOKEN || next.GH_TOKEN;
  if (!token) return next;
  const n = Number(next.GIT_CONFIG_COUNT ?? "0") || 0;
  next.GIT_CONFIG_COUNT = String(n + 1);
  next[`GIT_CONFIG_KEY_${n}`] = "http.https://github.com/.extraheader";
  next[`GIT_CONFIG_VALUE_${n}`] =
    `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`, "utf8").toString("base64")}`;
  return next;
}
