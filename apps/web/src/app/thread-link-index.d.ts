export interface ThreadLinkRecord {
  id?: string;
  publicRef?: string;
  canonicalUrl?: string;
  name?: string;
  bindingName?: string;
  title?: string;
}

export interface ThreadLinkIndex {
  exact: Map<string, string>;
  aliases: Map<string, string>;
}

export function buildThreadLinkIndex(threads?: ThreadLinkRecord[]): ThreadLinkIndex;
export function resolveThreadLink(index: ThreadLinkIndex, value?: string): string;
