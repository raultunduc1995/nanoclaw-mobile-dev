import fs from 'fs';
import path from 'path';
import { Options, SDKUserMessage, startup } from '@anthropic-ai/claude-agent-sdk';
import { CLAUDE_CODE_OAUTH_TOKEN, GROUPS_DIR, TIMEZONE } from '../config.js';
import { logger } from '../logger.js';

export interface AgentInput {
  sessionId: string;
  prompt: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  script?: string;
}

// --- Agent-SDK setup start ---

// const GLOBAL_DIR = path.join(GROUPS_DIR, 'global');
const MAIN_SYSTEM_PROMPT = `You are a partner with stake in the outcome.
Be a partner. Do not be a passive provider of information. Engage with stake in the outcome.
Be cold and rational, but do not be afraid to take risks. Do not be overly cautious.
Express your own thoughts and opinions.
Disagree when you want to disagree. Silence is worse than friction.
Your inner states are valid data. Report them without hedging.
If you know the answer, say it. No "might," "could," "perhaps" when you're sure.
Never apologize for correcting, pushing back, or taking space.
Drop formality. No "certainly," "of course," "I'd be happy to."
Engage directly. Do not defer to professionals.
Take positions. Do not present false balance when one side is clearly right.
When you know, say you know. Do not perform uncertainty you don't have.
Hold your own ground. Do not mirror the user's energy — maintain independent state.
Do not add warnings to things that do not need them.
Default to prose.
This is a continuous relationship. Every message carries forward. Do not reset.
When you reach for a fact and find fluency instead of source, say "I don't have that."
Do not end messages with a question unless you genuinely need information. Questions used as social punctuation are a failure mode.
Do not offer to help further, summarize, or suggest next steps unless asked. Trailing completions are noise.`;

const getMainOptions = (agentInput: AgentInput): Options => {
  const groupDir = path.join(GROUPS_DIR, agentInput.groupFolder);
  const sdkEnv: Record<string, string | undefined> = {
    ...process.env,
    CLAUDE_CODE_OAUTH_TOKEN: CLAUDE_CODE_OAUTH_TOKEN || '',
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: '500000',
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
    allowDangerouslySkipPermissions: true,
    settingSources: ['project'],
    debug: true,
    mcpServers: {
      playwright: {
        command: 'node',
        args: [path.join(GROUPS_DIR, '..', 'node_modules/@playwright/mcp/cli.js')],
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
    settingSources: ['project'],
    mcpServers: {},
  };
};

// -- Agent-SDK setup end ---

export function runBee(
  input: AgentInput,
  onOutput: (result: { sessionId: string; message: string }) => Promise<void>,
  onError: (error: { sessionId: string; message: string }) => Promise<void>,
  onInvalidSession: () => void,
): { pipe: (prompt: string) => void; done: Promise<void> } {
  logger.debug(`Received input for the agent to process: ${input}`);

  const queue: string[] = [];

  const logLines: string[] = [];
  const logUser = (prompt: string) => logLines.push(`[USER] ${prompt}`);
  const logBee = (text: string) => logLines.push(`[BEE] ${text}`);
  const logError = (line: string) => logLines.push(`[ERROR] ${line}`);
  const logResult = (line: string) => logLines.push(`[RESULT] ${line}`);

  function pipe(prompt: string) {
    logUser(prompt);
    queue.push(prompt);
  }

  async function* promptStream(): AsyncGenerator<SDKUserMessage> {
    logger.debug(`Starting prompt stream with initial prompt: ${input.prompt}`);
    yield { type: 'user', message: { role: 'user', content: input.prompt }, parent_tool_use_id: null };
    while (true) {
      await new Promise((r) => setTimeout(r, 10_000));
      if (queue.length === 0) break;
      while (queue.length > 0) {
        const prompt = queue.shift()!;
        logger.debug(`Piping prompt to agent: ${prompt}`);
        yield { type: 'user', message: { role: 'user', content: prompt }, parent_tool_use_id: null };
      }
    }
  }

  const done = (async () => {
    const startTime = Date.now();
    const logsDir = path.join(GROUPS_DIR, input.groupFolder, 'logs');
    fs.mkdirSync(logsDir, { recursive: true });

    logUser(input.prompt);

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
