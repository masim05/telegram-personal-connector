import dotenv from "dotenv";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
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

  if (tags.length) console.log(`Available accounts: ${tags.join(", ")}`);
  const tag = (await input.text("Choose an account tag, or enter a new one: ")).trim();
  if (!isValidTag(tag)) {
    throw new Error("Account tags may contain letters, numbers, hyphens, and underscores.");
  }

  const directory = resolve(usersDirectory, tag);
  const account = {
    tag,
    directory,
    envPath: resolve(directory, ".env"),
    sessionPath: resolve(directory, ".session"),
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
try {
  const account = await chooseAccount();
  const { apiId, apiHash } = loadCredentials(account.envPath);
  const savedSession = existsSync(account.sessionPath)
    ? await readFile(account.sessionPath, "utf8")
    : "";

  try {
    client = createClient(savedSession.trim(), apiId, apiHash);
  } catch {
    client = createClient("", apiId, apiHash);
  }

  if (await sessionWorks(client, savedSession)) {
    console.log(`Existing session for ${account.tag} is valid.`);
  } else {
    await client.disconnect().catch(() => undefined);
    client = createClient("", apiId, apiHash);
    await client.start({
      phoneNumber: async () =>
        process.env.TELEGRAM_PHONE ??
        input.text("Telegram phone number (E.164, e.g. +15551234567): "),
      password: async () => input.password("Telegram 2FA password (if enabled): "),
      phoneCode: async () => input.text("Telegram login code: "),
      onError: (error) => console.error("Telegram authorization error:", error.message),
    });
    await writeFile(account.sessionPath, client.session.save(), { encoding: "utf8", mode: 0o600 });
    console.log(`Authenticated session saved to .users/${account.tag}/.session`);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Telegram authentication failed: ${message}`);
  process.exitCode = 1;
} finally {
  await client?.disconnect().catch(() => undefined);
}
