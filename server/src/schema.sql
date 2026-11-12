-- Ownership, authorship and publication are separate facts.
-- A save belongs to the X user ID that asked for it. A statement belongs to
-- whoever wrote it. Only an owner's choice makes a save public.

create table if not exists users (
  id bigserial primary key,
  x_user_id text not null unique,
  x_username text not null,
  x_name text,
  x_avatar_url text,
  kind text not null default 'person' check (kind in ('person', 'editorial')),
  profile_visibility text not null default 'private'
    check (profile_visibility in ('private', 'public')),
  default_save_visibility text not null default 'private'
    check (default_save_visibility in ('private', 'public')),
  dm_updates boolean not null default false,
  setup_completed_at timestamptz,
  acquired_via text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists users_username_idx on users (lower(x_username));

create table if not exists account_events (
  id bigserial primary key,
  user_id bigint not null references users(id) on delete cascade,
  kind text not null,
  detail jsonb not null default '{}'::jsonb,
  at timestamptz not null default now()
);

create table if not exists sessions (
  id text primary key,
  user_id bigint not null references users(id) on delete cascade,
  csrf text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create table if not exists oauth_states (
  state text primary key,
  code_verifier text not null,
  purpose text not null check (purpose in ('signin', 'bot')),
  return_to text,
  ref text,
  created_at timestamptz not null default now()
);

create table if not exists bot_credentials (
  id int primary key default 1 check (id = 1),
  x_user_id text not null,
  x_username text not null,
  access_token text not null,
  refresh_token text,
  expires_at timestamptz,
  scopes text,
  updated_at timestamptz not null default now()
);

create table if not exists kv (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

create table if not exists sources (
  id bigserial primary key,
  platform text not null check (platform in ('x', 'web')),
  platform_id text not null,
  url text not null,
  author_x_user_id text,
  author_username text,
  author_name text,
  author_protected boolean not null default false,
  title text,
  text text not null,
  published_at timestamptz,
  first_observed_at timestamptz not null default now(),
  acquisition text not null check (acquisition in ('mention', 'url_intake', 'editorial')),
  available boolean not null default true,
  checked_at timestamptz,
  unique (platform, platform_id)
);

create table if not exists statements (
  id bigserial primary key,
  source_id bigint not null references sources(id) on delete cascade,
  span text not null,
  speaker text not null,
  speaker_x_user_id text,
  reported_speech boolean not null default false,
  -- What the text states, as extracted. Never overwritten.
  deadline_text text,
  proposed_deadline_at timestamptz,
  probability numeric,
  condition_text text,
  hedges text[] not null default '{}',
  -- A reviewer's public correction of the interpretation.
  deadline_at timestamptz,
  reviewed_probability numeric,
  reviewed_condition text,
  terms_confirmed_by text check (terms_confirmed_by in ('reviewer')),
  terms_confirmed_at timestamptz,
  -- 'backfill' when first captured after its deadline passed, or collected as history.
  capture text not null default 'prospective' check (capture in ('prospective', 'backfill')),
  status text not null default 'open'
    check (status in ('open', 'yes', 'no', 'ambiguous', 'annulled', 'disputed')),
  resolution_note text,
  resolution_url text,
  resolved_at timestamptz,
  resolved_by bigint references users(id),
  created_at timestamptz not null default now(),
  unique (source_id, span)
);

create table if not exists saves (
  id bigserial primary key,
  owner_x_user_id text not null,
  owner_user_id bigint references users(id) on delete cascade,
  statement_id bigint not null references statements(id) on delete cascade,
  relation text not null check (relation in ('mine', 'following')),
  visibility text not null default 'private' check (visibility in ('private', 'public')),
  annotation text,
  watch_at timestamptz,
  intake text not null check (intake in ('mention', 'url', 'dm', 'editorial')),
  origin_event_id text unique,
  -- 'backfill' when saved after the deadline passed or the outcome was recorded.
  capture text not null default 'prospective' check (capture in ('prospective', 'backfill')),
  -- The author's own confirmation. It lives on the author's save so it is
  -- only as visible as that save.
  author_deadline_at timestamptz,
  author_probability numeric,
  author_condition text,
  author_confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_x_user_id, statement_id)
);

create index if not exists saves_owner_idx on saves (owner_x_user_id);
create index if not exists saves_statement_idx on saves (statement_id);

-- Visible history. A statement-level row is public wherever the statement is
-- public. A save-level row is only as visible as its save.
create table if not exists revisions (
  id bigserial primary key,
  statement_id bigint not null references statements(id) on delete cascade,
  save_id bigint references saves(id) on delete cascade,
  kind text not null check (kind in (
    'captured', 'author_terms', 'reviewer_terms', 'resolved', 'resolution_changed',
    'disputed', 'source_unavailable', 'source_edited', 'attribution', 'capture_changed', 'terms_reparsed'
  )),
  actor text not null check (actor in ('author', 'reviewer', 'system')),
  before jsonb,
  after jsonb,
  note text,
  at timestamptz not null default now()
);

create index if not exists revisions_statement_idx on revisions (statement_id, at);

-- The author's committed deadline survives deleting the save, so removing a
-- prediction and saving the post again cannot pick a new later deadline.
-- It is owner-only and holds no post text. Compliance deletion removes it.
create table if not exists author_commitments (
  owner_x_user_id text not null,
  platform text not null,
  platform_id text not null,
  statement_id bigint references statements(id) on delete set null,
  committed_deadline_at timestamptz,
  deadline_at timestamptz,
  deadline_moved_at timestamptz,
  probability numeric,
  probability_added boolean not null default false,
  condition text,
  confirmed_at timestamptz,
  primary key (owner_x_user_id, platform, platform_id)
);

-- A public prediction withdrawn after its deadline or outcome. Counts only:
-- no claim text and no post id that would name it. The key is dropped when X
-- says the post is gone; the count stays. Removing the save does not remove it.
create table if not exists public_withdrawals (
  id bigserial primary key,
  owner_user_id bigint not null references users(id) on delete cascade,
  dedupe_key text not null,
  held_outcome text,
  scoring_probability numeric,
  after_outcome boolean not null,
  after_deadline boolean not null,
  at timestamptz not null default now(),
  unique (owner_user_id, dedupe_key)
);

create table if not exists visitor_refs (
  visitor text primary key,
  ref text not null,
  at timestamptz not null default now()
);

create table if not exists correction_requests (
  id bigserial primary key,
  statement_id bigint not null references statements(id) on delete cascade,
  requester_user_id bigint not null references users(id) on delete cascade,
  kind text not null check (kind in ('interpretation', 'resolution')),
  body text not null,
  evidence_url text,
  status text not null default 'open' check (status in ('open', 'accepted', 'rejected')),
  reviewer_note text,
  created_at timestamptz not null default now(),
  decided_at timestamptz
);

create table if not exists visibility_events (
  id bigserial primary key,
  save_id bigint references saves(id) on delete cascade,
  user_id bigint references users(id) on delete cascade,
  scope text not null check (scope in ('save', 'profile')),
  from_value text,
  to_value text not null,
  at timestamptz not null default now()
);

create table if not exists mention_events (
  event_id text primary key,
  author_x_user_id text not null,
  author_username text,
  mention_created_at timestamptz,
  received_at timestamptz not null default now(),
  outcome text not null,
  payload jsonb,
  attempts int not null default 0,
  save_id bigint references saves(id) on delete set null,
  intake_id bigint,
  reply_text text,
  reply_exclude text[] not null default '{}',
  reply_status text not null default 'none'
    check (reply_status in ('none', 'held', 'pending', 'sending', 'sent', 'failed')),
  reply_post_id text,
  reply_error text,
  replied_at timestamptz
);

create table if not exists url_intakes (
  id bigserial primary key,
  owner_x_user_id text not null,
  url text not null,
  route text not null check (route in ('web', 'dm', 'mention', 'editorial')),
  status text not null check (status in ('queued', 'fetched', 'failed', 'selected')),
  backfill boolean not null default false,
  source_id bigint references sources(id) on delete set null,
  candidates jsonb not null default '[]'::jsonb,
  error text,
  created_at timestamptz not null default now()
);

create table if not exists dm_events (
  event_id text primary key,
  sender_x_user_id text not null,
  received_at timestamptz not null default now(),
  outcome text not null,
  intake_id bigint
);

create table if not exists inbox (
  id bigserial primary key,
  owner_x_user_id text not null,
  kind text not null check (kind in (
    'saved', 'pending_terms', 'pick_predictions', 'deadline', 'outcome', 'source_unavailable', 'bet_update'
  )),
  save_id bigint references saves(id) on delete cascade,
  statement_id bigint references statements(id) on delete cascade,
  intake_id bigint references url_intakes(id) on delete cascade,
  body text not null,
  dedupe_key text not null unique,
  deliver_dm boolean not null default false,
  dm_status text not null default 'none' check (dm_status in ('none', 'pending', 'sent', 'failed', 'unavailable')),
  dm_error text,
  created_at timestamptz not null default now(),
  done_at timestamptz
);

create index if not exists inbox_owner_idx on inbox (owner_x_user_id, done_at);

-- Testnet challenges are separate from prediction records and scores.
-- Accepted terms are never edited; result proposals and events are append-only.
create table if not exists bilateral_bets (
  id uuid primary key,
  creator_user_id bigint not null references users(id),
  invited_user_id bigint references users(id),
  acceptor_user_id bigint references users(id),
  request_id uuid not null,
  claim text not null check (length(claim) between 1 and 1000),
  criteria text not null check (length(criteria) between 1 and 2000),
  evidence_source_url text not null,
  creator_side text not null check (creator_side in ('yes', 'no')),
  stake_yocto text not null check (stake_yocto ~ '^[1-9][0-9]{0,24}$' and stake_yocto::numeric <= 1000000000000000000000000),
  invited_wallet text,
  creator_wallet text,
  acceptor_wallet text,
  chain_state jsonb,
  near_height bigint,
  accept_by timestamptz not null,
  resolve_at timestamptz not null check (resolve_at > accept_by),
  terms_hash text not null,
  terms_salt text not null,
  status text not null default 'offered'
    check (status in ('offered', 'accepted', 'proposed', 'disputed', 'settled', 'cancelled', 'expired', 'refunded')),
  accepted_at timestamptz,
  settled_at timestamptz,
  outcome text check (outcome in ('yes', 'no', 'void')),
  current_proposal_id uuid,
  current_proposal_revision bigint,
  created_at timestamptz not null default now(),
  unique (creator_user_id, request_id),
  check (creator_user_id <> invited_user_id),
  check (creator_user_id <> acceptor_user_id),
  check (invited_user_id is null or acceptor_user_id is null or invited_user_id = acceptor_user_id)
);
create index if not exists bilateral_bets_creator_idx on bilateral_bets (creator_user_id, created_at desc);
create index if not exists bilateral_bets_acceptor_idx on bilateral_bets (acceptor_user_id, created_at desc);
create index if not exists bilateral_bets_invited_idx on bilateral_bets (invited_user_id, created_at desc);

create table if not exists bilateral_bet_proposals (
  id uuid not null,
  bet_id uuid not null references bilateral_bets(id),
  revision bigint not null check (revision > 0),
  proposer_user_id bigint not null references users(id),
  outcome text not null check (outcome in ('yes', 'no', 'void')),
  evidence_url text,
  note text not null check (length(note) between 1 and 2000),
  created_at timestamptz not null default now(),
  primary key (bet_id, revision)
);
create table if not exists bilateral_bet_events (
  id bigserial primary key,
  bet_id uuid not null references bilateral_bets(id),
  actor_user_id bigint not null references users(id),
  kind text not null,
  detail jsonb not null default '{}'::jsonb,
  at timestamptz not null default now()
);
create index if not exists bilateral_bet_events_bet_idx on bilateral_bet_events (bet_id, id);

create table if not exists bilateral_near_requests (
  id uuid primary key,
  bet_id uuid not null references bilateral_bets(id),
  user_id bigint not null references users(id),
  wallet_account text not null,
  method text not null,
  args jsonb not null,
  binding_hash text unique,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists bilateral_near_requests_bet_idx on bilateral_near_requests (bet_id, user_id, created_at desc);

alter table bilateral_near_requests add column if not exists execution_status text not null default 'pending'
  check (execution_status in ('pending', 'succeeded', 'failed'));
alter table bilateral_near_requests add column if not exists transaction_hash text;
alter table bilateral_near_requests add column if not exists execution_message text;
alter table bilateral_near_requests add column if not exists execution_checked_at timestamptz;
drop index if exists bilateral_near_requests_transaction_idx;
create unique index if not exists bilateral_near_requests_final_transaction_idx
  on bilateral_near_requests(transaction_hash)
  where transaction_hash is not null and execution_status <> 'pending';

alter table bilateral_bets add column if not exists near_verified_at timestamptz;
alter table bilateral_bets add column if not exists near_attempted_at timestamptz;
alter table bilateral_bets add column if not exists near_absent_after_expiry boolean not null default false;
alter table bilateral_bets add column if not exists source_save_id bigint;
-- Replace the original inline FK by its PostgreSQL-generated name. Existing
-- NULLs remain valid; every existing non-NULL reference is validated on add.
do $$
begin
  if exists (select 1 from pg_constraint
    where conrelid = 'bilateral_bets'::regclass
      and conname = 'bilateral_bets_source_save_id_fkey' and confdeltype <> 'r') then
    alter table bilateral_bets drop constraint bilateral_bets_source_save_id_fkey;
  end if;
  if not exists (select 1 from pg_constraint
    where conrelid = 'bilateral_bets'::regclass
      and conname = 'bilateral_bets_source_save_id_fkey') then
    alter table bilateral_bets add constraint bilateral_bets_source_save_id_fkey
      foreign key (source_save_id) references saves(id) on delete restrict;
  end if;
end;
$$;

create table if not exists bilateral_bet_publications (
  bet_id uuid primary key references bilateral_bets(id),
  creator_user_id bigint not null references users(id),
  published_at timestamptz not null default now(),
  withdrawn_at timestamptz
);
create index if not exists bilateral_bet_publications_recent_idx
  on bilateral_bet_publications(published_at desc, bet_id desc) where withdrawn_at is null;
create table if not exists bilateral_bet_public_consents (
  bet_id uuid not null references bilateral_bets(id),
  user_id bigint not null references users(id),
  consented_at timestamptz not null default now(),
  primary key (bet_id, user_id)
);
create table if not exists bilateral_bet_follows (
  bet_id uuid not null references bilateral_bets(id),
  user_id bigint not null references users(id),
  created_at timestamptz not null default now(),
  primary key (bet_id, user_id)
);
create index if not exists bilateral_bet_follows_user_idx
  on bilateral_bet_follows(user_id, created_at desc, bet_id);

alter table inbox add column if not exists bet_id uuid references bilateral_bets(id);

create table if not exists visits (
  id bigserial primary key,
  path text not null,
  ref text,
  viewer_user_id bigint,
  at timestamptz not null default now()
);

-- Upgrades for databases created by an earlier version of this file. Each
-- statement is safe to repeat. A check constraint that gained values is
-- replaced; a column that was added later is added if missing.

alter table users add column if not exists x_avatar_url text;
alter table users add column if not exists dm_opted_out_at timestamptz;
alter table url_intakes add column if not exists backfill boolean not null default false;
alter table mention_events add column if not exists payload jsonb;
alter table mention_events add column if not exists attempts int not null default 0;
alter table mention_events add column if not exists processing_since timestamptz;
alter table mention_events add column if not exists command text;
alter table dm_events add column if not exists attempts int not null default 0;
alter table dm_events add column if not exists processing_since timestamptz;
-- When the outcome became known, as recorded by the reviewer.
alter table statements add column if not exists outcome_at timestamptz;
-- First time this save was visible to the public. Never cleared.
alter table saves add column if not exists first_public_at timestamptz;
-- The probability the author added after posting; shown, never scored.
alter table saves add column if not exists author_probability_added boolean not null default false;
alter table saves add column if not exists capture_reason text;
-- The earliest deadline the author ever confirmed. Never moves later.
alter table saves add column if not exists author_committed_deadline_at timestamptz;
-- When the author last moved the deadline later than the committed one.
alter table saves add column if not exists author_deadline_moved_at timestamptz;
update saves s set author_committed_deadline_at = least(s.author_deadline_at, (
    select min((r.after->>'deadlineAt')::timestamptz) from revisions r
    where r.save_id = s.id and r.kind = 'author_terms' and r.after->>'deadlineAt' is not null))
  where s.author_committed_deadline_at is null and s.author_deadline_at is not null;
-- A visitor is a hashed first-party cookie; the visit counts once a day.
alter table visits add column if not exists visitor text;
create index if not exists visits_visitor_idx on visits (visitor, path, at);
-- Mention payloads keep IDs only; the words are read again from X on retry.
update mention_events set payload = jsonb_build_object(
    'mention', jsonb_strip_nulls(jsonb_build_object(
      'id', payload->'mention'->'id',
      'author_id', payload->'mention'->'author_id',
      'created_at', payload->'mention'->'created_at',
      'referenced_tweets', payload->'mention'->'referenced_tweets',
      'in_reply_to_user_id', payload->'mention'->'in_reply_to_user_id')),
    'includes', '{}'::jsonb)
  where payload is not null and payload ? 'mention'
    and (payload->'mention' ? 'text' or payload->'mention' ? 'note_tweet' or payload->'mention' ? 'entities'
         or coalesce(payload->'includes', '{}'::jsonb) <> '{}'::jsonb);

alter table revisions drop constraint if exists revisions_kind_check;
alter table revisions add constraint revisions_kind_check check (kind in (
  'captured', 'author_terms', 'reviewer_terms', 'resolved', 'resolution_changed',
  'disputed', 'source_unavailable', 'source_edited', 'attribution', 'capture_changed', 'terms_reparsed'
));

alter table inbox drop constraint if exists inbox_kind_check;
alter table inbox add constraint inbox_kind_check check (kind in (
  'saved', 'pending_terms', 'pick_predictions', 'deadline', 'outcome', 'source_unavailable', 'bet_update'
));

alter table mention_events drop constraint if exists mention_events_reply_status_check;
alter table mention_events add constraint mention_events_reply_status_check
  check (reply_status in ('none', 'held', 'pending', 'sending', 'sent', 'failed'));

alter table url_intakes drop constraint if exists url_intakes_status_check;
alter table url_intakes add constraint url_intakes_status_check
  check (status in ('queued', 'fetched', 'failed', 'selected'));

-- Bets in the replies. A referee named when a Bet is funded can settle it
-- (contract version 2). Play accounts are testnet accounts named after an X
-- handle; the server holds their key, sealed with the token key, until the
-- person claims the account.
alter table bilateral_bets add column if not exists referee_wallet text;
create table if not exists play_accounts (
  x_user_id text primary key,
  account_id text not null unique,
  secret_sealed text,
  public_key text not null,
  ready boolean not null default false,
  granted_yocto text not null default '0',
  created_at timestamptz not null default now(),
  claimed_at timestamptz
);
create table if not exists bet_commands (
  event_id text primary key,
  x_user_id text not null,
  x_username text,
  kind text not null check (kind in ('bet', 'take')),
  side text check (side in ('yes', 'no')),
  stake_near text,
  save_id bigint references saves(id) on delete set null,
  target_ref text,
  -- The post's words, held only until the Bet is created from them.
  words text,
  bet_id uuid references bilateral_bets(id),
  status text not null default 'queued' check (status in ('queued', 'done', 'refused', 'failed')),
  attempts int not null default 0,
  detail text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists bet_commands_queue_idx on bet_commands (status, created_at) where status = 'queued';
create index if not exists bet_commands_bet_idx on bet_commands (bet_id);
-- Public replies about a Bet: the offer, the match and the result. One row per
-- thing to say (dedupe_key), sent at most once.
create table if not exists bot_outbox (
  id bigserial primary key,
  dedupe_key text not null unique,
  in_reply_to text not null,
  body text not null,
  exclude text[] not null default '{}',
  bet_id uuid references bilateral_bets(id),
  status text not null default 'pending' check (status in ('pending', 'held', 'sending', 'sent', 'failed')),
  post_id text,
  error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index if not exists bot_outbox_pending_idx on bot_outbox (created_at) where status = 'pending';
alter table bilateral_bets add column if not exists settle_checked_at timestamptz;
-- People in the thread who did not summon the bot are left out of its replies' automatic mentions.
alter table bet_commands add column if not exists exclude text[] not null default '{}';
-- A payment of NEAR into a play account from another chain, through NEAR Intents
-- (mainnet only). The row, with the signed quote, is written before the person
-- is shown where to pay. state follows the 1Click API, plus EXPIRED for an
-- address that was never paid.
create table if not exists play_deposits (
  id uuid primary key,
  x_user_id text not null references play_accounts(x_user_id),
  account_id text not null,
  origin_asset text not null,
  origin_symbol text not null,
  origin_chain text not null,
  near_yocto text not null,
  amount_in text not null,
  min_amount_in text,
  deposit_address text not null,
  deposit_memo text,
  refund_to text not null,
  deadline timestamptz not null,
  state text not null default 'PENDING_DEPOSIT',
  delivered_yocto text,
  destination_tx text,
  unwrap_tx text,
  refunded text,
  refund_reason text,
  signed jsonb not null,
  checked_at timestamptz,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists play_deposits_person_idx on play_deposits (x_user_id, created_at desc);
create index if not exists play_deposits_open_idx on play_deposits (created_at) where finished_at is null;

-- Enclave ruling attempts: at most three per statement (a ruling) or per Bet (a
-- review), five minutes apart. A row is written before inference starts, so it
-- also keeps two workers from ruling on the same thing at once.
create table if not exists enclave_ruling_attempts (
  id bigserial primary key,
  mode text not null check (mode in ('ruling', 'review')),
  statement_id bigint references statements(id) on delete cascade,
  bet_id uuid references bilateral_bets(id),
  reason text not null default 'running',
  at timestamptz not null default now(),
  check ((mode = 'ruling' and statement_id is not null and bet_id is null)
    or (mode = 'review' and bet_id is not null and statement_id is null))
);
create index if not exists enclave_ruling_attempts_statement_idx on enclave_ruling_attempts (statement_id, at) where statement_id is not null;
create index if not exists enclave_ruling_attempts_bet_idx on enclave_ruling_attempts (bet_id, at) where bet_id is not null;

-- Evidence a bettor offers for a post's Result, by reply or on the Bet's page. The page's
-- text is read once, when it is offered, and kept with its hash: the jury reads exactly this.
create table if not exists bet_evidence (
  id bigserial primary key,
  statement_id bigint not null references statements(id) on delete cascade,
  bet_id uuid not null references bilateral_bets(id),
  user_id bigint not null references users(id),
  side text not null check (side in ('yes', 'no')),
  url text not null check (length(url) between 9 and 600),
  final_url text,
  title text,
  body text not null check (length(body) between 1 and 6000),
  body_hash text not null,
  via text not null check (via in ('reply', 'page')),
  event_id text,
  at timestamptz not null default clock_timestamp(),
  unique (statement_id, user_id, url)
);
create index if not exists bet_evidence_statement_idx on bet_evidence (statement_id, id);

-- Short-lived slots bound network work before any evidence fetch starts.
-- The statement/user scope preserves the existing two-links-per-post limit.
create table if not exists bet_evidence_reservations (
  id uuid primary key,
  statement_id bigint not null references statements(id) on delete cascade,
  bet_id uuid not null references bilateral_bets(id),
  user_id bigint not null references users(id),
  url text not null check (length(url) between 9 and 600),
  expires_at timestamptz not null default (clock_timestamp() + interval '1 minute'),
  unique (statement_id, user_id, url)
);

-- Result fields belong to the statement, so every public save can display them.
-- Apply the privacy guard to all writers, including reviewer-recorded Results.
create or replace function protect_private_bet_result() returns trigger
language plpgsql as $$
begin
  if (new.resolution_url is not null or new.resolution_note is not null) and exists (
    select 1 from bilateral_bets b join saves s on s.id = b.source_save_id
    where s.statement_id = new.id and not exists (
      select 1 from bilateral_bet_publications p
      where p.bet_id = b.id and p.creator_user_id = b.creator_user_id and p.withdrawn_at is null
    )
  ) then
    new.resolution_url := null;
    new.resolution_note := 'Result recorded. Bet evidence stays on its Bet page.';
  end if;
  return new;
end;
$$;
drop trigger if exists statements_private_bet_result on statements;
create trigger statements_private_bet_result
  before insert or update of resolution_url, resolution_note on statements
  for each row execute function protect_private_bet_result();

-- Remove previously copied private evidence without requiring empty tables.
update statements st set resolution_url = null,
  resolution_note = 'Result recorded. Bet evidence stays on its Bet page.'
where (st.resolution_url is not null or (st.resolution_note is not null
    and st.resolution_note <> 'Result recorded. Bet evidence stays on its Bet page.'))
  and exists (select 1 from bilateral_bets b join saves s on s.id = b.source_save_id
    where s.statement_id = st.id and not exists (
      select 1 from bilateral_bet_publications p
      where p.bet_id = b.id and p.creator_user_id = b.creator_user_id and p.withdrawn_at is null
    ));

-- Where a post's Result will come from, decided once by the enclave when the deadline passes:
-- a Coinbase price, or evidence the bettors offer until closes_at. prompted_at is when the
-- bot asked for that evidence in the thread.
create table if not exists enclave_plans (
  statement_id bigint primary key references statements(id) on delete cascade,
  source text not null check (source in ('coinbase-candles', 'evidence')),
  closes_at timestamptz,
  record jsonb not null,
  prompted_at timestamptz,
  at timestamptz not null default clock_timestamp()
);

-- A bettor's reply offering evidence ("yes <link>"), queued when the mention is read and
-- worked off by the play worker, which is where the page is fetched.
create table if not exists evidence_commands (
  event_id text primary key,
  x_user_id text not null,
  x_username text,
  side text not null check (side in ('yes', 'no')),
  url text not null,
  target_ref text,
  status text not null default 'queued' check (status in ('queued', 'done', 'refused', 'failed')),
  detail text,
  attempts integer not null default 0,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);
create index if not exists evidence_commands_queue_idx on evidence_commands (created_at) where status = 'queued';
