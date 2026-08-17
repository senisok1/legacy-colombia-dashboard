# trash-unread-inbox-mail — run report (2026-08-17)

**Status: BLOCKED — no delete capability.**

The Outlook connector in this session exposes read-only tools only: `outlook_email_search`, `read_resource`, `outlook_calendar_search`, `outlook_find_available_time`, `sharepoint_search`, `teams_list_chats`, `get_me`. `outlook_batch_delete_messages` does not exist — searched by exact name and by keyword ("delete messages trash", "move email to deleted items"); no delete/move/trash tool is present on any connected server.

**Cursor deliberately NOT advanced** (still `2026-08-15T14:02:14.000Z`) so these messages get re-processed once delete capability is restored. Advancing it would have permanently skipped them.

## Scan results — 11 messages, from cursor to present

Would-have-deleted (unread + bulk/marketing):

| Sender | Subject | Received |
|---|---|---|
| uber@uber.com | Back-to-school deal: 20% off | 2026-08-15 15:51Z |
| uber@uber.com | One last shot at up to 50% off | 2026-08-15 22:29Z |

Both domains already in `unsubscribedDomains` — no unsubscribe attempts needed.

Left alone (unread, judged transactional rather than marketing):

- shipment-tracking@amazon.com — "Shipped: 3 Storage and Bedding items" (2026-08-16 18:00Z)

Unsubscribe attempts this run: none.

## Fix needed

Grant the Outlook connector `Mail.ReadWrite` and re-authorize so a delete/move tool is exposed. Per the memory note from 2026-08-08, the Outlook Mail.ReadWrite/Send scope was fixed once before via Entra → Enterprise Apps consent — likely the same path.
