/**
 * 严格 JSONL 分帧。
 *
 * 只按 LF 切分（允许前置 CR），**不按 U+2028 / U+2029 切**——这两个字符在 JSON 字符串里合法，
 * 用 Node 的 readline 会把一条记录劈成两条（见 pi docs/rpc.md「Framing」）。
 */

export type JsonlHandlers = {
  onRecord: (record: unknown, raw: string) => void;
  onMalformed?: (error: Error, raw: string) => void;
};

export function createJsonlReader(handlers: JsonlHandlers) {
  let buffer = "";

  return {
    /** 输入必须是完整的 UTF-8 解码结果（调用方应先 setEncoding("utf8")）。 */
    push(chunk: string): void {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        let line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line.length === 0) continue;
        try {
          handlers.onRecord(JSON.parse(line), line);
        } catch (error) {
          handlers.onMalformed?.(error as Error, line);
        }
      }
    },
    /** 流结束时处理没有以 LF 结尾的残余记录。 */
    flush(): void {
      const rest = buffer.trim();
      buffer = "";
      if (rest.length === 0) return;
      try {
        handlers.onRecord(JSON.parse(rest), rest);
      } catch (error) {
        handlers.onMalformed?.(error as Error, rest);
      }
    },
  };
}
