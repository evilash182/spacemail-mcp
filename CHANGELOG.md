# Changelog

## 1.0.1 (2026-11-02)

- Listed in the official MCP Registry as `design.norwichwebsite/spacemail`.
- New Claude Code plugin, **Spacemail by NWD**: `/plugin install spacemail-by-nwd --marketplace evilash182/spacemail-mcp`. It asks for up to two mailboxes in a form, stores passwords in Claude Code's secure storage, and adds an email assistant skill.

## 1.0.0 (2026-11-02)

First public release.

- Connect one or more Spacemail (Spaceship) mailboxes to Claude and other MCP apps.
- Tools: `check_inbox`, `search_emails`, `read_email`, `draft_reply`, `create_draft`, `update_emails`, `move_emails`, `list_folders`, `list_mailboxes`, `test_connection`, plus `send_email` and `send_reply` when sending is switched on.
- Safe by default: replies are saved as drafts, sending is opt-in, nothing is ever permanently deleted, and email content is labelled as untrusted for Claude.
- One-click Claude Desktop extension (`spacemail.mcpb`) with a settings form for up to three mailboxes; passwords are stored in the system keychain.
- `npx -y spacemail-mcp setup`: a guided setup for Claude Code that tests each login, offers "add another mailbox?" and stores passwords in the macOS Keychain.
- `npx -y spacemail-mcp check` to test saved mailboxes from the terminal.
- `SPACEMAIL_PASSWORD_COMMAND` to read passwords from a keychain or password manager instead of a config file.
