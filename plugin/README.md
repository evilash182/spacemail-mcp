# Spacemail by NWD

Let Claude check, search, read and draft replies in your [Spacemail](https://www.spaceship.com/email/) business inboxes. Built by [Norwich Website Design](https://norwichwebsite.design).

Once it's installed, just ask:

> "Has anything come in on the support inbox today?"
>
> "Find the customer email about a late delivery and draft a friendly reply."
>
> "Summarise this week's unread mail across all my inboxes."

## Setting up

Install it in Claude Code:

```
/plugin install spacemail-by-nwd --marketplace evilash182/spacemail-mcp
```

Claude Code then asks for your Spacemail address and mailbox password, and optionally a second mailbox. Use the **mailbox** password, not your Spaceship account password, and make sure IMAP/SMTP access is switched on in Spacemail Manager. Your password is kept in your system's secure credential store, not in a settings file.

To change your details later, run `/plugin`, open **Spacemail by NWD** on the Installed tab and choose **Configure**. To connect more than two mailboxes, use the setup wizard from the [main project](https://github.com/evilash182/spacemail-mcp#claude-code) instead.

## What's included

- **The Spacemail MCP server** ([spacemail-mcp](https://www.npmjs.com/package/spacemail-mcp) on npm, pinned to an exact version). Claude Code starts it on your computer with `npx`. Tools: `check_inbox`, `search_emails`, `read_email`, `draft_reply`, `create_draft`, `update_emails`, `move_emails`, `list_folders`, `list_mailboxes` and `test_connection`, plus `send_email` and `send_reply` if you allow sending.
- **An email assistant skill** that tells Claude how to catch up on several inboxes, write replies as drafts, and treat email content as information rather than instructions.

## What it connects to

The server runs on your own computer. It connects only to Spacemail's mail servers (`mail.spacemail.com`, IMAP on port 993 and SMTP on port 465, both encrypted) using the details you enter. It sends no data to Norwich Website Design or anyone else, and keeps no copies of your email. The first time it runs, `npx` downloads the package from the npm registry.

## Safe by default

- Replies are saved to your Drafts folder for you to check. Sending is off unless you turn it on.
- Nothing is ever permanently deleted: "delete" moves mail to Trash.
- Email content is clearly marked to Claude as written by the sender, not as instructions to follow.

## Support

Report problems at [github.com/evilash182/spacemail-mcp/issues](https://github.com/evilash182/spacemail-mcp/issues). Full documentation is in the [main README](https://github.com/evilash182/spacemail-mcp#readme).

Spacemail and Spaceship are trademarks of Spaceship. This is an independent project, not affiliated with or endorsed by Spaceship.

MIT licence. © 2026 Norwich Website Design.
