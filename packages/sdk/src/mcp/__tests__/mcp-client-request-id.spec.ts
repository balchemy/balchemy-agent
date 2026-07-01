import * as fs from 'fs';
import * as path from 'path';

describe('MCP Client JSON-RPC request ID', () => {
  const CLIENT_PATH = path.resolve(__dirname, '../mcp-client.ts');
  let source: string;
  beforeAll(() => { source = fs.readFileSync(CLIENT_PATH, 'utf-8'); });

  it('should NOT use Date.now() as request ID', () => {
    const jsonRpcBlock = source.match(/JSON\.stringify\(\{[\s\S]*?jsonrpc[\s\S]*?\}\)/);
    expect(jsonRpcBlock).toBeTruthy();
    expect(jsonRpcBlock![0]).not.toMatch(/id:\s*Date\.now\(\)/);
  });

  it('should use crypto.randomUUID() as request ID', () => {
    const jsonRpcBlock = source.match(/JSON\.stringify\(\{[\s\S]*?jsonrpc[\s\S]*?\}\)/);
    expect(jsonRpcBlock).toBeTruthy();
    expect(jsonRpcBlock![0]).toMatch(/crypto\.randomUUID\(\)/);
  });
});
