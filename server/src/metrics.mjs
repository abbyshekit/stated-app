// Product metrics from real events. Editorial saves and excluded test
// accounts are left out. Private use and public sharing are separate cohorts.

export async function metrics(db, { exclude = [] } = {}) {
  const ex = exclude.length ? exclude : ['__none__'];
  const tags = await db.one(
    `select
       count(*) filter (where outcome in ('saved', 'duplicate', 'article', 'source_unavailable')) as valid_tags,
       count(*) filter (where outcome = 'saved') as saved,
       count(*) filter (where outcome = 'duplicate') as duplicate,
       count(*) filter (where outcome = 'article') as article,
       count(*) filter (where outcome = 'source_unavailable') as unavailable,
       count(*) filter (where outcome = 'error') as errors,
       count(*) filter (where reply_status = 'sent') as replies_sent,
       count(*) filter (where reply_status = 'failed') as replies_failed,
       count(distinct author_x_user_id) filter (where outcome in ('saved', 'duplicate', 'article')) as taggers
     from mention_events where not (author_x_user_id = any($1))`,
    [ex],
  );
  const repeat = await db.one(
    `with per as (
       select owner_x_user_id, count(*) as saves,
              count(distinct (created_at at time zone 'utc')::date) as days
       from saves where intake in ('mention', 'url', 'dm') and not (owner_x_user_id = any($1))
       group by owner_x_user_id)
     select count(*) as savers,
            count(*) filter (where saves >= 2) as repeat_savers,
            count(*) filter (where days >= 2) as returned_another_day
     from per`,
    [ex],
  );
  const latency = await db.one(
    `select percentile_cont(0.5) within group (order by extract(epoch from s.created_at - m.mention_created_at)) as median_seconds
     from mention_events m join saves s on s.id = m.save_id
     where m.outcome = 'saved' and m.mention_created_at is not null and not (m.author_x_user_id = any($1))`,
    [ex],
  );
  const accounts = await db.one(
    `select count(*) filter (where setup_completed_at is not null) as set_up,
            count(*) filter (where profile_visibility = 'public' and setup_completed_at is not null) as public_profiles,
            count(*) filter (where acquired_via = 'reply') as acquired_from_reply,
            count(*) filter (where acquired_via = 'profile') as acquired_from_profile
     from users where kind = 'person' and not (x_user_id = any($1))`,
    [ex],
  );
  const collections = await db.one(
    `select count(*) filter (where s.relation = 'mine') as mine,
            count(*) filter (where s.relation = 'following') as following,
            count(*) filter (where s.visibility = 'public' and u.profile_visibility = 'public' and u.setup_completed_at is not null) as public_saves,
            count(*) filter (where s.owner_user_id is null) as pending
     from saves s left join users u on u.id = s.owner_user_id
     where s.intake <> 'editorial' and not (s.owner_x_user_id = any($1))`,
    [ex],
  );
  const visits = await db.one(
    `select count(*) filter (where ref = 'reply') as from_reply,
            count(*) filter (where ref = 'profile') as from_profile,
            count(*) as public_page_views
     from visits`,
  );
  // The invitation loop, from persisted Bet rows only. A Bet counts once it
  // exists; "funded" means a finalized chain snapshot. "New" people are
  // accounts created after the Bet was, so an operator's own accounts made
  // beforehand never read as arrivals.
  const bets = await db.one(
    `select count(*) as offered,
            count(*) filter (where b.chain_state is not null) as funded,
            count(*) filter (where p.bet_id is not null and p.withdrawn_at is null) as published,
            count(*) filter (where b.acceptor_user_id is not null) as accepted,
            count(*) filter (where b.status = 'settled') as settled,
            count(*) filter (where a.created_at > b.created_at) as accepted_by_new_account
     from bilateral_bets b
     join users c on c.id = b.creator_user_id
     left join users a on a.id = b.acceptor_user_id
     left join bilateral_bet_publications p on p.bet_id = b.id
     where not (c.x_user_id = any($1))`,
    [ex],
  );
  const follows = await db.one(
    `select count(*) as follows,
            count(*) filter (where u.created_at > b.created_at) as follows_by_new_account
     from bilateral_bet_follows f
     join bilateral_bets b on b.id = f.bet_id
     join users u on u.id = f.user_id
     where not (u.x_user_id = any($1))`,
    [ex],
  );
  // Browsers that opened a public Bet page and were not one of its two sides.
  const betViews = await db.one(
    `select count(*) as views
     from visits v
     where v.path like '/bets/%'
       and not exists (
         select 1 from bilateral_bets b
         where b.id::text = substr(v.path, 7)
           and v.viewer_user_id in (b.creator_user_id, b.acceptor_user_id))`,
  );
  const n = (v) => Number(v || 0);
  const validTags = n(tags.valid_tags);
  return {
    tags: {
      valid: validTags,
      saved: n(tags.saved),
      duplicate: n(tags.duplicate),
      article: n(tags.article),
      unavailable: n(tags.unavailable),
      errors: n(tags.errors),
      savesPerValidTag: validTags ? (n(tags.saved) + n(tags.duplicate)) / validTags : null,
      taggers: n(tags.taggers),
      repliesSent: n(tags.replies_sent),
      repliesFailed: n(tags.replies_failed),
      medianSecondsToSave: latency.median_seconds == null ? null : Number(latency.median_seconds),
    },
    repeat: {
      savers: n(repeat.savers),
      repeatSavers: n(repeat.repeat_savers),
      returnedAnotherDay: n(repeat.returned_another_day),
    },
    accounts: {
      setUp: n(accounts.set_up),
      publicProfiles: n(accounts.public_profiles),
      acquiredFromReply: n(accounts.acquired_from_reply),
      acquiredFromProfile: n(accounts.acquired_from_profile),
    },
    collections: {
      mine: n(collections.mine),
      following: n(collections.following),
      publicSaves: n(collections.public_saves),
      pending: n(collections.pending),
    },
    bets: {
      offered: n(bets.offered),
      funded: n(bets.funded),
      published: n(bets.published),
      pageViews: n(betViews.views),
      follows: n(follows.follows),
      followsByNewAccount: n(follows.follows_by_new_account),
      accepted: n(bets.accepted),
      acceptedByNewAccount: n(bets.accepted_by_new_account),
      settled: n(bets.settled),
    },
    visits: {
      fromReply: n(visits.from_reply),
      fromProfile: n(visits.from_profile),
      publicPageViews: n(visits.public_page_views),
    },
  };
}
