/**
 * The tool names an OpenCode client's rewrite touches (#1267): see
 * `./opencode-tool-names`.
 */
import { tools } from './tools';
import { extensionTools } from '../extensions/host/registry';

/**
 * Every tool name the server may list: the built-ins, then each served
 * extension tool. Read on each call, never at module load, because an
 * extension may register after this module loads.
 */
export function openCodeRewrittenToolNames(): readonly string[] {
  return [...tools, ...extensionTools().map((tool) => tool.definition)].map((tool) => tool.name);
}
