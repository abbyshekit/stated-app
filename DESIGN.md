# Stated design: Marked

The selected direction is Marked, confirmed on 10 November 2026. It replaces the earlier certificate direction. The implemented styles are in `server/public/skin.css`; Bet presentation lives in `server/src/marked.mjs` and `server/src/bet-view.mjs`.

## The idea

The post is the object, shown the way it looked on X: face, name, handle, the words. The Result is a mark on those words.

- **Came true:** a highlighter bar over the words, line by line. On the page that opens a Result it sweeps across once.
- **Did not:** a line through the words.
- **Still open:** the words, and how long until we find out.

Yellow means "this prediction came true" and nothing else. It appears on the highlighted words, the word Yes, and the winner's ring on a Prediction page whose Result is Yes. The Yes share image is the only surface that turns fully yellow. A Bet settled because both people agreed never uses yellow, on its page or its share image, even when the agreed outcome is yes: an agreement is not a Result. A Bet made from a reply is different. It is settled by the referee from the post's recorded Result, so when that Result is Yes its page marks the words and rings the winner in yellow, and its share image is yellow with the word Yes, exactly as the Prediction's are.

## Hard constraints

- Node server-rendered HTML, ordinary forms with a CSRF field, PostgreSQL, strict CSP (no inline styles or scripts), existing authorization and explicit publication. Assets are self-hosted.
- Source wording, a Bet's agreed proposition, the factual Result and escrow settlement are four different things. A source author holds a Bet seat only if they actually join. Private content stays private; a withheld private post is never marked, because the sentence shown in its place is ours.
- Render persisted and verified state only. No fictional participants, fabricated badges or Bet fixtures in the live application. A wallet return stays pending until finalized verification.
- 320px through desktop, both colour modes (system preference), keyboard access, reduced motion, 44px targets including text links.

## Tokens (`server/public/skin.css`)

| Token | Light | Dark |
| --- | --- | --- |
| --ground | #FFFFFF | #000000 |
| --ink | #0F1419 | #E7E9EA |
| --dim | #536471 | #8B98A5 |
| --line | #E6EBEE | #2F3336 |
| --lift | #EFF3F4 | #16181C |
| --sel | #F0F3F4 | #1D2024 |
| --err | #C4281C | #FF7A6B |
| --mark | #FFE45C | #FFE45C |
| --on-mark | #0F1419 | #0F1419 |
| --mark-ring | #E0B000 | --mark |
| --x | #1D9BF0 | #1D9BF0 |

Every colour goes through a token. Preserve the stylesheet tokens and run the repository's regression tests when changing them.

## Type

One family: the system sans (`--sans`), as X uses. No display face, no monospace outside a literal hash or code value, no labels in capitals, no tracked text.

| Role | Size | Weight |
| --- | --- | --- |
| Wordmark | 22px | 800 |
| The words on a Prediction page | 28px (22px at 320) | 400 |
| The words on a Bet or ruling page | 28px; 24px over 120 characters (both 22px at 320); 20px over 200 (18px below 360) | 400 |
| The words in a list | 16px | 400 |
| Yes / No / Undecided on a ruling page | 22px (20px at 320); 18px for posts over 200 characters (16px below 360), always smaller than the words | 600 |
| Yes / No on the home feature | 18px (16px below 360), smaller than the words | 600 |
| Stake figure | 28px | 600 |
| Body and names | 15 to 17px | 400 / 700 |
| Supporting lines | 14px | 400, `--dim` |

The words are the largest thing on a Prediction page. Yes and No sit beside the date, smaller than the words.

A Bet decided by the models carries the same mark as its ruling page: yellow highlight on the words for Yes, a strike through for No. The Bet's agreed text and the signed ruling material stay unchanged; presentation adds the mark. A settlement by agreement stays unmarked.

## Layout

- One column, 600px, the width of a timeline. Lists and posts run to its edges; forms and settings get 16px side padding.
- Header: the wordmark (or a back arrow) and the viewer's face. A ruling's header arrow returns to its Bet. Predictions, Bets, Inbox and Settings live behind the face; a dot on it means unread. One way to sign in per screen: when a page's own button signs you in, the header pill is dropped.
- One filled button per screen. Everything else is an outline pill or an underlined word.
- A Bet is two round faces with the stake between them: "bet yes" on the left, "bet no" on the right. Faces align at the top, the figure centres on them, and stance labels share a baseline below complete names. Both names use 15px, weight 700, ink; handles over twelve characters use 13px without breaking. Below 360px the pot sits above the paired seats. An open seat reads "You?" (or "Anyone" to the person who offered it) in the same name style. One bold line above says where it stands ("@priya dares you", "Both sides are in", "@priya won").
- An X post has a 44px logo link at the header's top right. Its stored publication time, when permitted, links to the same post below the words. Missing times stay absent; the save or Bet creation time never substitutes for the post time.
- Detail that people open rarely goes in at most four folds per page. No boxes around groups; a hairline separates rows.

## Copy

- Sentence case. Sides are "bet yes" and "bet no". Amounts are "test NEAR". Status is a plain phrase ("110 days to go", "Came true 28 Sep", "Didn’t happen 5 Nov").
- No serial numbers, no "receipt", no eyebrows, no strings joined with a middle dot, no caption under every button. At most one explanatory sentence outside folds.
- A settlement by agreement is never described as the factual Result; a credit that still has to be withdrawn is never described as paid; opening a composer is never described as posted. A Bet settled by the referee is the recorded Result, and its winnings are moved to the winner's testnet account in the same pass, so that page says "won" and "Paid to your account".

## States

- **Something failed.** The person lands back on the page they acted from, with the reason in one red-edged line above the button it belongs to, and what they typed still in the field. A deposit or a reply to a Bet returns to the Bet; a bad link fails on the paste field. The general error page ("That didn’t work", the reason, "Go back" to a same-origin referrer) is only for failures with no page of their own.
- **Nothing yet.** One centred sentence that says what will fill the list, and the action if there is one. No illustration.
- **Long content.** On its own page a post steps its words down (28, 24 over 120 characters, 20 over 200) so the action stays in the first screen at 390. In a list the words show four lines. Bet seat handles and source identities wrap in full; a lead line that cannot share its row drops its date beneath it.
- **The wallet step.** One bold line says what leaves which account, then the button. Network, contract and method sit in a fold named "This request".
- **Inbox.** Results and Bet updates appear first. Capture acknowledgements remain in a collapsed Saved predictions section; viewing the Inbox neither deletes them nor marks them done. Notices remain full sentences in storage for direct messages. A displayed result is "who: Yes" and the detail; scoring sentences stay on the Prediction's page.
- **Bet dates.** Day, month, year, hour and minute use labelled segmented controls. Dates are UTC. Untouched fields show no error. Submission validates real calendar dates and preserves entered parts on failure.
- **Bet attribution.** Show the permitted source author's face and name separately from the two Bet seats. A public Bet never exposes a private source's identity; an unavailable source falls back to the Bet's proposer attribution.
- **Winner.** The winner's face carries a ring: yellow on a Prediction that came true (a deeper yellow on a light ground, where the marker yellow is faint as a thin line), ink on a Bet settled by agreement, yellow on a Bet the referee settled Yes. The name is never marked: a filled name reads as a chip.

## The jury

The ruling page starts with the author above the post, marked Yes or struck through for No, at the Bet page’s claim sizes. The smaller outcome word sits on one line with the date, followed by the jury sentence, three jurors, a reason line and the filled button to make the next bet. The button stays in the first screen at 390 by 844. Jurors show their makers’ logos and verdicts, such as “Yes, 99% sure”; a dissenting verdict uses ink while the majority stays grey. The reason gives the price and deadline, or quotes a model’s reason beside its name and the deadline. Links, model reasons and checks stay in folds after the button.

Bettors post links until the window closes. Their page leads with “Links are open” and “Links close in …”, followed by UTC; visitors and bettors open the same “Links, 2” fold. The filled button says “Add a link”. On the links page, paste first, list second, with saved text in “What the jury reads”.

The jury decides the Result. A Stated reviewer can correct it during the ten-minute window before payout. Show “Pays out in …” with UTC, then “Paid to your account” once transferred. The DAO referee line names Stated Court and opens its on-chain record.

Without agreement at the required confidence, show “Undecided” and leave the post unmarked. Once refunded, show the returned stakes with no winner’s ring.

## Motion

Press feedback `scale(0.97)` over 100ms. The highlighter sweep is 480ms, once, on the page that opens a Result. Nothing else animates. Reduced motion shows the finished state.

## Share images (`server/src/share-image.mjs`)

1200 by 630. The author, the words sized by their length so a short claim fills the card and a full post still fits, then the Result or the time left, and the two bettors when there is a Bet. Black with a hairline border, except a Prediction whose Result is Yes, and a Bet the referee settled from that Result, which are yellow. Faces are a letter in a circle because the renderer loads no remote pictures.

## Ship checks

Render at 320, 390 and desktop in both modes and look at every frame, including a long name, a full-length post, the empty states and one error. Run the suite (`npm test`) and review the screenshots before sharing a change. Exercise sign-in return, private and public projections, a competing acceptance, a cancelled wallet signature, an unresolved transaction, mutual settlement and refund.
