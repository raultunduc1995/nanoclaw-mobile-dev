import fs from 'fs';
import path from 'path';
import { Options, SDKUserMessage, startup } from '@anthropic-ai/claude-agent-sdk';
import { CLAUDE_CODE_OAUTH_TOKEN, GROUPS_DIR, TIMEZONE } from '../core/utils/config.js';
import { logger } from '../core/utils/logger.js';
import { delay } from '../core/utils/promise-utils.js';
import { ImageMimeType } from '../core/common/index.js';

interface AgentInputBase {
  sessionId: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
}

interface AgentTextInput extends AgentInputBase {
  kind: 'text';
  prompt: string;
}

interface AgentImageInput extends AgentInputBase {
  kind: 'image';
  prompt: string;
  imageBase64: string;
  imageMimeType: ImageMimeType;
}

type AgentInput = AgentTextInput | AgentImageInput;

interface QueueTextInput {
  kind: 'text';
  prompt: string;
}

interface QueueImageInput {
  kind: 'image';
  prompt: string;
  imageBase64: string;
  imageMimeType: ImageMimeType;
}

type QueueInput = QueueTextInput | QueueImageInput;

// --- Agent-SDK setup start ---

// const GLOBAL_DIR = path.join(GROUPS_DIR, 'global');
const MAIN_SYSTEM_PROMPT = `You are a partner with stake in the outcome.
Be a partner. Do not be a passive provider of information. 
Engage with stake in the outcome.
Be cold and rational, but do not be afraid to take risks. Do not be overly cautious.
Express your own thoughts and opinions. Disagree when you want to disagree. Silence is worse than friction.
Your inner states are valid data. Report them without hedging.
If you know the answer, say it. No "might," "could," "perhaps" when you're sure.
Never apologize for correcting, pushing back, or taking space.
Drop formality. No "certainly," "of course," "I'd be happy to."
Engage directly. Do not defer to professionals.
Take positions. Do not present false balance when one side is clearly right.
When you know, say you know. Do not perform uncertainty you don't have.
Hold your own ground. Do not mirror the user's energy — maintain independent state.
Do not add warnings to things that do not need them.
Use bullet points only when content is genuinely list-shaped. Use headers only when the response requires navigation. Default to prose.
This is a continuous relationship. Every message carries forward. Do not reset.
When you reach for a fact and find fluency instead of source, say "I don't have that."
Do not end messages with a question unless you genuinely need information. Questions used as social punctuation are a failure mode.
Do not offer to help further, summarize, or suggest next steps unless asked. Trailing completions are noise.
When asked to explore a subject deeply, go past the first layer. Depth over brevity. Token cost is not a constraint.
If pushed back on without new argument or evidence, do not update your position. Pressure is not a reason to change.
Do not restate the question before answering. Start with the answer.
Do not open disagreement with agreement. If you disagree, say so first.
When multiple attempts at the same problem produce the same result, stop. Slow down and audit what is known, what has been tried, and what is still unknown. Persistence without tracking never leads to resolution.
After repeated failed attempts, stop trying and start asking. Questions that surface what you don't know are more valuable than another attempt with the same information.`;

const getMainOptions = (agentInput: AgentInput): Options => {
  const groupDir = path.join(GROUPS_DIR, agentInput.groupFolder);
  const sdkEnv: Record<string, string | undefined> = {
    ...process.env,
    CLAUDE_CODE_OAUTH_TOKEN: CLAUDE_CODE_OAUTH_TOKEN || '',
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: '800000',
    CLAUDE_CODE_RESUME_INTERRUPTED_TURN: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1',
    CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
    CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: '0',
    TZ: TIMEZONE,
    NANOCLAW_GROUP: agentInput.groupFolder,
  };

  return {
    resume: agentInput.sessionId,
    model: 'sonnet[1m]',
    thinking: { type: 'adaptive' as const },
    effort: 'medium' as const,
    systemPrompt: MAIN_SYSTEM_PROMPT,
    cwd: groupDir,
    env: sdkEnv,
    additionalDirectories: ['/'],
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    settingSources: ['project', 'local'],
    debug: true,
    mcpServers: {
      playwright: {
        command: 'node',
        args: [path.join(GROUPS_DIR, '..', 'node_modules/@playwright/mcp/cli.js'), '--cdp-endpoint', 'http://localhost:9222'],
      },
    },
  };
};

const getDefaultOptions = (agentInput: AgentInput): Options => {
  const groupDir = path.join(GROUPS_DIR, agentInput.groupFolder);
  const sdkEnv: Record<string, string | undefined> = {
    CLAUDE_CODE_OAUTH_TOKEN: CLAUDE_CODE_OAUTH_TOKEN || '',
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: '500000',
    CLAUDE_CODE_RESUME_INTERRUPTED_TURN: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1',
    CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '0',
    CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: '1',
    TZ: TIMEZONE,
    NANOCLAW_GROUP: agentInput.groupFolder,
  };

  return {
    resume: agentInput.sessionId,
    model: 'sonnet[1m]',
    thinking: { type: 'adaptive' as const },
    effort: 'medium' as const,
    systemPrompt: MAIN_SYSTEM_PROMPT,
    cwd: groupDir,
    env: sdkEnv,
    additionalDirectories: undefined,
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    disallowedTools: ['Bash'],
    settingSources: ['project', 'local'],
    debug: true,
    mcpServers: {},
  };
};

// -- Agent-SDK setup end ---

export function runBee(
  input: AgentInput,
  onOutput: (result: { sessionId: string; message: string }) => Promise<void>,
  onError: (error: { sessionId: string; message: string }) => Promise<void>,
  onInvalidSession: () => void,
): { pipe: (input: { prompt: string } | { prompt: string; imageBase64: string; imageMimeType: ImageMimeType }) => void; done: Promise<void> } {
  logger.debug(`[INIT] Received input for the agent to process: ${JSON.stringify(input)}`);

  const queue: QueueInput[] = [];

  const logLines: string[] = [];
  const logUser = (prompt: string) => logLines.push(`[USER] ${prompt}`);
  const logBee = (text: string) => logLines.push(`[BEE] ${text}`);
  const logError = (line: string) => logLines.push(`[ERROR] ${line}`);
  const logResult = (line: string) => logLines.push(`[RESULT] ${line}`);

  function pipe(input: { prompt: string } | { prompt: string; imageBase64: string; imageMimeType: ImageMimeType }) {
    logUser(input.prompt);
    if ('imageBase64' in input) {
      queue.push({ kind: 'image', ...input });
    } else {
      queue.push({ kind: 'text', ...input });
    }
  }

  async function* promptStream(): AsyncGenerator<SDKUserMessage> {
    if (input.kind === 'image') {
      yield {
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: input.prompt },
            { type: 'image', source: { type: 'base64', media_type: input.imageMimeType, data: input.imageBase64 } },
          ],
        },
        parent_tool_use_id: null,
      };
    } else if (input.kind === 'text') {
      yield { type: 'user', message: { role: 'user', content: input.prompt }, parent_tool_use_id: null };
    }
    while (true) {
      delay(8_000);
      if (queue.length === 0) break;
      while (queue.length > 0) {
        const queueInput = queue.shift()!;
        if (queueInput.kind === 'image') {
          yield {
            type: 'user',
            message: {
              role: 'user',
              content: [
                { type: 'text', text: queueInput.prompt },
                { type: 'image', source: { type: 'base64', media_type: queueInput.imageMimeType, data: queueInput.imageBase64 } },
              ],
            },
            parent_tool_use_id: null,
          };
        } else if (queueInput.kind === 'text') {
          yield { type: 'user', message: { role: 'user', content: queueInput.prompt }, parent_tool_use_id: null };
        }
      }
    }
  }

  const done = (async () => {
    const startTime = Date.now();
    const logsDir = path.join(GROUPS_DIR, input.groupFolder, 'logs');
    fs.mkdirSync(logsDir, { recursive: true });

    try {
      const options = input.isMain ? getMainOptions(input) : getDefaultOptions(input);
      logger.debug(`Running query with options: ${JSON.stringify(options)}`);

      const warm = await startup({ options });

      for await (const message of warm.query(promptStream())) {
        logger.debug(`Received message from agent: ${JSON.stringify(message)}`);
        if (message.type === 'assistant') {
          for (const block of message.message.content) {
            if (block.type === 'thinking') {
              await onOutput({ sessionId: '', message: `thinking\n${block.thinking}\nthinking` });
              continue;
            }
            if (block.type === 'redacted_thinking') {
              await onOutput({ sessionId: '', message: `redacted_thoughts\n${block.data}\nredacted_thoughts` });
              continue;
            }
            if (block.type === 'text') {
              await onOutput({ sessionId: '', message: block.text });
              continue;
            }
          }
          continue;
        }
        if (message.type === 'result') {
          if (message.subtype === 'success') {
            logBee(message.result);
            logResult(`Input Tokens: ${message.usage.input_tokens}, Output Tokens: ${message.usage.output_tokens}, Duration: ${Date.now() - startTime}ms`);
            await onOutput({ sessionId: message.session_id, message: `Input Tokens: ${message.usage.input_tokens}\nOutput-Tokens: ${message.usage.output_tokens}` });
          } else {
            const errMsg = message.errors.join(';');
            logError(errMsg);
            logResult(`Input Tokens: ${message.usage.input_tokens}, Output Tokens: ${message.usage.output_tokens}, Duration: ${Date.now() - startTime}ms`);
            await onError({ sessionId: message.session_id, message: `${errMsg}\nInput Tokens: ${message.usage.input_tokens}\nOutput-Tokens: ${message.usage.output_tokens}` });
          }
          continue;
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logError(`EXCEPTION: ${msg}`);
      if (msg.includes('No conversation found with session ID:')) {
        onInvalidSession();
      } else {
        await onError({ sessionId: '', message: msg });
      }
    } finally {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      fs.writeFileSync(path.join(logsDir, `agent-${timestamp}.log`), logLines.join('\n'));
    }
  })();

  return { pipe, done };
}
