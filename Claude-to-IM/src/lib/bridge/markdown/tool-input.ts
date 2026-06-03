/**
 * Format a tool's input into a short, human-readable summary for permission cards.
 *
 * Permission prompts previously dumped raw `JSON.stringify(toolInput)` into the
 * card body, which is noisy and unfriendly. This helper shows only the key
 * piece of information per tool (the command, the file path, etc.) and falls
 * back to truncated JSON for unknown tools.
 *
 * Returns a plain-text string (no markup) — callers escape / wrap as needed.
 */
export function formatToolInput(toolName: string, toolInput: Record<string, unknown>): string {
  const str = (key: string): string | undefined => {
    const v = toolInput[key];
    return typeof v === 'string' ? v : undefined;
  };

  // MCP tools: mcp__<server>__<tool>
  if (toolName.startsWith('mcp__')) {
    const rest = toolName.slice('mcp__'.length);
    const sep = rest.indexOf('__');
    const server = sep >= 0 ? rest.slice(0, sep) : rest;
    const tool = sep >= 0 ? rest.slice(sep + 2) : '';
    return tool ? `${server} / ${tool}` : server;
  }

  switch (toolName) {
    case 'Bash':
    case 'BashOutput': {
      const cmd = str('command');
      return cmd ? `$ ${cmd}` : fallbackJson(toolInput);
    }
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'NotebookEdit': {
      const p = str('file_path') || str('notebook_path') || str('path');
      return p || fallbackJson(toolInput);
    }
    case 'Glob': {
      const pattern = str('pattern');
      const inPath = str('path');
      if (pattern) return inPath ? `${pattern}  (in ${inPath})` : pattern;
      return fallbackJson(toolInput);
    }
    case 'Grep': {
      const pattern = str('pattern');
      const inPath = str('path');
      if (pattern) return inPath ? `/${pattern}/  (in ${inPath})` : `/${pattern}/`;
      return fallbackJson(toolInput);
    }
    case 'WebFetch': {
      const url = str('url');
      return url || fallbackJson(toolInput);
    }
    case 'WebSearch': {
      const query = str('query');
      return query ? `"${query}"` : fallbackJson(toolInput);
    }
    default:
      return fallbackJson(toolInput);
  }
}

/**
 * Truncated pretty JSON, used when a tool has no dedicated formatter.
 */
function fallbackJson(toolInput: Record<string, unknown>): string {
  const inputStr = JSON.stringify(toolInput, null, 2);
  return inputStr.length > 300 ? inputStr.slice(0, 300) + '...' : inputStr;
}
