/**
 * Markdown → 安全 HTML（纯 TS，可单测，不依赖 Vue）。
 *
 * 为什么必须消毒：agent 的输出是不可信文本。它可能包含
 * `<img onerror=...>`、`<script>`、`javascript:` 链接等，直接 v-html 就是 XSS。
 */
import DOMPurify from "dompurify";
import { marked } from "marked";

marked.setOptions({ gfm: true, breaks: true });

const ALLOWED_TAGS = [
  "p", "br", "strong", "em", "del", "code", "pre", "blockquote",
  "ul", "ol", "li", "a", "h1", "h2", "h3", "h4", "h5", "h6",
  "table", "thead", "tbody", "tr", "th", "td", "hr", "span",
];

export function renderMarkdown(text: string): string {
  if (!text) return "";
  const raw = marked.parse(text, { async: false }) as string;
  return DOMPurify.sanitize(raw, {
    ALLOWED_TAGS,
    ALLOWED_ATTR: ["href", "title", "class"],
    // 只允许 http/https/mailto，挡掉 javascript: 与 data:
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|#|\/)/i,
    FORBID_TAGS: ["style", "form", "input", "iframe", "object", "embed", "svg"],
    FORBID_ATTR: ["style", "onerror", "onload", "onclick"],
  });
}
