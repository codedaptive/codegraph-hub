/**
 * One token of a Python path expression: what pythonPathTokens produces and
 * pythonPathExpression parses. A type alone, shared by both, so it lives in neither.
 */

export interface PathToken {
  kind: 'string' | 'name' | 'number' | 'punct';
  text: string;
}
