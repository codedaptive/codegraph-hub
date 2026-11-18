import * as path from 'node:path';
import { JobSupervisor } from '../../../../src/extensions/host/builder/job-supervisor';
import { NODE_RUNTIME_FLAGS, WASM_RUNTIME_FLAGS } from '../../../../src/extraction/wasm-runtime-flags';

export function testJobSupervisor(): JobSupervisor {
  return new JobSupervisor({
    entry: path.resolve(__dirname, '../../../../src/extensions/host/builder/job-child-main.ts'),
    execArgv: [...WASM_RUNTIME_FLAGS, ...NODE_RUNTIME_FLAGS, '--require', path.resolve(__dirname, 'ts-require-hook.cjs')],
  });
}
