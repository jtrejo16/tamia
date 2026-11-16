# WhatsApp Business Tools MCP


For developers building on the WhatsApp Business Platform (Cloud API) — the WhatsApp Business Tools MCP server lets your AI agent and IDE assistant manage and debug your WhatsApp Business integration from one place. It enables an agent to discover the businesses and WhatsApp accounts you administer, onboard and register phone numbers, create and manage message templates, configure webhooks, and send messages — acting as you, on the apps and businesses you administer.

*Note:* *Note:* The interface and tool set of the WhatsApp Business Tools MCP server are in beta and may change.

## Overview

The following table summarizes the server details:

| Attribute | Value |
|---|---|
| Server name | WhatsApp Business Tools |
| Transport | Streamable HTTP |
| Endpoint | https://mcp.facebook.com/whatsapp_business_tools |
| Authentication | Meta developer account sign-in (OAuth) |
| Client ID | Not required. The server recognizes supported clients automatically. |
| Redirect URI | Not required. You don't create or configure a Meta app for this server. |
| Supported clients | Claude Code, Claude Desktop, ChatGPT, Codex CLI, Codex app |
| Status | Beta - interface and tool set may change |

## Before you begin

To connect a client, you need one of the supported clients listed above, on a current version.

The server is rolling out gradually, so it may not be available to your account yet, even after your client connects.

The server acts on your own assets, so before an agent can use most tools you also need:

- *Admin access to a business* you want to manage (the MANAGE role).
- *A WhatsApp-enabled app that you're an admin of*, connected to that business — an app with the WhatsApp Business Messaging use case (or the WhatsApp product on an older app). You must have admin access on the app, not only on the business.
- *Accepted WhatsApp Business Cloud API Terms of Service* for that business. Messaging and phone-number registration are blocked until an admin accepts them.

If any prerequisite is missing, the tool returns an actionable error that tells you what to fix and links to the page where you can fix it.

## Connect your client

To connect a supported client and complete OAuth authorization, follow [Connect an MCP client to Meta](https://developers.facebook.com/documentation/mcp/connect-an-mcp-client). Use the server name and endpoint from the [Overview](#overview). This server doesn't require a client ID, so use [automatic registration](https://developers.facebook.com/documentation/mcp/connect-an-mcp-client#automatic-registration).

## Scopes

The server requests the following permissions during consent:

| Scope | Access |
|---|---|
| business_management | Discover and act on the businesses you administer that you selected during consent. |
| whatsapp_business_management | Manage WhatsApp Business accounts, phone numbers, message templates, and webhooks. |
| whatsapp_business_messaging | Send messages from your registered phone numbers. |

You can review these permissions, and revoke access, on Facebook under *Settings* > *Your Activity* > *Business Integrations*.

## Verify your connection

Ask the agent to list the tools it has from this server, using the name you gave it when you connected. Then run a read-only tool, such as whatsapp_biz_businesses to list the businesses you administer. The connection works when that call returns your businesses instead of an authentication or permission error.

## Rate limits

Requests are rate limited per user per tool to protect the platform. If you exceed the limit, the tool returns a rate-limit error; retry after a short wait.

## Tools

The WhatsApp Business Tools MCP exposes tools namespaced with the whatsapp_biz_ prefix. Most tools are scoped to a business you administer, so a typical session starts by listing your businesses and picking one. The tool set is evolving during beta.

### Discovery

- *whatsapp_biz_businesses* — List the businesses you administer and that you granted during consent. Use this first to pick a business. Example: "List the businesses I can manage on WhatsApp."
- *whatsapp_biz_accounts* — List the WhatsApp accounts (and messaging accounts) under a business. Example: "Show the WhatsApp accounts for business 1234567890."
- *whatsapp_biz_phone_numbers* — List the phone numbers on a business or WhatsApp account, with status and onboarding state. Example: "List the phone numbers and their status for this business."

### Phone number onboarding

- *whatsapp_biz_add_phone_number* — Add a phone number to a WhatsApp account. Example: "Add the phone number +1 555 010 1234 to my WhatsApp account."
- *whatsapp_biz_send_verification_code* — Send a verification code to a phone number. Example: "Send a verification code by SMS to this number."
- *whatsapp_biz_verify_phone_number* — Verify a phone number with the received code. Example: "Verify this number with code 123456."
- *whatsapp_biz_register_phone_number* — Register a verified number so it can send and receive. Example: "Register this number for messaging."

### Message templates

- *whatsapp_biz_list_templates* / *whatsapp_biz_get_template* — List and inspect message templates on an account. Example: "List the approved templates for this account."
- *whatsapp_biz_create_template* / *whatsapp_biz_update_template* / *whatsapp_biz_delete_template* — Create, update, and delete message templates. Example: "Create a marketing template named order_update in en_US."

### Messaging

- *whatsapp_biz_send_message* — Send a free-form text (only delivered inside the 24-hour customer service window) or an approved template message from a registered number. Confirms the target with you before sending. Example: "Send the order_update template to +1 555 010 9999 from this number."

### Webhooks

- *whatsapp_biz_configure_webhooks* — Set the callback URL and verify token for the WhatsApp topic and subscribe the allowed fields. Example: "Configure webhooks for this business with callback https://example.com/webhook."
- *whatsapp_biz_subscribe_webhook* — Subscribe a WhatsApp account to your app's webhooks so its events are delivered. Example: "Subscribe this WhatsApp account to webhooks."

### Account setup

- *whatsapp_biz_configure_payments* — Configure a payment method so the account can send billable messages. Example: "Help me set up payments for this account."
- *whatsapp_biz_verify_business* — Check and start business verification. Example: "What's the business verification status, and how do I start it?"
- *whatsapp_biz_system_user_token* — Get a link to generate a *system user access token* for your business, so you can build a custom messaging solution that calls the WhatsApp Cloud API directly. Token generation happens securely in Business Settings — the tool returns a deep link to the *System Users* page, where you select a system user and generate the token. To learn more, see [Create a system user and generate a permanent access token](https://developers.facebook.com/documentation/business-messaging/whatsapp/get-started#step-5-create-a-system-user-and-generate-a-permanent-access-token). Example: "Give me a link to create a system user access token for this business."

## Feedback

If you have feedback or want to see more tools, [share your feedback](https://docs.google.com/forms/d/e/1FAIpQLSdy5WTAzvSOYx0rBkPC8sDIjkUyOMR09MsQwKLQwB48zc_MEg/viewform).

## Related

- [MCP overview](https://developers.facebook.com/documentation/mcp)
- [Connect an MCP client to Meta](https://developers.facebook.com/documentation/mcp/connect-an-mcp-client)
- [WhatsApp Business Platform documentation](https://developers.facebook.com/documentation/business-messaging/whatsapp)