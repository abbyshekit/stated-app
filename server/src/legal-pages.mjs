// The Terms of Service and the Privacy Policy. Every statement here describes
// what the code does; change the text in the same edit as the behaviour.
import { html } from './html.mjs';

export const LEGAL_EFFECTIVE = '12 November 2026';
const REPO = 'https://github.com/abbyshekit/stated-app';

function contact(bot) {
  return html`<p>Open an issue at <a href="${REPO}/issues" rel="noopener noreferrer">github.com/abbyshekit/stated-app</a>, or reply to <a href="https://x.com/${bot}" rel="noopener noreferrer">@${bot}</a> on X. For a private request, such as deleting your account, open an issue saying only that you have one, and we will reply there with a private way to reach us.</p>`;
}

export function termsPage({ bot }) {
  return html`
    <article class="legal">
      <h1>Terms of Service</h1>
      <p class="quiet">Effective ${LEGAL_EFFECTIVE}</p>
      <p>These terms cover Stated: this site, the @${bot} bot on X, and the NEAR accounts and contracts Stated runs. By signing in, or by betting through the bot, you agree to them. “We” means the people who run Stated; “you” means you.</p>

      <h2>Test NEAR only</h2>
      <p>Stated runs on NEAR testnet, and every stake is test NEAR. Test NEAR has no monetary value: you cannot buy it from us or sell it to us, and winning it is not a prize. Stated takes no share of any pot. The escrow contract keeps a small storage fee, in test NEAR, from whoever proposes a bet; the bet’s page shows it. NEAR testnet can be reset, and accounts, balances and history on it can disappear. If we ever offer bets in real NEAR, they will come with their own terms first; these terms do not cover them.</p>

      <h2>Who can use Stated</h2>
      <p>You must be at least 18 and able to make a binding agreement, and using Stated must be lawful where you are.</p>

      <h2>How a bet works</h2>
      <p>One person offers a bet by replying to a post on X, or on this site, and another person takes it. The post’s words, the deadline and the stake are the bet’s terms, and they cannot change once both sides are in. Each bet’s page shows its rules, including who referees it. Where a bet’s page and these terms differ, the bet’s page governs that bet.</p>
      <p>Stated makes each bettor a NEAR account named after their X handle and holds its key, encrypted, until the bettor claims the account. A NEAR contract with no access keys holds both stakes.</p>
      <p>After the deadline, three AI models, each running in its own NEAR AI Cloud enclave, decide from the evidence: prices Stated fetches, or links the bettors post. A ruling counts only if all three agree, each with at least 80% confidence. If they do not, a new jury tries; after three undecided juries both stakes go back.</p>
      <p>A ruling then goes to Stated Court, a Sputnik DAO on NEAR that referees the bet. Its council can vote the ruling down within ten minutes, but it has no duty to review any ruling. After that the Court settles the contract, and the winner can withdraw the pot. If no ruling pays out, each side can take its stake back seven days after the bet’s result time.</p>

      <h2>Rulings are final</h2>
      <p>The jury can be wrong. When you bet, you accept as final the ruling that settles the bet on NEAR, and you agree that we are not responsible for a ruling you think is wrong.</p>

      <h2>Your account and its key</h2>
      <p>Until you claim your NEAR account, Stated holds its key and signs your bets and withdrawals for you. You can claim it from your wallet page by adding a key of your own; Stated then removes its key and erases its stored copy. After that only you control the account, and we cannot recover it. The test NEAR we put into accounts is ours to give, and we can limit, pause or stop it.</p>

      <h2>What you post</h2>
      <p>Your posts stay yours, and X’s terms govern them. You give us a free, worldwide, non-exclusive licence to copy, store, show and process the posts, links and evidence you send to Stated or its bot, so that we can run bets, publish rulings and keep their record for as long as Stated runs. You are responsible for what you post and for having the right to post it.</p>

      <h2>Rules of use</h2>
      <p>Do not:</p>
      <ul>
        <li>break the law, or use Stated to harass, threaten or defame anyone or to expose anyone’s private information;</li>
        <li>post evidence you know is false, or try to steer the jury with instructions hidden in a page or a post;</li>
        <li>use several X accounts to bet against yourself or to collect more test NEAR than one account gets;</li>
        <li>overload, attack or scrape Stated, its contracts or its hosting, or test their security beyond normal use without asking us first;</li>
        <li>sell test NEAR from Stated, or promise anyone real value for it.</li>
      </ul>
      <p>We can refuse or call off a bet, pause an account, or remove content when it breaks these terms, or when security or the law requires it.</p>

      <h2>Open source</h2>
      <p>Stated’s code is published under the MIT License at <a href="${REPO}" rel="noopener noreferrer">github.com/abbyshekit/stated-app</a>. That licence covers the code; these terms cover the service we run.</p>

      <h2>No warranty</h2>
      <p>Stated is a test service provided “as is” and “as available”. We do not promise that it will work, stay available, rule correctly, or keep your data or test NEAR, and to the fullest extent the law allows we disclaim all implied warranties. The AI models, NEAR, NEAR AI Cloud, X and the sites behind evidence links are run by others, and we are not responsible for them.</p>

      <h2>Limits on our liability</h2>
      <p>To the fullest extent the law allows, we are not liable for any indirect, incidental, special, consequential or punitive loss, or for lost data, profits or goodwill, and our total liability for all claims about Stated is limited to CAD 100. These limits do not apply to fraud, gross negligence or wilful misconduct, or to anything else the law does not allow us to limit.</p>

      <h2>Your responsibility to us</h2>
      <p>If someone else makes a claim against us because you broke these terms, or because of something you posted, you will cover our reasonable losses and costs from that claim.</p>

      <h2>Changes and ending</h2>
      <p>We can change these terms by posting a new version here with a new date. A change applies from when it is posted, but it does not change the post, deadline, stake or settlement of a bet already made. We can change, pause or end Stated at any time. You can stop using it at any time.</p>

      <h2>Law and disputes</h2>
      <p>The laws of Ontario and the federal laws of Canada that apply there govern these terms, and the courts in Toronto, Ontario decide disputes about them, unless the law where you live gives you the right to bring a claim there. Before bringing a claim, tell us about it and give us 30 days to resolve it.</p>

      <h2>General</h2>
      <p>These terms, with each bet’s rules, are the whole agreement between you and us about Stated. If part of them cannot be enforced, the rest still applies. Not enforcing a term is not a waiver of it. You cannot transfer these terms; we can transfer them to whoever runs Stated next. Nothing in these terms limits rights you have under laws that cannot be excluded by agreement.</p>

      <h2>Contact</h2>
      ${contact(bot)}
      <p>How Stated handles personal information is in the <a href="/privacy">Privacy Policy</a>.</p>
    </article>`;
}

export function privacyPage({ bot, sessionDays, textPolicy }) {
  return html`
    <article class="legal">
      <h1>Privacy Policy</h1>
      <p class="quiet">Effective ${LEGAL_EFFECTIVE}</p>
      <p>This policy covers Stated: this site and the @${bot} bot on X.</p>

      <h2>Much of Stated is public by design</h2>
      <p>A bet made on X is a set of public posts, and the bot’s replies name the bettors. A published bet’s page shows the post, the stake, the evidence and the ruling, and the X handle of each side that bet from an X account. Its ruling’s record, including what each model was sent and what it answered, is published for anyone to check, except jurors’ reasons when the ruling also covered a private bet. A bet made by replying on X is published; a bet started on this site is published only when its creator chooses. Before publication or after its creator takes it off public pages, its bettors can see its page, and signed-in people with its link can also see it while it is an open invitation.</p>
      <p>Each bettor’s NEAR account is named after their X handle. NEAR testnet records every account, deposit, ruling and payout publicly, and Stated Court’s proposals and votes are public there too. We cannot delete what is on NEAR, and posts on X are governed by X.</p>

      <h2>What Stated collects</h2>
      <ul>
        <li><b>Your X profile.</b> When you sign in: your X user ID, handle, display name and profile picture. Stated asks X only for permission to read; it cannot post, follow or message as you.</li>
        <li><b>Posts to the bot.</b> Posts that mention @${bot}, the posts they reply to, and their authors’ public profile details.</li>
        <li><b>Bets.</b> Each bet’s terms, sides, stakes and dates, its NEAR transactions, the links bettors post as evidence with the text read from them, and the ruling record.</li>
        <li><b>Your NEAR account.</b> Its name, and the key Stated holds until you claim the account, stored encrypted with AES-256-GCM.</li>
        <li><b>Saves.</b> For each prediction you save: the link, the post or article ID, the author, the dates, and how its deadline and probability were read; your collections, visibility choices, private notes and reminder dates; your inbox. ${textPolicy === 'all'
          ? 'This server is set to store the words of every saved post too.'
          : 'For an X post saved privately, Stated keeps the link and the terms, not the words. The words are stored only while a public record shows the post.'} Sentences you pick from articles are stored with a link to the article.</li>
        <li><b>Cookies.</b> Stated sets only its own cookies: one that keeps you signed in (${sessionDays} days), one used during sign-in (15 minutes), one that remembers which link brought you here until you sign up (30 days), and a random visitor cookie that counts a visit to a public page once a day (a year). None is shared with anyone, and Stated runs no advertising or third-party tracking.</li>
        <li><b>Your IP address.</b> The server holds it in memory to limit how fast one address can load heavy pages. It is not written to the database, and it is dropped when the server restarts or needs the room. Railway, which hosts Stated, handles every request first and keeps its own records under its own terms.</li>
      </ul>

      <h2>How Stated uses it</h2>
      <p>To run bets and the bot, settle bets and publish their rulings, show your pages, keep Stated secure, stop abuse, and count visits to public pages. We do not sell personal information or use it for advertising.</p>

      <h2>Who else receives it</h2>
      <ul>
        <li><b>X.</b> Stated reads posts and profiles and posts the bot’s replies through the X API. Pages show a letter or a stored image; your browser does not load profile pictures from X.</li>
        <li><b>NEAR AI Cloud.</b> The jury is sent the claim and the post’s link, its date and deadline, each bet’s ID and terms fingerprint, and the evidence. It is not given the bettors’ names or accounts, though the post’s link shows who wrote the post.</li>
        <li><b>NEAR.</b> Transactions go through public NEAR RPC providers and are public on the chain.</li>
        <li><b>The sites behind evidence links.</b> Stated’s server fetches each link a bettor posts. The site sees a request from Stated’s server, not from the bettor.</li>
        <li><b>Coinbase and NVIDIA.</b> Stated fetches public prices from Coinbase and checks the jury’s GPU evidence with NVIDIA. Neither is sent personal information.</li>
        <li><b>Railway.</b> Railway hosts Stated’s server and database.</li>
        <li><b>The law.</b> We disclose information when the law requires it, or when it is needed to protect people or Stated.</li>
      </ul>

      <h2>What X learns when you read a private save</h2>
      <p>On a private save’s page you can ask to see that one post’s words. Stated’s server then requests the post from X’s public oEmbed service. X sees a request from Stated’s server for that post at that time. It is not told who you are, and Stated never requests several of your posts together, but if you open several posts one after another, X sees those requests close together. The words are kept in the server’s memory for up to an hour, shared by everyone who asks for the same post, and are never written to the database. A check that finds the post protected or deleted drops that copy then. Until the check, a cached copy can remain for up to an hour.</p>

      <h2>Who can see your saves</h2>
      <p>Saves start private unless, with a public profile, you choose public for a save or set public as your default in settings. Your profile starts private, except that your profile page lists, under your X handle, the published bets you took part in. If you make your profile public, only the saves you choose are shown, on pages, search, exports, previews and statistics. Private notes and reminder dates are never shown to anyone else. Reviewers who record outcomes see each claim and can open its post on X, which shows who wrote it. For a claim no one has made public, they are not shown who saved it, how many saved it, or any terms a saver confirmed.</p>

      <h2>How long it is kept</h2>
      <ul>
        <li>Bets, rulings and their evidence are kept for as long as Stated runs, because they are the record that lets anyone check a ruling.</li>
        <li>Your profile is kept while you have an account, and each save until you remove it.</li>
        <li>Stated checks saved posts against X. When X reports a post deleted, or a check finds it deleted or its account protected, Stated marks it unavailable and stops storing and showing its words, including in your inbox.</li>
      </ul>

      <h2>Your choices</h2>
      <ul>
        <li>Choose what to make public, and make it private again, from your settings and each save’s page. A bet’s creator can take a published bet off public pages; what is on NEAR and X stays.</li>
        <li>Download your profile as JSON at <a href="/me/export.json">/me/export.json</a>, following pagination.next until it is null. When historyContinues is true, the next page repeats the saves with their next batch of revisions.</li>
        <li>Remove a save from its page unless a bet relies on it; those saves stay to protect the stakes.</li>
        <li>Claim your NEAR account from your wallet page. Stated then erases its copy of the key.</li>
        <li>Ask us to delete your account. We will delete your saves, notes and inbox and remove your name and picture from your profile. We keep what is on NEAR or X, the records of bets you took part in, and what we must keep for security or by law.</li>
        <li>Depending on where you live, you may have rights to see, correct or delete your information, or to object to how it is used. To use them, ask us.</li>
      </ul>

      <h2>Direct messages</h2>
      <p>The bot sends direct messages only if you turn that on and have messaged it first. Updates always reach your private inbox here.</p>

      <h2>Security</h2>
      <p>Sign-in goes through X, and account keys are stored encrypted. We publish our own security review of the code, with the problems still open, in the repository. No system is perfectly secure.</p>

      <h2>Children</h2>
      <p>Stated is for adults. We do not knowingly collect information from anyone under 18. If you believe we have, tell us, and we will delete it as described under Your choices.</p>

      <h2>Changes</h2>
      <p>We will post any change here with a new date.</p>

      <h2>Contact</h2>
      ${contact(bot)}
      <p>The rules for using Stated are in the <a href="/terms">Terms of Service</a>.</p>
    </article>`;
}
