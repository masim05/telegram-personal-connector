import dotenv from "dotenv";
import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import input from "input";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";

const usersDirectory = resolve(".users");
const envTemplate = `TELEGRAM_API_ID=\nTELEGRAM_API_HASH=\n# Optional: omit to enter the number interactively.\nTELEGRAM_PHONE=\n`;

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
    throw new Error(`Created .users/${tag}/.env. Add its Telegram credentials and run again.`);
  }

  if (!existsSync(account.envPath)) {
    await writeFile(account.envPath, envTemplate, { encoding: "utf8", mode: 0o600, flag: "wx" });
    throw new Error(`Created .users/${tag}/.env. Add its Telegram credentials and run again.`);
  }

  return account;
}

async function log(account: Account, message: string): Promise<void> {
  const line = `${new Date().toISOString()} ${message}\n`;
  // Keep diagnostics useful without writing account secrets or message content.
  await appendFile(account.logPath, line, { encoding: "utf8", mode: 0o600 });
  console.log(`[tg-auth] ${message}`);
}

function loadCredentials(envPath: string) {
  const loaded = dotenv.config({ path: envPath, override: true });
  if (loaded.error) throw loaded.error;

  const apiId = Number(process.env.TELEGRAM_API_ID);
  const apiHash = process.env.TELEGRAM_API_HASH;
  if (!Number.isSafeInteger(apiId) || apiId <= 0) {
    throw new Error("TELEGRAM_API_ID must be a positive integer.");
  }
  if (!/^[0-9a-f]{32}$/i.test(apiHash ?? "")) {
    throw new Error("TELEGRAM_API_HASH must be a 32-character hexadecimal string.");
  }

  return { apiId, apiHash };
}

function createClient(session: string, apiId: number, apiHash: string): TelegramClient {
  return new TelegramClient(new StringSession(session), apiId, apiHash, {
    connectionRetries: 5,
  });
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
  const { apiId, apiHash } = loadCredentials(account.envPath);
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
    const phoneNumber =
      process.env.TELEGRAM_PHONE?.trim() ??
      (await input.text("Telegram phone number (E.164, e.g. +15551234567): "));
    const usesStoredCode = Boolean(process.env.TELEGRAM_LOGIN_CODE?.trim());
    await log(
      account,
      `Requesting a fresh login code; authorization code source: ${usesStoredCode ? ".env" : "terminal prompt"}.`,
    );
    await client.start({
      phoneNumber,
      password: async () => input.password("Telegram 2FA password (if enabled): "),
      phoneCode: async () =>
        process.env.TELEGRAM_LOGIN_CODE?.trim() ?? input.text("Telegram login code: "),
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
  await client?.disconnect().catch(() => undefined);
}
