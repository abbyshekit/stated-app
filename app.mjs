import {
  acknowledge,
  addEvidence,
  addForecast,
  addQuestion,
  followNote,
  latestMedian,
  leagueSignals,
  profileOf,
  questionList,
  questionScores,
  remindersFor,
  resolveQuestion,
  setName,
  RecordError,
} from './domain.mjs';
import { seedState } from './seed.mjs';
import {
  callPosts,
  closeStamp,
  fits,
  receiptPost,
  updatePost,
  xIntent,
} from './xpost.mjs';

const KEY = 'stated.december-desk.v2';
const ZONE = 'America/New_York';

let state = load();
let errors = {};
let notice = '';
let preserveNotice = false;
let draft = {};
let lastRoute = '';

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return seedState(Date.now());
    const parsed = JSON.parse(raw);
    if (!parsed?.people?.you || parsed.league?.id !== 'december-desk') return seedState(Date.now());
    return parsed;
  } catch {
    return seedState(Date.now());
  }
}

function save() {
  localStorage.setItem(KEY, JSON.stringify(state));
}

function esc(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function raw(value) {
  return { raw: String(value) };
}

function html(strings, ...vals) {
  let out = '';
  strings.forEach((part, i) => {
    out += part;
    if (i >= vals.length) return;
    const value = vals[i];
    if (value == null || value === false) return;
    if (Array.isArray(value)) {
      out += value.map((item) => (item && item.raw != null ? item.raw : String(item ?? ''))).join('');
      return;
    }
    if (value && value.raw != null) {
      out += value.raw;
      return;
    }
    out += esc(value);
  });
  const branded = new String(out);
  branded.raw = out;
  return branded;
}

function formatWhen(ms) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: ZONE,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(ms));
}

function formatDay(ms) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: ZONE,
    month: 'short',
    day: 'numeric',
  }).format(new Date(ms));
}

function pct(p) {
  return `${Math.round(p * 100)}%`;
}

function signed(n) {
  const rounded = Math.round(n);
  return rounded > 0 ? `+${rounded}` : String(rounded);
}

function mark(baseline) {
  const rounded = Math.round(baseline);
  if (rounded > 0) return html`<span class="mark hit">Hit ${signed(rounded)}</span>`;
  if (rounded < 0) return html`<span class="mark miss">Miss ${signed(rounded)}</span>`;
  return html`<span class="mark">Coin flip 0</span>`;
}

function personName(id) {
  return state.people[id]?.name || 'Someone';
}

function nameList(names) {
  if (names.length <= 1) return names[0] || '';
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
}

function nameLink(id) {
  const person = state.people[id];
  if (!person) return 'Someone';
  return html`<a href="#/p/${id}">${person.name}</a>${person.sample ? html`<span class="example">Example</span>` : ''}`;
}

function closesIn(close, now) {
  const hours = (close - now) / 3600000;
  if (hours <= 0) return 'Closed to updates';
  if (hours < 48) {
    const rounded = Math.max(1, Math.round(hours));
    return `Closes in ${rounded} ${rounded === 1 ? 'hour' : 'hours'}`;
  }
  const days = Math.round(hours / 24);
  return `Closes in ${days} ${days === 1 ? 'day' : 'days'}`;
}

function route() {
  const hash = location.hash || '#/';
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts[0] === 'q' && parts[1]) return { name: 'question', id: decodeURIComponent(parts[1]) };
  if (parts[0] === 'p' && parts[1]) return { name: 'profile', id: decodeURIComponent(parts[1]) };
  if (parts[0] === 'new') return { name: 'new' };
  return { name: 'docket' };
}

function currentNav(name) {
  return name ? 'aria-current="page"' : '';
}

function shell(title, body) {
  document.title = `${title} · Stated`;
  document.getElementById('app').innerHTML = html`
    <header>
      <a class="wordmark" href="#/">Stated</a>
      <nav aria-label="League">
        <a href="#/" ${raw(currentNav(route().name === 'docket'))}>Docket</a>
        <a href="#/p/you" ${raw(currentNav(route().name === 'profile' && route().id === 'you'))}>Your record</a>
        <a href="#/new" ${raw(currentNav(route().name === 'new'))}>Put a call on record</a>
      </nav>
    </header>
    <main id="content">${raw(body)}</main>
    <footer>
      <p>Baseline is zero at 50 percent. It is positive when the call beat a coin flip and negative when it did not. A confident miss costs more than a confident hit pays. Time before the first probability scores as zero.</p>
      <p>Stayed after a miss means a negative baseline on a closed call, then a forecast on a call that opened afterward. Follows sit on a note, not on a rank. There is no season ladder.</p>
      <p>The public record is the post on X. This page keeps the sentence, the score, and the reminder. Nothing here is sent anywhere until you post it.</p>
      <details>
        <summary>Reset the example league</summary>
        <p>This deletes the calls stored in this browser and restores the five example records.</p>
        <button type="button" data-action="reset">Reset the example league</button>
      </details>
    </footer>
  `;
}

function field(name, label, control) {
  const message = errors[name];
  return html`
    <label for="${name}">${label}</label>
    ${raw(control)}
    ${message ? html`<p class="err" id="${name}-error">${message}</p>` : ''}
  `;
}

function invalid(name) {
  return errors[name] ? 'aria-invalid="true" aria-describedby="' + esc(name) + '-error"' : '';
}

function reminderBanners(personId, onlyQuestion) {
  const now = Date.now();
  return remindersFor(state, personId, now)
    .filter((item) => !onlyQuestion || item.questionId === onlyQuestion || item.aboutId === onlyQuestion)
    .map((item) => {
      const about = state.questions[item.aboutId || item.questionId];
      if (item.kind === 'evidence') {
        const evidence = state.evidence.find((e) => e.id === item.evidenceId);
        return html`<div class="banner" role="status">
          <p>A source note landed after your probability on “${about.claim}” ${evidence ? html`(${evidence.source})` : ''}. Update the number, or keep the one that is standing.</p>
          <div class="row">
            <a class="button primary" href="#/q/${about.id}">Post the update on X</a>
            <button type="button" data-action="ack" data-key="${item.key}">Keep this probability</button>
          </div>
        </div>`;
      }
      if (item.kind === 'closing') {
        return html`<div class="banner" role="status">
          <p>Updates on “${about.claim}” stop ${formatWhen(about.closeAt)}. The probability standing then is the one that scores.</p>
          <button type="button" data-action="ack" data-key="${item.key}">Leave the standing probability</button>
        </div>`;
      }
      if (item.kind === 'receipt') {
        const score = questionScores(state, about.id)?.[personId];
        return html`<div class="banner" role="status">
          <p>Recorded ${formatDay(about.resolution.at)}. ${about.resolution.note} ${score ? raw(mark(score.baseline).replace(/^/, '')) : ''}</p>
          <div class="row">
            <a class="button" href="#/q/${about.id}">Read the receipt</a>
            <button type="button" data-action="ack" data-key="${item.key}">Hide this reminder</button>
          </div>
        </div>`;
      }
      const next = state.questions[item.questionId];
      return html`<div class="banner" role="status">
        <p>The call on “${about.claim}” missed. “${next.claim}” is still open.</p>
        <div class="row">
          <a class="button primary" href="#/q/${next.id}">Post the next call on X</a>
          <button type="button" data-action="ack" data-key="${item.key}">Hide this reminder</button>
        </div>
      </div>`;
    }).join('');
}

function paper(question, now, linked) {
  const you = latestFor('you', question.id, now);
  const median = latestMedian(state, question.id, now);
  const resolved = question.resolution;
  const sentence = linked
    ? html`<p class="sentence">${question.claim}</p>`
    : html`<h1 class="sentence">${question.claim}</h1>`;
  const inner = html`
    <p class="seal">${resolved ? 'Recorded' : 'On record'}</p>
    ${raw(sentence)}
    ${resolved ? html`<p class="figure"><span>Outcome</span>${outcomeWord(resolved.outcome)}</p>` : you ? html`
      <p class="figure"><span>Your probability</span>${pct(you.p)}</p>
      <p>${median ? `Median of ${median.n} latest ${median.n === 1 ? 'call' : 'calls'}, ${pct(median.median)}.` : ''}</p>
    ` : html`
      <p class="figure"><span>${median ? `Median of ${median.n} ${median.n === 1 ? 'call' : 'calls'}` : 'No probabilities yet'}</span>${median ? pct(median.median) : '—'}</p>
      <p>No call from you yet.</p>
    `}
    <p class="quiet">${resolved ? `Recorded ${formatWhen(resolved.at)}` : `${closesIn(question.closeAt, now)} · ${formatWhen(question.closeAt)}`}</p>
  `;
  if (!linked) return html`<article class="claim">${raw(inner)}</article>`;
  return html`<a class="claim claim-link" href="#/q/${question.id}">${raw(inner)}</a>`;
}

function quoteLink(questionId) {
  return state.links?.[questionId] || '';
}

function xBuilt(question, percent, reason) {
  const rule = question.postRule || `${question.yesRule} ${question.noRule}`;
  const standing = latestFor('you', question.id, Date.now());
  const quote = quoteLink(question.id);
  if (question.resolution && !standing) {
    const word = question.resolution.outcome === 'yes' ? 'Yes' : question.resolution.outcome === 'no' ? 'No' : question.resolution.outcome;
    return {
      label: 'The receipt',
      posts: [`Recorded. ${word}.\n\n${question.resolution.note}`],
      quote,
      kind: 'receipt',
    };
  }
  if (question.resolution && standing) {
    const score = questionScores(state, question.id)?.you;
    return {
      label: 'The receipt',
      posts: [receiptPost({
        outcome: question.resolution.outcome,
        percent: Math.round(standing.p * 100),
        baseline: score ? score.baseline : 0,
        what: question.resolution.note,
      })],
      quote,
      kind: 'receipt',
    };
  }
  if (standing && Math.round(standing.p * 100) !== Number(percent)) {
    return {
      label: 'The update',
      posts: [updatePost({
        from: Math.round(standing.p * 100),
        to: percent,
        reason,
      })],
      quote,
      kind: 'update',
    };
  }
  const built = callPosts({
    claim: question.claim,
    closeLabel: closeStamp(question.closeAt),
    percent,
    rule,
  });
  return {
    label: built.split ? 'Two posts' : 'The post',
    posts: built.posts,
    quote: '',
    kind: 'call',
  };
}

function xPanel(question, percent, reason) {
  const built = xBuilt(question, percent, reason);
  const intro = built.kind === 'call'
    ? 'This is the record. Quote it to disagree. Reply with the reason. When it resolves, quote it with what happened.'
    : 'Quote the original post, so the new post sits on the sentence.';
  return html`
    <section class="xblock" data-question="${question.id}">
      <h2 id="x-label">${built.label}</h2>
      <p id="x-intro">${intro}</p>
      <div id="x-posts">${raw(xPostButtons(built))}</div>
      <label for="xurl">Link to your post, so the update can quote it</label>
      <input id="xurl" type="url" inputmode="url" placeholder="https://x.com/you/status/…" value="${quoteLink(question.id)}">
      <button type="button" data-action="save-x">Save the link</button>
      ${errors.xurl ? html`<p class="err">${errors.xurl}</p>` : ''}
    </section>
  `;
}

function xPostButtons(built) {
  return built.posts.map((text, index) => {
    const over = !fits(text);
    const verb = built.kind === 'receipt'
      ? 'Post the receipt on X'
      : built.kind === 'update'
        ? 'Post the update on X'
        : (built.posts.length > 1 && index === 1 ? 'Post the rule on X' : 'Post this on X');
    const href = xIntent(text, index === 0 ? built.quote : '');
    return html`
      <pre class="tweet">${text}</pre>
      <p class="${over ? 'err' : 'quiet'}">${text.length} / 280${over ? '. Shorten it. X cuts a post at 280 characters.' : ''}</p>
      ${over ? '' : html`<a class="button primary" data-action="post-x" data-which="${built.kind}" href="${href}" target="_blank" rel="noopener noreferrer">${verb}</a>`}
    `;
  }).join('');
}

function outcomeWord(outcome) {
  if (outcome === 'yes') return 'Yes';
  if (outcome === 'no') return 'No';
  if (outcome === 'ambiguous') return 'Ambiguous';
  if (outcome === 'annulled') return 'Annulled';
  return outcome;
}

function latestFor(personId, questionId, now) {
  const rows = state.forecasts.filter((f) => f.personId === personId && f.questionId === questionId && f.at <= now && f.at < state.questions[questionId].closeAt);
  return rows.length ? rows[rows.length - 1] : null;
}

function signalLine() {
  const signals = leagueSignals(state);
  if (!signals.missed) return 'No call has been scored yet.';
  return `${signals.stayed} of ${signals.missed} people with a negative score on a closed call have a forecast on a later call. ${signals.followsOnNotes} ${signals.followsOnNotes === 1 ? 'follow sits' : 'follows sit'} on a note.`;
}

function renderDocket() {
  const now = Date.now();
  const questions = questionList(state);
  const firstOpen = questions.find((q) => !q.resolution);
  shell('The December desk', html`
    <h1>The December desk</h1>
    <p class="lede">The record is the post on X. The sentence, the deadline, and the rule go in the post. Quote it to disagree. Quote it again when it resolves.</p>
    <p>${state.league.topic}</p>
    <p>${signalLine()}</p>
    <p class="quiet">Ada Okonkwo, Luis Ferrer, Mina Cho, Priya Raman, and Jonah Ellis are examples, so the docket is readable before your first call.</p>
    ${raw(reminderBanners('you'))}
    ${raw(notice ? `<p role="status">${esc(notice)}</p>` : '')}
    ${questions.map((question) => html`
      ${question === firstOpen ? html`<p class="quiet">Closes next</p>` : ''}
      ${question.resolution && question === questions.find((q) => q.resolution) ? html`<h2>Recorded</h2>` : ''}
      ${raw(paper(question, now, true))}
    `)}
    <h2>People</h2>
    <ul class="people">
      ${Object.values(state.people).map((person) => html`<li>${raw(nameLink(person.id))}</li>`)}
    </ul>
  `);
}

function followersOf(forecastId) {
  return state.follows.filter((f) => f.forecastId === forecastId);
}

function renderQuestion(id) {
  const question = state.questions[id];
  if (!question) {
    shell('Missing call', html`<h1>That call is not on the docket.</h1><p><a href="#/">Back to the docket</a></p>`);
    return;
  }
  const now = Date.now();
  const scores = questionScores(state, id);
  const tape = state.forecasts.filter((f) => f.questionId === id);
  shell(question.claim, html`
    ${raw(reminderBanners('you', id))}
    ${raw(notice ? `<p role="status">${esc(notice)}</p>` : '')}
    ${raw(paper(question, now, false))}
    ${raw(xPanel(
      question,
      draft.percent ? Number(draft.percent) : (latestFor('you', question.id, now) ? Math.round(latestFor('you', question.id, now).p * 100) : 50),
      draft.reasoning || '',
    ))}
    <h2>Rule</h2>
    <dl>
      <div class="rule"><dt>Yes</dt><dd>${question.yesRule}</dd></div>
      <div class="rule"><dt>No</dt><dd>${question.noRule}</dd></div>
      <div class="rule"><dt>Ambiguous</dt><dd>${question.ambiguousRule} No scores are written.</dd></div>
      <div class="rule"><dt>Annulled</dt><dd>${question.annulledRule} No scores are written.</dd></div>
      <div class="rule"><dt>Source</dt><dd>${question.sourceName}${question.sourceUrl ? html` · <a href="${question.sourceUrl}" target="_blank" rel="noopener noreferrer">Open the source</a>` : ''}</dd></div>
      <div class="rule"><dt>Closes</dt><dd>${formatWhen(question.closeAt)}. Updates stop then.</dd></div>
      <div class="rule"><dt>Resolve by</dt><dd>${formatWhen(question.resolveBy)}. The clerk records the outcome from the source. The date is a prompt, not a promise that the source will have spoken.</dd></div>
    </dl>
    <div class="row">
      <button type="button" data-action="copy" data-question="${question.id}" data-mode="${question.resolution ? 'receipt' : 'call'}">${question.resolution ? 'Copy the receipt' : 'Copy the call'}</button>
    </div>
    ${scores ? html`
      <h2>Scores</h2>
      <ul class="scores">
        ${Object.keys(scores).sort((a, b) => personName(a).localeCompare(personName(b))).map((personId) => html`
          <li>
            <span>${raw(nameLink(personId))}</span>
            ${raw(mark(scores[personId].baseline))}
            <span class="quiet peer">Peer ${signed(scores[personId].peer)}</span>
          </li>
        `)}
      </ul>
      <p class="quiet">Baseline is time-weighted from open to close. Peer is your log score against the other people on this call. The peers sum to zero.</p>
    ` : ''}
    ${question.resolution ? html`
      <h2>What happened</h2>
      <p>${question.resolution.note}</p>
      ${question.resolution.sourceUrl ? html`<p><a href="${question.resolution.sourceUrl}" target="_blank" rel="noopener noreferrer">Source for the outcome</a></p>` : ''}
    ` : html`
      <h2>Your probability</h2>
      <p>This stores the number on the sentence above. A later update adds a line. It does not rewrite this one.</p>
      <form data-form="forecast">
        <input type="hidden" name="questionId" value="${question.id}">
        ${raw(field('name', 'Name on the record', `<input id="name" name="name" autocomplete="nickname" maxlength="40" value="${esc(draft.name ?? (state.people.you.name === 'You' ? '' : state.people.you.name))}" ${invalid('name')}>`))}
        ${raw(field('p', 'Probability, percent', `<input id="p" name="percent" type="number" inputmode="numeric" min="1" max="99" step="1" value="${esc(draft.percent || (latestFor('you', question.id, now) ? String(Math.round(latestFor('you', question.id, now).p * 100)) : '50'))}" ${invalid('p')}>`))}
        ${raw(field('reasoning', 'Reason for this number', `<textarea id="reasoning" name="reasoning" maxlength="1200" ${invalid('reasoning')}>${esc(draft.reasoning || '')}</textarea>`))}
        <p class="err">${errors.form || ''}</p>
        <button class="primary" type="submit">Put this probability on record</button>
      </form>
    `}
    <h2>Tape</h2>
    ${tape.length ? html`<ol class="tape">
      ${tape.map((forecast) => {
        const followers = followersOf(forecast.id);
        const mine = followers.some((f) => f.followerId === 'you');
        return html`<li id="note-${forecast.id}">
          <div class="tape-head">
            <span class="when">${formatWhen(forecast.at)} · ${raw(nameLink(forecast.personId))}</span>
            <span class="pct">${pct(forecast.p)}</span>
          </div>
          <p class="note">${forecast.reasoning}</p>
          ${followers.length ? html`<p class="quiet">${nameList(followers.map((f) => personName(f.followerId)))} ${followers.length === 1 ? 'follows' : 'follow'} this note.</p>` : ''}
          ${forecast.personId === 'you' ? '' : html`<button type="button" data-action="follow" data-forecast="${forecast.id}" aria-pressed="${mine ? 'true' : 'false'}" ${raw(mine ? 'disabled' : '')}>${mine ? 'Following this note' : 'Follow this note'}</button>`}
        </li>`;
      })}
    </ol>` : html`<p>No probabilities yet. The first line on the tape is the first thing someone is willing to be scored on.</p>`}
    <h2>Source notes</h2>
    ${state.evidence.filter((e) => e.questionId === id).map((evidence) => html`
      <article>
        <p class="when">${formatWhen(evidence.at)} · ${evidence.source}</p>
        <p>${evidence.note}</p>
        ${evidence.url ? html`<p><a href="${evidence.url}" target="_blank" rel="noopener noreferrer">Open the source</a></p>` : ''}
      </article>
    `)}
    ${question.resolution ? '' : html`
      <form data-form="evidence">
        <input type="hidden" name="questionId" value="${question.id}">
        ${raw(field('source', 'Source name', `<input id="source" name="source" value="${esc(draft.source || '')}" ${invalid('source')}>`))}
        ${raw(field('url', 'Source link, optional', `<input id="url" name="url" type="url" inputmode="url" placeholder="https://" value="${esc(draft.url || '')}" ${invalid('url')}>`))}
        ${raw(field('note', 'What the source said', `<textarea id="note" name="note" ${invalid('note')}>${esc(draft.note || '')}</textarea>`))}
        <button type="submit">Add the source note</button>
      </form>
      <h2>Record what happened</h2>
      <p>Whoever is holding this browser can record the outcome. A hosted league would reserve that for a clerk. Ambiguous and Annulled write no scores.</p>
      <form data-form="resolve">
        <input type="hidden" name="questionId" value="${question.id}">
        <div class="check"><input type="radio" id="out-yes" name="outcome" value="yes" ${raw(draft.outcome === 'yes' ? 'checked' : '')}><label for="out-yes">${question.yesRule}</label></div>
        <div class="check"><input type="radio" id="out-no" name="outcome" value="no" ${raw(draft.outcome === 'no' ? 'checked' : '')}><label for="out-no">${question.noRule}</label></div>
        <div class="check"><input type="radio" id="out-amb" name="outcome" value="ambiguous" ${raw(draft.outcome === 'ambiguous' ? 'checked' : '')}><label for="out-amb">Ambiguous. No scores will be written.</label></div>
        <div class="check"><input type="radio" id="out-ann" name="outcome" value="annulled" ${raw(draft.outcome === 'annulled' ? 'checked' : '')}><label for="out-ann">Annulled. No scores will be written.</label></div>
        ${errors.outcome ? html`<p class="err">${errors.outcome}</p>` : ''}
        ${raw(field('resolveNote', 'What happened', `<textarea id="resolveNote" name="resolveNote" ${invalid('resolveNote')}>${esc(draft.resolveNote || '')}</textarea>`))}
        ${raw(field('sourceUrl', 'Link to the source, optional', `<input id="sourceUrl" name="sourceUrl" type="url" inputmode="url" placeholder="https://" value="${esc(draft.sourceUrl || '')}" ${invalid('sourceUrl')}>`))}
        <button class="primary" type="submit">Record what happened</button>
      </form>
    `}
  `);
}

function renderProfile(id) {
  const profile = profileOf(state, id);
  if (!profile) {
    shell('Missing record', html`<h1>That record is not on the docket.</h1><p><a href="#/">Back to the docket</a></p>`);
    return;
  }
  const { person } = profile;
  const buckets = profile.buckets.filter((bucket) => bucket.n > 0);
  shell(person.name, html`
    <h1>${person.name}${person.sample ? html`<span class="example">Example</span>` : ''}</h1>
    <p>${profile.scoredCount
      ? `Average baseline ${signed(profile.avg)} across ${profile.scoredCount} scored ${profile.scoredCount === 1 ? 'call' : 'calls'}.`
      : 'No scored call yet.'}
      ${profile.missed
        ? (profile.stayed
          ? ` Missed ${profile.missed}, and forecast again after ${profile.stayed}.`
          : ` Missed ${profile.missed} and has no later forecast.`)
        : ''}</p>
    ${buckets.length ? html`
      <h2>Where the probability stood at the close</h2>
      <table>
        <thead><tr><th>Probability</th><th>Calls</th><th>Resolved yes</th></tr></thead>
        <tbody>
          ${buckets.map((bucket) => html`<tr><td>${bucket.from}–${bucket.to === 100 ? '99' : bucket.to}%</td><td>${bucket.n}</td><td>${bucket.yes}</td></tr>`)}
        </tbody>
      </table>
      <p class="quiet">${profile.scoredCount === 1 ? 'One closed call is not a calibration curve.' : 'Each row is the probability standing at the close, not the time-weighted path.'}</p>
    ` : ''}
    <h2>Calls</h2>
    ${profile.calls.map((call) => html`
      <article>
        <p><a href="#/q/${call.question.id}">${call.question.claim}</a></p>
        <p class="quiet">${call.forecasts.map((f) => `${formatDay(f.at)} ${pct(f.p)}`).join(' · ')} ${call.score ? raw(mark(call.score.baseline)) : html`<span class="quiet">Still open</span>`}</p>
        ${call.followed.length ? html`<p class="quiet">${call.followed.length} ${call.followed.length === 1 ? 'follow is' : 'follows are'} on ${person.name}’s notes here.</p>` : ''}
      </article>
    `)}
    <h2>Notes ${person.name} follows</h2>
    ${profile.following.length ? html`<ul class="people">
      ${profile.following.map((follow) => {
        const forecast = state.forecasts.find((f) => f.id === follow.forecastId);
        return html`<li>${raw(nameLink(follow.personId))} on <a href="#/q/${follow.questionId}">${forecast ? forecast.reasoning.slice(0, 90) : 'a note'}</a></li>`;
      })}
    </ul>` : html`<p>No followed notes yet.</p>`}
  `);
}

function renderNew() {
  shell('Put a call on record', html`
    <h1>Put a call on record</h1>
    <p>Write the sentence, the deadline, and the rule for deciding it. The probability comes on the next page, from whoever is willing to be scored.</p>
    <form data-form="question">
      ${raw(field('claim', 'The sentence', `<textarea id="claim" name="claim" ${invalid('claim')}>${esc(draft.claim || '')}</textarea>`))}
      ${raw(field('yesRule', 'What Yes means', `<textarea id="yesRule" name="yesRule" ${invalid('yesRule')}>${esc(draft.yesRule || '')}</textarea>`))}
      ${raw(field('noRule', 'What No means', `<textarea id="noRule" name="noRule" ${invalid('noRule')}>${esc(draft.noRule || '')}</textarea>`))}
      ${raw(field('ambiguousRule', 'When it is ambiguous', `<textarea id="ambiguousRule" name="ambiguousRule" ${invalid('ambiguousRule')}>${esc(draft.ambiguousRule || '')}</textarea>`))}
      ${raw(field('annulledRule', 'When it is annulled', `<textarea id="annulledRule" name="annulledRule" ${invalid('annulledRule')}>${esc(draft.annulledRule || '')}</textarea>`))}
      ${raw(field('sourceName', 'Source that decides it', `<input id="sourceName" name="sourceName" value="${esc(draft.sourceName || '')}" ${invalid('sourceName')}>`))}
      ${raw(field('sourceUrl', 'Link to the source, optional', `<input id="sourceUrl" name="sourceUrl" type="url" inputmode="url" placeholder="https://" value="${esc(draft.sourceUrl || '')}" ${invalid('sourceUrl')}>`))}
      ${raw(field('closeAt', 'Updates stop', `<input id="closeAt" name="closeAt" type="datetime-local" value="${esc(draft.closeAt || '')}" ${invalid('closeAt')}>`))}
      ${raw(field('resolveBy', 'Resolve by', `<input id="resolveBy" name="resolveBy" type="datetime-local" value="${esc(draft.resolveBy || '')}" ${invalid('resolveBy')}>`))}
      <p class="quiet">Times use this computer’s clock. The league deadlines above are written in Eastern time.</p>
      <button class="primary" type="submit">Put it on record</button>
    </form>
  `);
}

function render() {
  const current = route();
  const key = `${current.name}:${current.id || ''}`;
  const changed = key !== lastRoute;
  if (changed) {
    errors = {};
    if (!preserveNotice) notice = '';
    preserveNotice = false;
    draft = {};
    lastRoute = key;
  }
  if (current.name === 'question') renderQuestion(current.id);
  else if (current.name === 'profile') renderProfile(current.id);
  else if (current.name === 'new') renderNew();
  else renderDocket();
  if (changed) {
    const heading = document.querySelector('h1');
    if (heading) {
      heading.tabIndex = -1;
      heading.focus();
    }
  }
}

function formData(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function showError(err) {
  if (!(err instanceof RecordError)) throw err;
  errors = { [err.field || 'form']: err.message };
  render();
  const invalidField = document.querySelector('[aria-invalid="true"], .err');
  if (invalidField) invalidField.focus();
}

function onSubmit(event) {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  event.preventDefault();
  draft = formData(form);
  errors = {};
  try {
    let next = state;
    if (form.dataset.form === 'forecast') {
      const name = String(draft.name || '').trim();
      if (name && name !== next.people.you.name) next = setName(next, 'you', name);
      else if (!name && next.people.you.name === 'You') {
        throw new RecordError('Use the name you want on the record.', 'name');
      }
      next = addForecast(next, {
        questionId: draft.questionId,
        personId: 'you',
        p: draft.percent,
        reasoning: draft.reasoning,
        at: Date.now(),
      });
      notice = 'Probability recorded. The line is on the tape.';
    } else if (form.dataset.form === 'evidence') {
      const prior = next.forecasts.filter((f) => f.questionId === draft.questionId).map((f) => f.at);
      const at = Math.max(Date.now(), prior.length ? Math.max(...prior) + 1 : Date.now());
      next = addEvidence(next, {
        questionId: draft.questionId,
        source: draft.source,
        url: draft.url,
        note: draft.note,
        at,
      });
      notice = 'Source note added. Anyone with a standing probability will be asked to update or keep it.';
    } else if (form.dataset.form === 'resolve') {
      if (!draft.outcome) throw new RecordError('Record Yes, No, Ambiguous, or Annulled.', 'outcome');
      next = resolveQuestion(next, {
        questionId: draft.questionId,
        outcome: draft.outcome,
        note: draft.resolveNote,
        sourceUrl: draft.sourceUrl,
        at: Date.now(),
      });
      notice = 'Outcome recorded.';
    } else if (form.dataset.form === 'question') {
      const closeAt = new Date(draft.closeAt).getTime();
      const resolveBy = new Date(draft.resolveBy).getTime();
      if (Number.isFinite(closeAt) && closeAt <= Date.now()) {
        throw new RecordError('The close has to be in the future.', 'closeAt');
      }
      next = addQuestion(next, {
        authorId: 'you',
        claim: draft.claim,
        yesRule: draft.yesRule,
        noRule: draft.noRule,
        ambiguousRule: draft.ambiguousRule,
        annulledRule: draft.annulledRule,
        sourceName: draft.sourceName,
        sourceUrl: draft.sourceUrl,
        openAt: Date.now(),
        closeAt,
        resolveBy,
      });
      const created = questionList(next).find((q) => q.claim.trim() === String(draft.claim || '').trim());
      state = next;
      save();
      draft = {};
      notice = 'The call is on the docket. Add a probability if you are willing to be scored on it.';
      preserveNotice = true;
      location.hash = `#/q/${created.id}`;
      return;
    }
    state = next;
    save();
    draft = {};
    render();
  } catch (err) {
    showError(err);
  }
}

function statusUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    const host = url.hostname.replace(/^www\./, '');
    if (url.protocol !== 'https:' || !['x.com', 'twitter.com'].includes(host)) return '';
    if (!/\/status\/\d+/.test(url.pathname)) return '';
    return url.toString();
  } catch {
    return '';
  }
}

function commitForecast() {
  const form = document.querySelector('[data-form="forecast"]');
  if (!form) return true;
  const data = formData(form);
  draft = data;
  errors = {};
  try {
    let next = state;
    const name = String(data.name || '').trim();
    if (name && name !== next.people.you.name) next = setName(next, 'you', name);
    const standing = latestFor('you', data.questionId, Date.now());
    const same = standing
      && Math.round(standing.p * 100) === Number(data.percent)
      && standing.reasoning === String(data.reasoning || '').trim();
    if (!same) {
      next = addForecast(next, {
        questionId: data.questionId,
        personId: 'you',
        p: data.percent,
        reasoning: data.reasoning,
        at: Date.now(),
      });
    }
    state = next;
    save();
    return true;
  } catch (err) {
    showError(err);
    return false;
  }
}

function paintX() {
  const section = document.querySelector('.xblock');
  const form = document.querySelector('[data-form="forecast"]');
  if (!section || !form) return;
  const question = state.questions[section.dataset.question];
  if (!question) return;
  const percent = Number(form.querySelector('[name="percent"]')?.value || 50);
  const reason = form.querySelector('[name="reasoning"]')?.value || '';
  const built = xBuilt(question, percent, reason);
  const label = document.getElementById('x-label');
  const intro = document.getElementById('x-intro');
  const posts = document.getElementById('x-posts');
  if (label) label.textContent = built.label;
  if (intro) {
    intro.textContent = built.kind === 'call'
      ? 'This is the record. Quote it to disagree. Reply with the reason. When it resolves, quote it with what happened.'
      : 'Quote the original post, so the new post sits on the sentence.';
  }
  if (posts) posts.innerHTML = xPostButtons(built);
}

async function onClick(event) {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const action = button.dataset.action;
  try {
    if (action === 'post-x') {
      if (!commitForecast()) event.preventDefault();
      return;
    }
    if (action === 'save-x') {
      const id = document.querySelector('.xblock')?.dataset.question;
      const saved = statusUrl(document.getElementById('xurl')?.value);
      if (!id || !saved) {
        errors = { xurl: 'Paste the link to the post, like https://x.com/you/status/123.' };
        render();
        return;
      }
      state = { ...state, links: { ...(state.links || {}), [id]: saved } };
      save();
      notice = 'Link saved. The update and the receipt will quote that post.';
      render();
      return;
    }
    if (action === 'reset') {
      state = seedState(Date.now());
      save();
      notice = 'Example league restored.';
      errors = {};
      draft = {};
      render();
      return;
    }
    if (action === 'ack') {
      state = acknowledge(state, 'you', button.dataset.key);
      save();
      render();
      return;
    }
    if (action === 'follow') {
      const before = state.follows.length;
      state = followNote(state, { followerId: 'you', forecastId: button.dataset.forecast, at: Date.now() });
      save();
      notice = state.follows.length === before ? 'You already follow this note.' : 'Following this note.';
      render();
      return;
    }
    if (action === 'copy') {
      const question = state.questions[button.dataset.question];
      const you = latestFor('you', question.id, Date.now());
      const median = latestMedian(state, question.id, Date.now());
      const lines = [
        question.resolution ? 'Recorded' : 'On record',
        question.claim,
        you ? `I say ${pct(you.p)}.` : (median ? `Median of latest calls: ${pct(median.median)}.` : 'No probability yet.'),
        question.resolution
          ? `Outcome: ${outcomeWord(question.resolution.outcome)}. ${question.resolution.note}`
          : `Closes ${formatWhen(question.closeAt)}.`,
        `Yes: ${question.yesRule}`,
        `No: ${question.noRule}`,
        `Source: ${question.sourceName}${question.sourceUrl ? ` ${question.sourceUrl}` : ''}`,
      ];
      await navigator.clipboard.writeText(lines.join('\n'));
      notice = question.resolution ? 'Receipt copied.' : 'Call copied.';
      render();
    }
  } catch (err) {
    if (err instanceof RecordError) showError(err);
    else {
      notice = 'The clipboard blocked the copy. The call is still on this page.';
      render();
    }
  }
}

document.addEventListener('submit', onSubmit);
document.addEventListener('click', onClick);
document.addEventListener('input', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  if (target.closest('[data-form="forecast"]')) paintX();
});
window.addEventListener('hashchange', () => {
  lastRoute = '';
  render();
});
render();
