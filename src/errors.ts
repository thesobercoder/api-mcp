/** Invalid API configuration; raised at startup. */
export class ConfigError extends Error {}
/** A tool call failed; the message is safe to return to the MCP client. */
export class CallError extends Error {}
