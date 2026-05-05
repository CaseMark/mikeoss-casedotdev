-- Store optional workflow metadata attached to assistant chat messages.
-- Earlier routes already attempted to write this field; without the column,
-- user-message inserts could fail and silently drop Matter chat history.

alter table public.chat_messages
  add column if not exists workflow jsonb;
