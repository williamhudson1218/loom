---
name: test-links
description: Use after you change something a person can see in a running app (a page, a form, a dialog, a report). Registers the exact pages to check with `loom test-links add` so the person gets a Test button on this chat that opens them. Skip it when nothing visible changed.
---

# Registering test links

Loom shows a **Test (N)** button on a chat once it has registered links. The button opens each page in the
person's browser, so they can try what this chat built without hunting for the right URL.

## When

After you change something a person can see in a running app and you know the address it runs at. Register
the pages to check once the work is in a state worth trying.

Skip it when nothing visible changed: a refactor, a test-only change, a backend fix with no screen, a docs edit,
or when you do not know where the app is served. No links is a normal outcome; do not invent one.

## How

One link per surface, each labelled with what to look at:

```bash
loom test-links add "http://localhost:3000/orders/42" --label "Order detail: the new refund row shows under totals"
loom test-links add "http://localhost:3000/orders" --label "Orders list: refund filter in the toolbar"
```

- Use the exact page, with any query string or record id that makes the change visible, not the app's home page.
- Labels say what to check, in a short phrase. They are not a changelog.
- Only `http` and `https` URLs are accepted. Loom keeps the newest 10 per chat; adding the same URL again
  updates its label.
- Replace a stale set with `loom test-links clear` (all) or `loom test-links clear <url>`, then add the new pages.
- `loom test-links list` shows what is registered for this chat.
