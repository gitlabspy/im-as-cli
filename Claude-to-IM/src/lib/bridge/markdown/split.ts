/**
 * Final-reply splitter.
 *
 * Splits a long assistant reply into ≤ maxChars chunks, prepending
 * "最终回复 ✔" to the first chunk and "最终回复 ✔（续 N/M）" to continuations.
 * Re-fences code blocks that get split mid-block so each chunk is
 * independently renderable.
 */

const DEFAULT_MAX_CHARS = 3500;

/** Marker prefix for the first chunk of a final reply. */
const FIRST_MARKER = '最终回复 ✔';

/** Marker prefix for continuation chunks; `n`/`total` are 1-based. */
function contMarker(n: number, total: number): string {
  return `最终回复 ✔（续 ${n}/${total}）`;
}

interface SplitOpts {
  /** Maximum characters per chunk (markers included). */
  maxChars?: number;
}

/**
 * Detect the open fenced code block at the end of `text`, if any.
 * Returns the fence info (info string after ```) if unterminated, else null.
 */
function pendingCodeFence(text: string): string | null {
  let inFence = false;
  let fenceInfo = '';
  for (const line of text.split('\n')) {
    const m = line.match(/^```(.*)$/);
    if (m) {
      if (inFence) {
        inFence = false;
        fenceInfo = '';
      } else {
        inFence = true;
        fenceInfo = m[1] ?? '';
      }
    }
  }
  return inFence ? fenceInfo : null;
}

/**
 * Split `text` into chunks each ≤ budget characters.
 * Prefers boundaries at: blank line > newline > sentence end > space.
 */
function chunkByBudget(text: string, budget: number): string[] {
  if (text.length <= budget) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > budget) {
    const window = rest.slice(0, budget);
    let cut = window.lastIndexOf('\n\n');
    if (cut < budget * 0.5) cut = window.lastIndexOf('\n');
    if (cut < budget * 0.5) {
      const m = window.match(/[.!?。！？]\s[^.!?。！？]*$/);
      if (m && m.index !== undefined && m.index >= budget * 0.5) {
        cut = m.index + 1;
      }
    }
    if (cut < budget * 0.5) cut = window.lastIndexOf(' ');
    if (cut <= 0) cut = budget;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).replace(/^\s+/, '');
  }
  if (rest.length > 0) out.push(rest);
  return out;
}

function repairSplitCodeFences(raw: string[]): string[] {
  const fenced: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    let chunk = raw[i];
    const open = pendingCodeFence(chunk);
    if (open !== null && i < raw.length - 1) {
      chunk = chunk + '\n```';
      raw[i + 1] = '```' + open + '\n' + raw[i + 1];
    }
    fenced.push(chunk);
  }
  return fenced;
}

/**
 * Split only the final reply body, without adding any visible marker text.
 * Used when the marker lives in the container, such as Feishu final cards.
 */
export function splitFinalReplyBody(text: string, opts: SplitOpts = {}): string[] {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const body = text ?? '';
  const budget = Math.max(200, maxChars);
  const raw = chunkByBudget(body, budget);
  if (raw.length === 0) return [''];
  return repairSplitCodeFences(raw);
}

/**
 * Split a final reply into IM-friendly chunks with marker prefixes.
 * Empty/whitespace input returns a single chunk with just the marker.
 */
export function splitFinalReply(text: string, opts: SplitOpts = {}): string[] {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const body = text ?? '';

  // Reserve header room — worst case continuation marker is ~24 chars.
  const headerReserve = 32;
  const budget = Math.max(200, maxChars - headerReserve);

  const raw = chunkByBudget(body, budget);
  if (raw.length === 0) return [FIRST_MARKER + '\n'];
  const fenced = repairSplitCodeFences(raw);

  const total = fenced.length;
  return fenced.map((chunk, i) => {
    const marker = i === 0 ? FIRST_MARKER : contMarker(i + 1, total);
    return `${marker}\n${chunk}`;
  });
}
