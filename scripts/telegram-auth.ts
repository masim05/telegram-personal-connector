import dotenv from "dotenv";
import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import input from "input";
import { TelegramClient } from "telegram";
import { Logger, LogLevel } from "telegram/extensions/Logger";
import { StringSession } from "telegram/sessions";

const usersDirectory = resolve(".users");
const envTemplate = `TELEGRAM_API_ID=\nTELEGRAM_API_HASH=\nTELEGRAM_PHONE=\n`;

type Account = {
  tag: string;
  directory: string;
  envPath: string;
  sessionPath: string;
  logPath: string;
};

function isValidTag(tag: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(tag);
}

async function chooseAccount(): Promise<Account> {
  await mkdir(usersDirectory, { recursive: true, mode: 0o700 });
  const entries = await readdir(usersDirectory, { withFileTypes: true });
  const tags = entries
    .filter((entry) => entry.isDirectory() && isValidTag(entry.name))
    .map((entry) => entry.name)
    .sort();

  let tag: string;
  if (tags.length) {
    const selected = await input.select("Select a Telegram account", [
      ...tags.map((existingTag) => ({ name: existingTag, value: existingTag })),
      { name: "+ New account", value: "__create_new_account__" },
    ]);
    tag =
      selected === "__create_new_account__"
        ? (await input.text("New account tag: ")).trim()
        : selected;
  } else {
    tag = (await input.text("New account tag: ")).trim();
  }

  if (!isValidTag(tag)) {
    throw new Error("Account tags may contain letters, numbers, hyphens, and underscores.");
  }

  const directory = resolve(usersDirectory, tag);
  const account = {
    tag,
    directory,
    envPath: resolve(directory, ".env"),
    sessionPath: resolve(directory, ".session"),
    logPath: resolve(directory, "auth.log"),
  };

  if (!existsSync(directory)) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(account.envPath, envTemplate, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return account;
  }

  if (!existsSync(account.envPath)) {
    await writeFile(account.envPath, envTemplate, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return account;
  }

  return account;
}

async function log(account: Account, message: string): Promise<void> {
  const line = `${new Date().toISOString()} ${message}\n`;
  // Keep diagnostics useful without writing account secrets or message content.
  await appendFile(account.logPath, line, { encoding: "utf8", mode: 0o600 });
  console.log(`[tg-auth] ${message}`);
}

function setEnvValue(content: string, name: string, value: string): string {
  const line = `${name}=${value}`;
  const matcher = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=.*$`, "m");
  if (matcher.test(content)) return content.replace(matcher, line);
  return `${content.trimEnd()}\n${line}\n`;
}

function partiallyMasked(value: string): string {
  if (value.length <= 4) return value;
  return `${value.slice(0, 2)}${"*".repeat(value.length - 4)}${value.slice(-2)}`;
}

async function partiallyMaskedInput(
  label: string,
  validate: (value: string) => true | string,
): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return input.password(label, { validate });
  }

  return new Promise((resolve, reject) => {
    let value = "";
    const stdin = process.stdin;
    const stdout = process.stdout;
    const wasRaw = stdin.isRaw;
    const prefix = `? ${label} `;

    const render = () => stdout.write(`\r\x1b[2K${prefix}${partiallyMasked(value)}`);
    const cleanup = () => {
      stdin.setRawMode(wasRaw ?? false);
      stdin.pause();
      stdin.off("data", onData);
    };
    const onData = (chunk: Buffer) => {
      for (const character of chunk.toString("utf8")) {
        if (character === "\u0003") {
          cleanup();
          reject(new Error("Authentication cancelled."));
          return;
        }
        if (character === "\r" || character === "\n") {
          const result = validate(value);
          if (result === true) {
            cleanup();
            stdout.write("\n");
            resolve(value);
            return;
          }
          value = "";
          stdout.write(`\n${result}\n`);
          render();
          continue;
        }
        if (character === "\b" || character === "\x7f") {
          value = value.slice(0, -1);
          render();
          continue;
        }
        if (character >= " ") {
          value += character;
          render();
        }
      }
    };

    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
    render();
  });
}

async function loadCredentials(account: Account) {
  const loaded = dotenv.config({ path: account.envPath, override: true });
  if (loaded.error) throw loaded.error;

  let apiIdValue = process.env.TELEGRAM_API_ID?.trim() ?? "";
  let apiHash = process.env.TELEGRAM_API_HASH?.trim() ?? "";
  let phoneNumber = process.env.TELEGRAM_PHONE?.trim() ?? "";
  let changed = false;

  if (!/^\d+$/.test(apiIdValue) || !Number.isSafeInteger(Number(apiIdValue)) || Number(apiIdValue) <= 0) {
    apiIdValue = await partiallyMaskedInput("Telegram API ID:", (value) =>
        /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0
          ? true
          : "Enter a positive numeric API ID.");
    changed = true;
  }
  if (!/^[0-9a-f]{32}$/i.test(apiHash)) {
    apiHash = await partiallyMaskedInput("Telegram API hash:", (value) =>
        /^[0-9a-f]{32}$/i.test(value) ? true : "Enter the 32-character hexadecimal API hash.",
    );
    changed = true;
  }
  if (!/^\+\d{7,15}$/.test(phoneNumber)) {
    phoneNumber = await input.text("Telegram phone number (E.164, e.g. +15551234567): ", {
      validate: (value) =>
        /^\+\d{7,15}$/.test(value) ? true : "Enter a phone number in E.164 format.",
    });
    changed = true;
  }

  if (changed) {
    const existing = await readFile(account.envPath, "utf8");
    const updated = setEnvValue(
      setEnvValue(setEnvValue(existing, "TELEGRAM_API_ID", apiIdValue), "TELEGRAM_API_HASH", apiHash),
      "TELEGRAM_PHONE",
      phoneNumber,
    );
    await writeFile(account.envPath, updated, { encoding: "utf8", mode: 0o600 });
    dotenv.config({ path: account.envPath, override: true });
  }

  return { apiId: Number(apiIdValue), apiHash, phoneNumber };
}

function createClient(session: string, apiId: number, apiHash: string): TelegramClient {
  const client = new TelegramClient(new StringSession(session), apiId, apiHash, {
    baseLogger: new Logger(LogLevel.NONE),
    connectionRetries: 5,
  });
  // This command authenticates and exits; it never consumes Telegram updates.
  (client as TelegramClient & { _loopStarted: boolean })._loopStarted = true;
  return client;
}

async function sessionWorks(client: TelegramClient, session: string): Promise<boolean> {
  if (!session.trim()) return false;
  try {
    await client.connect();
    await client.getMe();
    return true;
  } catch {
    return false;
  }
}

let client: TelegramClient | undefined;
let activeAccount: Account | undefined;
try {
  const account = await chooseAccount();
  activeAccount = account;
  await log(account, `Selected account '${account.tag}'.`);
  const { apiId, apiHash, phoneNumber } = await loadCredentials(account);
  await log(account, "Loaded account credentials from .env.");
  const savedSession = existsSync(account.sessionPath)
    ? await readFile(account.sessionPath, "utf8")
    : "";
  await log(account, savedSession.trim() ? "Found an existing session; validating it." : "No saved session found.");

  try {
    client = createClient(savedSession.trim(), apiId, apiHash);
  } catch {
    client = createClient("", apiId, apiHash);
  }

  if (await sessionWorks(client, savedSession)) {
    await log(account, "Existing session is valid.");
    console.log(`Existing session for ${account.tag} is valid.`);
  } else {
    await log(account, "Session is unavailable or invalid; starting interactive authorization.");
    await client.disconnect().catch(() => undefined);
    client = createClient("", apiId, apiHash);
    await log(account, "Requesting a fresh login code; it must be entered at the terminal prompt.");
    await client.start({
      phoneNumber,
      password: async () => input.password("Telegram 2FA password (if enabled): "),
      phoneCode: async () =>
        partiallyMaskedInput(
          "Telegram login code just sent to you:",
          (value) => (value.trim() ? true : "Enter the login code Telegram just sent."),
        ),
      onError: (error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error("Telegram authorization error:", message);
        void log(account, `Authorization callback reported: ${message}`).catch(() => undefined);
        return true;
      },
    });
    await writeFile(account.sessionPath, client.session.save(), { encoding: "utf8", mode: 0o600 });
    await log(account, "Authorization succeeded; saved a new session.");
    console.log(`Authenticated session saved to .users/${account.tag}/.session`);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Telegram authentication failed: ${message}`);
  if (activeAccount) await log(activeAccount, `Authorization failed: ${message}`).catch(() => undefined);
  process.exitCode = 1;
} finally {
  await client?.destroy().catch(() => undefined);
}
