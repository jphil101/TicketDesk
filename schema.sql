-- Created automatically on the first sync request. Kept here for reference or manual setup.

create table if not exists desks (
  desk text primary key,
  rev bigint not null default 0,
  created_at timestamptz not null default now(),
  seen_at timestamptz not null default now()
);

create table if not exists items (
  desk text not null references desks(desk) on delete cascade,
  kind text not null,
  id text not null,
  body jsonb,
  deleted boolean not null default false,
  updated_at bigint not null,
  rev bigint not null,
  primary key (desk, kind, id)
);

create index if not exists items_desk_rev on items (desk, rev);

create table if not exists guest_links (
  token_hash text primary key,
  desk text not null references desks(desk) on delete cascade,
  mode text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  submissions integer not null default 0
);

create index if not exists guest_links_desk on guest_links (desk);

create table if not exists settings (
  key text primary key,
  value jsonb not null
);

create table if not exists push_subs (
  endpoint text primary key,
  desk text not null references desks(desk) on delete cascade,
  sub jsonb not null,
  tz text not null default 'UTC',
  prefs jsonb not null default '{"guest": true, "digest": true}',
  last_digest text,
  created_at timestamptz not null default now()
);

create index if not exists push_subs_desk on push_subs (desk);

create table if not exists desk_settings (
  desk text primary key references desks(desk) on delete cascade,
  email text,
  email_guest boolean not null default false,
  email_digest boolean not null default false,
  tz text not null default 'UTC',
  last_digest text
);
