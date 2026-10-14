-- Feedback & messages: one table for three kinds of message, plus read receipts.
--   feedback   product feedback; everyone sees it, admins set its status
--   broadcast  an announcement from an admin to everyone
--   direct     one person to one person; only those two can read it
-- Replies to feedback and announcements are rows with parent_id set and the
-- parent's kind. A direct conversation is just the direct rows between two
-- people, so it needs no parent.
-- Run once in the Supabase SQL editor (CRM project). Idempotent.
begin;

create table if not exists messages (
  id           bigint generated always as identity primary key,
  kind         text not null check (kind in ('feedback', 'broadcast', 'direct')),
  sender_id    uuid not null default auth.uid() references users(id),
  recipient_id uuid references users(id),
  parent_id    bigint references messages(id) on delete cascade,
  body         text not null check (length(btrim(body)) between 1 and 4000),
  category     text check (category in ('bug', 'idea', 'question', 'other')),
  status       text check (status in ('new', 'planned', 'in_progress', 'done', 'wont_do')),
  created_at   timestamptz not null default now(),
  constraint messages_direct_recipient check ((kind = 'direct') = (recipient_id is not null)),
  constraint messages_direct_flat      check (kind <> 'direct' or parent_id is null)
);
create index if not exists messages_kind_created on messages (kind, created_at desc);
create index if not exists messages_recipient on messages (recipient_id) where recipient_id is not null;
create index if not exists messages_parent on messages (parent_id) where parent_id is not null;

create table if not exists message_reads (
  user_id    uuid not null default auth.uid() references users(id) on delete cascade,
  message_id bigint not null references messages(id) on delete cascade,
  read_at    timestamptz not null default now(),
  primary key (user_id, message_id)
);

alter table messages enable row level security;
alter table message_reads enable row level security;

-- Read: feedback and announcements are team-wide; a direct message only to its two ends.
drop policy if exists msg_read on messages;
create policy msg_read on messages for select to authenticated
  using (kind <> 'direct' or sender_id = auth.uid() or recipient_id = auth.uid());

-- Write: always as yourself. A new announcement is admin-only (replies to one are
-- open). A direct message goes to someone else who is active. A reply must sit
-- under a top-level message of the same kind. Only admins may set a status.
drop policy if exists msg_ins on messages;
create policy msg_ins on messages for insert to authenticated
  with check (
    sender_id = auth.uid()
    and (kind <> 'broadcast' or parent_id is not null or is_admin())
    and (kind <> 'direct' or (recipient_id <> auth.uid()
         and exists (select 1 from users u where u.id = recipient_id and u.active)))
    and (parent_id is null or exists (
         select 1 from messages p where p.id = parent_id and p.kind = messages.kind and p.parent_id is null))
    and (status is null or status = 'new' or is_admin())
  );

-- Update: admins move feedback through its statuses. The trigger below pins
-- the row to that one column, so "update" can never rewrite what someone said.
drop policy if exists msg_admin_upd on messages;
create policy msg_admin_upd on messages for update to authenticated
  using (is_admin() and kind = 'feedback' and parent_id is null);

create or replace function public.messages_status_only()
returns trigger language plpgsql as $$
begin
  if (new.kind, new.sender_id, new.recipient_id, new.parent_id, new.body, new.category, new.created_at)
     is distinct from
     (old.kind, old.sender_id, old.recipient_id, old.parent_id, old.body, old.category, old.created_at) then
    raise exception 'only the status of a message can be changed';
  end if;
  return new;
end $$;
drop trigger if exists messages_status_only on messages;
create trigger messages_status_only before update on messages
  for each row execute function public.messages_status_only();

-- Top-level feedback starts as 'new' even when the client sends no status.
create or replace function public.messages_default_status()
returns trigger language plpgsql as $$
begin
  if new.kind = 'feedback' and new.parent_id is null and new.status is null then
    new.status := 'new';
  end if;
  return new;
end $$;
drop trigger if exists messages_default_status on messages;
create trigger messages_default_status before insert on messages
  for each row execute function public.messages_default_status();

-- Read receipts: your own only.
drop policy if exists mr_read on message_reads;
create policy mr_read on message_reads for select to authenticated using (user_id = auth.uid());
drop policy if exists mr_ins on message_reads;
create policy mr_ins on message_reads for insert to authenticated with check (user_id = auth.uid());

commit;
