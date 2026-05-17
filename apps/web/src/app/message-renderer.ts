function escapeHtml(value: unknown): string {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttribute(value: unknown): string {
  return escapeHtml(value).replace(/`/g, "&#96;");
}

function splitUrlSuffix(value: string): { url: string; suffix: string } {
  let url = String(value || "");
  let suffix = "";
  while (url.length > 1 && /[.,;!?)]$/.test(url)) {
    suffix = `${url.at(-1)}${suffix}`;
    url = url.slice(0, -1);
  }
  return { url, suffix };
}

function safeHttpUrl(value: string): string {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
}

function renderHttpLink(rawUrl: string, label = rawUrl, className = "orkestr-message-link"): string {
  const href = safeHttpUrl(rawUrl);
  if (!href) return escapeHtml(label);
  return `<a class="${className}" href="${escapeAttribute(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`;
}

function renderPlainLinks(text: string): string {
  const value = String(text || "");
  const urlPattern = /https?:\/\/[^\s<>"']+/g;
  let html = "";
  let index = 0;
  let match: RegExpExecArray | null;

  while ((match = urlPattern.exec(value)) !== null) {
    html += escapeHtml(value.slice(index, match.index));
    const { url, suffix } = splitUrlSuffix(match[0]);
    html += renderHttpLink(url);
    html += escapeHtml(suffix);
    index = match.index + match[0].length;
  }

  html += escapeHtml(value.slice(index));
  return html;
}

function renderMarkdownLinks(text: string): string {
  const value = String(text || "");
  const linkPattern = /\[([^\]\n]{1,180})\]\((https?:\/\/[^)\s]+)\)/g;
  let html = "";
  let index = 0;
  let match: RegExpExecArray | null;

  while ((match = linkPattern.exec(value)) !== null) {
    html += renderPlainLinks(value.slice(index, match.index));
    const { url, suffix } = splitUrlSuffix(match[2]);
    html += renderHttpLink(url, match[1]);
    html += escapeHtml(suffix);
    index = match.index + match[0].length;
  }

  html += renderPlainLinks(value.slice(index));
  return html;
}

function renderBold(text: string): string {
  const value = String(text || "");
  let html = "";
  let index = 0;

  while (index < value.length) {
    const start = value.indexOf("**", index);
    if (start === -1) {
      html += renderMarkdownLinks(value.slice(index));
      break;
    }

    const end = value.indexOf("**", start + 2);
    if (end === -1) {
      html += renderMarkdownLinks(value.slice(index));
      break;
    }

    html += renderMarkdownLinks(value.slice(index, start));
    html += `<strong>${renderMarkdownLinks(value.slice(start + 2, end))}</strong>`;
    index = end + 2;
  }

  return html;
}

function renderInline(text: string): string {
  const value = String(text || "");
  let html = "";
  let index = 0;

  while (index < value.length) {
    const start = value.indexOf("`", index);
    if (start === -1) {
      html += renderBold(value.slice(index));
      break;
    }

    const end = value.indexOf("`", start + 1);
    if (end === -1) {
      html += renderBold(value.slice(index));
      break;
    }

    html += renderBold(value.slice(index, start));
    const code = value.slice(start + 1, end);
    const href = safeHttpUrl(code);
    html += href
      ? renderHttpLink(code, code, "orkestr-message-link inline-code-link")
      : `<code class="orkestr-inline-code">${escapeHtml(code)}</code>`;
    index = end + 1;
  }

  return html;
}

function renderParagraph(lines: string[]): string {
  const content = lines.map((line) => renderInline(line)).join("<br>");
  return content.trim() ? `<p class="orkestr-message-paragraph">${content}</p>` : "";
}

function renderListItem(lines: string[]): string {
  return lines.map((line) => renderInline(line.trim())).filter(Boolean).join("<br>");
}

function renderList(lines: string[], ordered: boolean): { html: string; nextIndex: number } {
  const tag = ordered ? "ol" : "ul";
  const itemPattern = ordered ? /^\s*\d+[.)]\s+(.+)$/ : /^\s*[-*]\s+(.+)$/;
  const items: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const match = lines[index].match(itemPattern);
    if (!match) break;
    const itemLines = [match[1]];
    index += 1;

    while (index < lines.length) {
      const line = lines[index];
      if (!line.trim()) {
        index += 1;
        break;
      }
      if (itemPattern.test(line) || /^\s*(?:\d+[.)]|[-*])\s+/.test(line)) break;
      if (/^\s{2,}\S/.test(line)) {
        itemLines.push(line.trim());
        index += 1;
        continue;
      }
      break;
    }

    items.push(`<li>${renderListItem(itemLines)}</li>`);
  }

  return {
    html: items.length ? `<${tag} class="orkestr-message-list">${items.join("")}</${tag}>` : "",
    nextIndex: index,
  };
}

function renderCodeFence(lines: string[]): { html: string; nextIndex: number } {
  const codeLines: string[] = [];
  let index = 1;
  while (index < lines.length && !lines[index].trim().startsWith("```")) {
    codeLines.push(lines[index]);
    index += 1;
  }
  if (index < lines.length) index += 1;
  return {
    html: `<pre class="orkestr-code-block"><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`,
    nextIndex: index,
  };
}

export function renderMessageTextHtml(text: string | null | undefined): string {
  const lines = String(text || "").split(/\r?\n/);
  const blocks: string[] = [];
  let paragraph: string[] = [];
  let index = 0;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    blocks.push(renderParagraph(paragraph));
    paragraph = [];
  };

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      flushParagraph();
      index += 1;
      continue;
    }

    if (line.trim().startsWith("```")) {
      flushParagraph();
      const fence = renderCodeFence(lines.slice(index));
      blocks.push(fence.html);
      index += fence.nextIndex;
      continue;
    }

    if (/^\s*\d+[.)]\s+/.test(line)) {
      flushParagraph();
      const list = renderList(lines.slice(index), true);
      blocks.push(list.html);
      index += list.nextIndex;
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      flushParagraph();
      const list = renderList(lines.slice(index), false);
      blocks.push(list.html);
      index += list.nextIndex;
      continue;
    }

    paragraph.push(line);
    index += 1;
  }

  flushParagraph();
  return blocks.filter(Boolean).join("");
}
