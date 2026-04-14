import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR, TIMEZONE } from '../../config.js';
import { readEnvFile } from '../../env.js';
import { logger } from '../../logger.js';

export interface AgentInput {
  prompt: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  script?: string;
}

export interface AgentOutput {
  status: 'success' | 'error';
  result: string | null;
  error?: string;
}

const BEE_ENTRY = path.resolve(process.cwd(), 'src/bee/index.ts');
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function resolveAgentEntry(): [string, string[]] {
  return ['node', ['--import', 'tsx/esm', BEE_ENTRY]];
}

function buildEnv(groupFolder: string): NodeJS.ProcessEnv {
  const envCreds = readEnvFile(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']);
  return {
    ...process.env,
    TZ: TIMEZONE,
    NANOCLAW_GROUP: groupFolder,
    CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN || envCreds.CLAUDE_CODE_OAUTH_TOKEN || '',
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || envCreds.ANTHROPIC_API_KEY || '',
  };
}

export async function runAgent(
  input: AgentInput,
  onProcess: (proc: ChildProcess, name: string) => void,
  onOutput: (text: string) => Promise<void>,
): Promise<AgentOutput> {
  const startTime = Date.now();
  const processName = `nanoclaw-${input.groupFolder}-${Date.now()}`;
  const [cmd, args] = resolveAgentEntry();
  const env = buildEnv(input.groupFolder);

  logger.info({ group: input.groupFolder, processName, cmd }, 'Spawning agent process');

  const logsDir = path.join(GROUPS_DIR, input.groupFolder, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], env });

    onProcess(proc, processName);

    let stdout = '';
    let stderr = '';
    let parseBuffer = '';

    proc.stdin.write(JSON.stringify(input));
    proc.stdin.end();

    proc.stdout.on('data', async (data) => {
      const chunk = data.toString();
      stdout += chunk;
      for (const line of chunk.trim().split('\n')) {
        if (line) logger.debug({ group: input.groupFolder }, line);
      }

      parseBuffer += chunk;
      let startIdx: number;
      while ((startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
        const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
        if (endIdx === -1) break;

        const jsonStr = parseBuffer.slice(startIdx + OUTPUT_START_MARKER.length, endIdx).trim();
        parseBuffer = parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);

        try {
          const parsed: AgentOutput = JSON.parse(jsonStr);
          if (parsed.result) {
            const raw = typeof parsed.result === 'string' ? parsed.result : JSON.stringify(parsed.result);
            const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
            if (text) {
              logger.info({ group: input.groupFolder }, `Agent output: ${raw.length} chars`);
              await onOutput(text);
            }
          } else {
            logger.debug({ group: input.groupFolder, status: parsed.status, error: parsed.error }, 'Agent output chunk with no result');
          }
        } catch (err) {
          logger.warn({ group: input.groupFolder, err }, 'Failed to parse agent output chunk');
        }
      }
    });

    proc.stderr.on('data', (data) => {
      const chunk = data.toString();
      for (const line of chunk.trim().split('\n')) {
        if (line) logger.debug({ group: input.groupFolder }, line);
      }
      stderr += chunk;
    });

    proc.on('error', (err) => {
      logger.error({ group: input.groupFolder, processName, err }, 'Agent process spawn error');
      resolve({ status: 'error', result: null, error: `Spawn error: ${err.message}` });
    });

    proc.on('close', (code) => {
      const duration = Date.now() - startTime;
      const isError = code !== 0;

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `agent-${timestamp}.log`);
      const logLines = [
        `=== Agent Run Log ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${input.groupFolder}`,
        `Duration: ${duration}ms`,
        `Exit Code: ${code}`,
        ``,
        `=== Stderr ===`, stderr,
        ``,
        `=== Stdout ===`, stdout,
      ];
      fs.writeFileSync(logFile, logLines.join('\n'));

      if (isError) {
        logger.error({ group: input.groupFolder, code, duration, logFile }, 'Agent process exited with error');
        resolve({ status: 'error', result: null, error: `Process exited with code ${code}: ${stderr.slice(-200)}` });
        return;
      }

      logger.info({ group: input.groupFolder, duration }, 'Agent process completed');
      resolve({ status: 'success', result: null });
    });
  });
}
