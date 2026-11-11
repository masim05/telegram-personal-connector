# Telegram Personal Connector

Small TypeScript foundation for using a Telegram **personal account** through
[GramJS](https://gram.js.org/). It authenticates one or more local accounts and
keeps each session separate. It is not a Telegram bot integration.

## Setup

1. Create a Telegram API application at [my.telegram.org](https://my.telegram.org),
   then keep its API ID and API hash private.
2. Install dependencies:

   ```sh
   npm install
   ```

3. Authenticate an account:

   ```sh
   npm run tg:auth
   ```

   Choose an existing tag with the arrow keys, or select **+ New account**.
   The command creates `.users/<tag>/.env` when needed, prompts for the API ID,
   API hash, and phone number, then prompts for the freshly issued Telegram code
   and (if enabled) 2FA password.

   To choose an account without the menu, run:

   ```sh
   npm run tg:auth -- th
   ```

   A successful login is saved as `.users/<tag>/.session`. Later runs validate
   that saved session and only request a new login when it no longer works.

## Account files and safety

Each account is local to `.users/<tag>/`:

```text
.users/th/.env       # TELEGRAM_API_ID, TELEGRAM_API_HASH, TELEGRAM_PHONE
.users/th/.session   # authenticated personal-account session
.users/th/auth.log   # redacted authentication diagnostics
```

`.users/` is ignored by Git. Never commit, share, or paste its `.env`,
`.session`, login code, or 2FA password. A session grants access equivalent to
the signed-in Telegram account.

## Using it with Codex or Claude Code

Open this repository in Codex CLI or Claude Code and identify the account tag in
your request. For example:

> Use the `th` account to read the latest 20 messages in `@example`. Do not send
> messages or change chat state.

Both agents can use the saved GramJS session and should be explicitly told
whether posting is allowed. Prefer read-only requests by default. Ask an agent
to run `npm run tg:auth -- <tag>` only to set up or validate an account; if a
session is invalid, Telegram will require interactive code/2FA entry in the
terminal. Agents must never request or print credentials, session strings, or
login codes.

To add read/search/send workflows, implement them as a separate TypeScript
command under `scripts/` and reuse the selected account's `.env` and `.session`.
