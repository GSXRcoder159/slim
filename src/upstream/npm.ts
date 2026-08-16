export interface NpmLatest {
  version: string;
  time?: string;
}

export async function npmLatest(
  name: string,
  fetchImpl: typeof fetch = fetch,
): Promise<NpmLatest> {
  const res = await fetchImpl(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`);
  if (!res.ok) throw new Error(`npm registry HTTP ${res.status} for ${name}`);
  const json = (await res.json()) as { version: string; time?: { modified?: string } };
  return { version: json.version, time: json.time?.modified };
}
