function clean(value = "") {
  return String(value || "").trim();
}

export function buildThreadLinkIndex(threads = []) {
  const exact = new Map();
  const aliases = new Map();
  for (const thread of Array.isArray(threads) ? threads : []) {
    const canonicalUrl = clean(thread?.canonicalUrl);
    if (!canonicalUrl) continue;
    for (const value of [thread.id, thread.publicRef]) {
      const key = clean(value);
      if (key) exact.set(key, canonicalUrl);
    }
    for (const value of [thread.name, thread.bindingName, thread.title]) {
      const key = clean(value);
      if (!key) continue;
      const matches = aliases.get(key) || new Set();
      matches.add(canonicalUrl);
      aliases.set(key, matches);
    }
  }
  return {
    exact,
    aliases: new Map([...aliases].flatMap(([key, matches]) => matches.size === 1 ? [[key, [...matches][0]]] : [])),
  };
}

export function resolveThreadLink(index, value = "") {
  const key = clean(value);
  return index?.exact?.get(key) || index?.aliases?.get(key) || "";
}
