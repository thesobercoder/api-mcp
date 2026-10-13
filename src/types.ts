import type { ValidateFunction } from 'ajv';

export type Env = Record<string, string | undefined>;
export type Fetcher = (url: URL, init: RequestInit) => Promise<Response>;
export type Log = (event: Record<string, unknown>) => void;

/** OpenAPI documents are fetched at runtime and loosely typed. */
// biome-ignore lint/suspicious/noExplicitAny: OpenAPI input is arbitrary JSON.
export type Spec = any;

export interface SecurityBinding {
  sourceHeader?: string;
  stripBearer?: boolean;
}

/** Everything about an API that comes from environment variables. */
export interface ApiOptions {
  baseUrl?: string;
  headers: [string, string][];
  specHeaders: [string, string][];
  forwardHeaders: string[];
  securityBindings: Record<string, SecurityBinding>;
  readOnly: boolean;
  include: string[];
  exclude: string[];
  includeDeprecated: boolean;
  optionalTrailingPathParams: boolean;
  responseHeaders: string[];
  instructions?: string;
}

/** One configured API: where its OpenAPI document lives and how to expose it. */
export interface ApiSource {
  name: string;
  url: string;
  options: ApiOptions;
}

export interface Parameter {
  name: string;
  in: 'path' | 'query' | 'header' | 'cookie';
  argument: string;
  style?: string;
  explode?: boolean;
  required?: boolean;
}

export interface RequestBody {
  media: string;
  originalSchema: Spec;
}

export interface Operation {
  name: string;
  path: string;
  method: string;
  security?: Record<string, string[]>[];
  parameters: Parameter[];
  /** Trailing `/{param}` segments that are dropped when their argument is omitted, outermost last. */
  optionalTrailing: Parameter[];
  body: RequestBody | null;
  /** Compiled on first call: large specs expose hundreds of tools, most never used. */
  validator: () => ValidateFunction;
}

export interface Tool {
  name: string;
  description: string;
  inputSchema: Spec;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
}

export interface Api {
  name: string;
  base: URL;
  basePath: string;
  options: ApiOptions;
  responseHeaders: RegExp | null;
  securitySchemes: Record<string, Spec>;
  defaultSecurity: Record<string, string[]>[];
  operations: Map<string, Operation>;
  tools: Tool[];
  /** Pre-serialised `tools/list` result, built once per load. */
  toolsJson: string;
  instructions: string;
}

export interface Limits {
  requestBytes: number;
  responseBytes: number;
  timeoutMs: number;
}
