#!/usr/bin/env python3
# Generates the static "Marked" mock board, v9. Mock only: fictional people, illustrated avatars.
# The post is the object; the result is a mark on its words. Yellow only where a prediction came true.
import sys
OUT = sys.argv[1]
def av(seed, bg): return f'https://api.dicebear.com/9.x/notionists/svg?seed={seed}&amp;backgroundColor={bg}'
P = {
 'lena': ('Lena Okafor', '@lena_builds', av('lena', 'ffdfbf'), True),
 'oskar': ('Oskar V', '@oskar.v', av('oskar', 'b6e3f4'), False),
 'priya': ('Priya K', '@priya_k', av('priya', 'c0aede'), False),
 'mira': ('Mira', '@mira.energy', av('mira', 'd1f4d9'), False),
 'tk': ('TK', '@tkwatch', av('tk', 'ffd5dc'), False),
 'dana': ('Dana', '@defi_dana', av('dana', 'd9e3f0'), False),
 'jun': ('Jun', '@macro_jun', av('jun', 'e0e0e0'), False),
 'alek': ('Aleksandra Wiśniewska-Kowalczyk', '@aleksandra_wk', av('aleksandra', 'd1f4d9'), True),
 'j': ('J', '@j', av('jo', 'e0e0e0'), False),
 'bart': ('Bartholomew Fitzgerald 🇮🇪📈', '@bartfitz', av('bartholomew', 'ffdfbf'), False),
}
BADGE = '<svg class="badge"><use href="#badge"/></svg>'
X = '<svg><use href="#x"/></svg>'
def img(k, cls='av'): return f'<img class="{cls}" src="{P[k][2]}" alt="">'
def who(k):
    n, h, _, v = P[k]
    return f'<div class="who"><b>{n}</b>{BADGE if v else ""}<span>{h}</span></div>'
def mark(text, m): return {'yes': f'<span class="hl">{text}</span>', 'no': f'<span class="struck">{text}</span>'}.get(m, text)
def row(k, text, meta, m='', bet='', cls='', more=False):
    more_link = '<a class="tl more">Show more</a>' if more else ''
    return f'<div class="row {cls}">{img(k)}<div>{who(k)}<p class="said">{mark(text, m)}</p>{more_link}<p class="meta">{meta}</p>{bet}</div></div>'
def bet(faces, text): return f'<p class="meta bet"><span class="stack">{"".join(img(f, "") for f in faces)}</span>{text}</p>'
def top(kind='home', me='oskar', dot=False, extra=''):
    left = '<span class="wordmark">Stated</span>' if kind == 'home' else '<a class="back" aria-label="Back">←</a>'
    right = f'<span class="me">{img(me, "")}{"<i></i>" if dot else ""}</span>' if me else f'<a class="pill sm">{X}Sign in</a>'
    return f'<div class="top">{left}<span class="grow"></span>{extra}{right}</div>'
def tabs(on): return f'<div class="tabs"><a class="{"on" if on == 0 else ""}">Following</a><a class="{"on" if on == 1 else ""}">Yours</a></div>'
def seat(k, name, stance, state=''):
    # Every seat reads the same way: a face (or an empty place), a name, a side.
    if k is None: face = '<div class="open"></div>'
    elif k.startswith('ghost:'): face = img(k[6:], 'ghost')
    else: face = img(k, '')
    return f'<div class="seat {state}">{face}<b>{name}</b><span>{stance}</span></div>'
def versus(a, pot, pot_label, b, cls='', extra=''):
    labels = ''.join(f'<small>{t}</small>' for t in ([pot_label] if isinstance(pot_label, str) else pot_label))
    return f'<div class="versus {cls}">{a}<div class="pot"><b>{pot}</b>{labels}{extra}</div>{b}</div>'
EACH = ['test NEAR each', 'winner takes 0.2']
def post(k, text, m=''):
    n, h, _, v = P[k]
    return f'<div class="post"><div class="head">{img(k)}<b>{n} {BADGE if v else ""}</b><span>{h}</span></div><p class="said">{mark(text, m)}</p></div>'
def mini(k, text): return f'<div class="mini">{img(k)}<div>{who(k)}<p class="said">{text}</p></div></div>'
def when(left, right, link=True):
    r = f'<a>{right}</a>' if link else f'<span>{right}</span>'
    return f'<div class="when"><b>{left}</b>{r}</div>'
def verdict(word, date, cls): return f'<div class="verdict {cls}"><b>{word}</b><span>{date}</span></div>'
def proof(text, link): return f'<div class="proof"><span>{text}</span><a class="tl">{link}</a></div>'
def screen(sid, cap, inner, theme='t-dark', cls=''):
    return f'<div class="shot" id="{sid}"><p class="cap">{cap}</p><div class="screen {theme} {cls}"><div class="col">{inner}</div></div></div>'

NJ2 = 'Nightjar 2.0 ships a stable release before 1 March 2027. Calling it now.'
NJ18 = 'Nightjar 1.8 ships before October.'
SOLAR = 'Solar will be under $0.01/kWh at utility scale somewhere in the US by end of 2027.'
FED = 'The Fed cuts twice before November.'
APPLE = 'Apple announces a foldable at WWDC 2027.'
LONG = 'Calling it now, and I will not be moved on this: by the last trading day of December 2027 the ten-year Treasury yield closes below 3.25%, the dollar index is under 95…'
CAPEX = 'Three hyperscalers will each guide capex above $100B for fiscal 2027 before the end of the October earnings season…'

def list_rows(sel=None):
    rows = [row('lena', NJ2, '112 days to go', bet=bet(['priya'], 'Priya bet no. <a>Take yes</a>')),
            row('lena', NJ18, 'Came true 28 Sep', 'yes'),
            row('mira', SOLAR, '13 months to go'),
            row('jun', FED, 'Didn’t happen 5 Nov', 'no'),
            row('tk', APPLE, '211 days to go', bet=bet(['priya', 'dana'], 'Priya and Dana have 0.5 test NEAR each on it.'))]
    if sel is not None: rows[sel] = rows[sel].replace('class="row "', 'class="row sel"', 1)
    return ''.join(rows)

def yes_detail():
    return (post('lena', NJ18, 'yes') + verdict('Yes', '28 Sep 2026', 'yes') + proof('Shipped on the day.', 'Release notes on GitHub')
        + versus(seat('priya', 'Priya K', 'bet yes', 'won'), '0.2', 'test NEAR to Priya', seat('oskar', 'You', 'bet no', 'lost'))
        + f'<div class="acts"><a class="pill solid big">{X}Post the result</a></div>')
def no_detail():
    return (post('jun', FED, 'no') + verdict('No', '5 Nov 2026', 'no') + proof('One cut, not two.', 'Fed statement')
        + versus(seat('tk', 'TK', 'bet yes', 'lost'), '1.0', 'test NEAR to Dana', seat('dana', 'Dana', 'bet no', 'won'), 'no')
        + f'<div class="acts"><a class="pill solid big">{X}Post the result</a></div>')
STAKE = ''
DARE = '<p class="lead">Priya dares you<span>Open until 17 Nov</span></p>'
def open_bet(you='ghost:oskar'):
    return versus(seat(you, 'You?', 'bet yes'), '0.1', EACH, seat('priya', 'Priya K', 'bet no'))
FOLLOW = '<a class="pill sm gap">Follow</a>'
def open_page(cls='', cap='One open prediction; Priya has a bet waiting', sid='s-open'):
    return screen(sid, cap,
        top('back', extra=FOLLOW) + post('lena', NJ2) + when('112 days to go', 'Posted 9 Nov 2026')
        + DARE + open_bet()
        + '<div class="acts"><a class="pill solid big">Bet yes</a><a class="tl center">Make your own bet</a></div>', cls=cls)
STEPPER = '<div class="stepper"><a class="step" aria-label="Less">−</a><a class="step" aria-label="More">+</a></div>'
def offer_page(cls='', cap='Offering a bet: one screen', sid='s-offer'):
    return screen(sid, cap,
        top('back') + mini('mira', SOLAR) + '<p class="lead">Your bet</p>'
        + versus(seat(None, 'Anyone', 'bet yes'), '0.1', EACH, seat('oskar', 'You', 'bet no'), 'pick', STEPPER)
        + '<div class="acts"><a class="pill solid big">Offer the bet</a><div class="two"><a class="tl">Switch sides</a><a class="tl">Name someone</a></div></div>', cls=cls)

s_list = screen('s-list', 'Predictions you follow', top(dot=True) + tabs(0) + list_rows())
s_list_light = screen('s-list-light', 'The same list on white', top(dot=True) + tabs(0) + list_rows(), 't-light')
s_open = open_page()
s_narrow = open_page('narrow', 'The open prediction at 320 wide', 's-narrow')
s_yes = screen('s-yes', 'It came true', top('back') + yes_detail())
s_no = screen('s-no', 'It did not', top('back') + no_detail())
s_invite = screen('s-invite', 'Arriving signed-out from a bet link on X',
    top(me=None) + mini('lena', NJ2) + when('112 days to go', 'Posted 9 Nov 2026') + DARE + open_bet(None)
    + f'<div class="acts"><a class="pill solid big">{X}Sign in to bet yes</a></div>')
s_offer = offer_page()
s_narrow_offer = offer_page('narrow', 'Offering a bet at 320 wide', 's-narrow-offer')
s_offered = screen('s-offered', 'Right after offering: the dare goes back to X',
    top('back') + mini('mira', SOLAR) + '<p class="lead">Your bet is open</p>'
    + versus(seat(None, 'Anyone', 'bet yes'), '0.1', EACH, seat('oskar', 'You', 'bet no'))
    + f'<div class="acts"><a class="pill solid big">{X}Post the dare</a><a class="tl center">Copy the link</a></div>')
s_in = screen('s-in', 'Right after taking a bet',
    top('back') + mini('lena', NJ2) + '<p class="lead">You’re in</p>'
    + versus(seat('oskar', 'You', 'bet yes'), '0.1', EACH, seat('priya', 'Priya K', 'bet no'))
    + '<p class="stakes">Both stakes are held on NEAR testnet until the result.</p>'
    + f'<div class="acts"><a class="pill solid big">{X}Post the bet</a><a class="tl center">Back to the prediction</a></div>')
s_taken = screen('s-taken', 'The bet was taken before you got there',
    top('back') + mini('lena', NJ2) + '<p class="lead">Dana took this one</p>'
    + versus(seat('dana', 'Dana', 'bet yes'), '0.1', EACH, seat('priya', 'Priya K', 'bet no'))
    + '<div class="acts"><a class="pill solid big">Make your own bet</a><a class="tl center">Follow the prediction</a></div>')
s_failed = screen('s-failed', 'The bet did not go through',
    top('back') + mini('lena', NJ2) + '<p class="lead">That didn’t go through</p><p class="stakes left">Your wallet turned the request down. Nothing left your account.</p>'
    + open_bet() + '<div class="acts"><a class="pill solid big">Try again</a><a class="tl center">Not now</a></div>')
s_expired = screen('s-expired', 'An offer nobody took',
    top('back') + mini('lena', NJ2) + '<p class="lead">Nobody took this one</p><p class="stakes left">The offer closed 17 Nov. Priya got her 0.1 test NEAR back.</p>'
    + '<div class="acts"><a class="pill solid big">Make your own bet</a><a class="tl center">Follow the prediction</a></div>')
s_home = screen('s-home', 'Signed out',
    '<div class="top"><span class="wordmark">Stated</span></div>'
    + '<div class="hero"><h1>Sure about that?</h1><p>Reply <b>@stated</b> under a prediction on X. We keep it until the day, then mark it Yes or No.</p></div>'
    + post('lena', NJ18, 'yes').replace('class="hl"', 'class="hl sweep"') + verdict('Yes', '28 Sep 2026', 'yes')
    + f'<p class="took">{img("priya", "won")}{img("oskar", "lost")}Priya wins 0.2 test NEAR</p>'
    + f'<div class="acts line"><a class="pill solid big">{X}Sign in with X</a></div>'
    + row('jun', FED, 'Didn’t happen 5 Nov', 'no') + row('mira', SOLAR, '13 months to go'))
s_yours = screen('s-yours', 'Yours: the private side', top(dot=True) + tabs(1)
    + '<div class="paste"><span>Paste a link to a post on X</span><a class="pill sm">Add</a></div>'
    + '<p class="record">1 right, 0 wrong, 2 open</p>'
    + row('oskar', 'ETH flips $10k before the end of next year. 60% sure.', '13 months to go',
          bet='<div class="ask"><span>31 Dec 2027, 60%. That right?</span><a class="pill solid sm">Looks right</a><a class="pill sm">Edit</a></div>')
    + row('oskar', 'The Leafs win a playoff round this season.', '203 days to go. Only you can see this.')
    + row('oskar', 'Rust 2.0 lands a stable release before March.', 'Came true 19 Feb', 'yes'))
s_empty = screen('s-empty', 'Nothing yet, and a link that is not a post', top() + tabs(1)
    + '<div class="paste typed bad"><span>https://x.com/home</span><a class="pill sm">Add</a></div><p class="err">That link isn’t a post.</p>'
    + '<p class="blank">Reply <b>@stated</b> under one of your own posts on X and it lands here.</p>')
s_empty_f = screen('s-empty-following', 'Following, before you follow anything', top() + tabs(0)
    + '<p class="blank">Nothing here yet. Follow a prediction, or reply <b>@stated</b> under one on X.</p>'
    + '<div class="acts"><a class="pill big">See what people are calling</a></div>')
s_worst = screen('s-worst', 'Worst-case data',
    top(dot=True) + tabs(0)
    + row('alek', LONG, '13 months to go', bet=bet(['priya', 'dana', 'tk'], 'Priya, Dana and 12 others have 14.5 test NEAR on it.'), more=True)
    + row('j', 'Up.', '1 day to go')
    + row('bart', CAPEX, 'Came true 29 Oct', 'yes', more=True))

# The moment a result lands. The server renders the finished page; only the mark moves.
def moment(n):
    n_, h, _, v = P['lena']
    if n == 1:
        said = NJ18; tail = when('Due today', 'Posted 14 Jul 2026')
    else:
        said = '<span class="hl mid">Nightjar 1.8 sh</span>ips before October.' if n == 2 else f'<span class="hl">{NJ18}</span>'
        tail = verdict('Yes', '28 Sep 2026', 'yes') + proof('Shipped on the day.', 'Release notes on GitHub')
    head = f'<div class="post"><div class="head">{img("lena")}<b>{n_} {BADGE}</b><span>{h}</span></div><p class="said">{said}</p></div>'
    return screen(f's-m{n}', ['The page before the result', 'The result page loads; the mark crosses the words', 'Half a second later'][n - 1], top('back') + head + tail, cls='short')

def card(sid, cap, k, text, m, left, right, theme='t-dark'):
    n, h, a, v = P[k]
    size = 'xl' if len(text) <= 40 else ('lg' if len(text) <= 80 else ('md' if len(text) <= 160 else 'sm'))   # the renderer sizes the words by length, so a full post still fits
    return f"""<div class="shot" id="{sid}"><p class="cap">{cap}</p><div class="card {theme}">
  <div class="head"><img src="{a}" alt=""><div><b>{n} {BADGE if v else ""}</b><span>{h}</span></div><span class="grow"></span><span class="wordmark">Stated</span></div>
  <p class="said {size}">{mark(text, m)}</p>
  <div class="bottom"><div class="res">{left}</div><div class="ppl">{right}</div></div>
</div></div>"""
def faces(a, acls, b, bcls, cap): return f'<div class="pair"><img class="{acls}" src="{P[a][2]}" alt=""><img class="{bcls}" src="{P[b][2]}" alt=""></div><span>{cap}</span>'
c_yes = card('s-card-yes', 'The picture X shows when a result is posted', 'lena', NJ18, '',
    '<b>Yes</b><span>28 Sep 2026. Release notes on GitHub.</span>', faces('priya', 'won', 'oskar', 'lost', 'Priya wins 0.2 test NEAR'), 'flood')
c_no = card('s-card-no', 'The picture for a miss', 'jun', FED, 'no',
    '<b>No</b><span>5 Nov 2026. Fed statement.</span>', faces('tk', 'lost', 'dana', 'won', 'Dana wins 1.0 test NEAR'))
c_open = card('s-card-open', 'The picture for an open bet', 'lena', NJ2, '',
    '<b class="sm">112 days to go</b><span>0.1 test NEAR each</span>',
    f'<div class="pair"><div class="open">You?</div><img src="{P["priya"][2]}" alt=""></div><span>Priya bet no. Take yes?</span>')

LONG_FULL = 'Calling it now, and I will not be moved on this: by the last trading day of December 2027 the ten-year Treasury yield closes below 3.25%, the dollar index is under 95, and at least two G7 central banks have restarted asset purchases. Bookmark this and come back.'
c_long = card('s-card-long', 'The picture for a full-length post', 'alek', LONG_FULL, '',
    '<b class="sm">13 months to go</b><span>0.5 test NEAR each</span>',
    f'<div class="pair"><div class="open">You?</div><img src="{P["dana"][2]}" alt=""></div><span>Dana bet no. Take yes?</span>')

def desk(sid, cap, sel, aside):
    return f"""<div class="shot" id="{sid}"><p class="cap">{cap}</p><div class="screen desk t-dark">
  <div class="col">{top(dot=True)}{tabs(0)}{list_rows(sel)}</div>
  <div class="aside">{aside}</div>
</div></div>"""
d_list = desk('s-desk', 'Desktop: the list, with the selected prediction and its open bet beside it', 0,
    f'<div class="top"><span class="grow"></span>{FOLLOW}</div>' + post('lena', NJ2) + when('112 days to go', 'Posted 9 Nov 2026')
    + DARE + open_bet()
    + '<div class="acts"><a class="pill solid big">Bet yes</a><a class="tl center">Make your own bet</a></div>')
d_yes = desk('s-desk-yes', 'Desktop: a result opens beside the list', 1,
    '<div class="top"><span class="grow"></span><a class="pill sm gap">Following</a></div>' + yes_detail())

CSS = r'''
:root { --m-mark: #FFE45C; --m-on-mark: #0F1419; --m-x: #1D9BF0; --m-board: #1A1A1A; --m-board-ink: #9A9A9A; }
.t-dark { --ground: #000000; --ink: #E7E9EA; --dim: #8B98A5; --strike: #71767B; --line: #2F3336; --lift: #16181C; --sel: #1D2024; --err: #FF7A6B; }
.t-light { --ground: #FFFFFF; --ink: #0F1419; --dim: #536471; --strike: #536471; --line: #E6EBEE; --lift: #EFF3F4; --sel: #F0F3F4; --err: #C4281C; }
.flood { --ground: #FFE45C; --ink: #0F1419; --dim: #3B381C; --strike: #3B381C; --line: #E2C93F; --lift: #F2D74E; }

* { box-sizing: border-box; }
html, body { margin: 0; }
body { background: var(--m-board); font: 400 15px/1.35 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; -webkit-font-smoothing: antialiased; padding: 40px 32px 80px; }
.board { display: flex; flex-wrap: wrap; gap: 40px 32px; align-items: flex-start; margin: 0 0 56px; width: max-content; max-width: 100%; }
.cap { color: var(--m-board-ink); font-size: 13px; margin: 0 0 10px; }
.shot { display: grid; }
a { color: inherit; text-decoration: none; }
.grow { flex: 1; }
.defs { position: absolute; }

.screen { background: var(--ground); color: var(--ink); width: 390px; min-height: 780px; overflow: hidden; }
.screen.short { min-height: 430px; }
.screen.narrow { width: 320px; }
.screen.narrow .versus { grid-template-columns: 1fr 112px 1fr; }
.screen.narrow .post .said { font-size: 22px; line-height: 1.36; }
.screen.narrow .mini .said { font-size: 16px; }
.col { width: 100%; }

/* Top: the name and your face. */
.top { display: flex; align-items: center; gap: 12px; height: 60px; padding: 0 16px; }
.wordmark { font-weight: 800; font-size: 22px; letter-spacing: -0.04em; line-height: 1; color: var(--ink); }
.me { width: 44px; height: 44px; position: relative; flex: none; display: grid; place-items: center; }
.me img { width: 36px; height: 36px; border-radius: 50%; display: block; }
.me i { position: absolute; right: 2px; top: 2px; width: 10px; height: 10px; border-radius: 50%; background: var(--ink); border: 2px solid var(--ground); box-sizing: content-box; }
.top .me { margin-right: -4px; }
.top .back { font-size: 22px; line-height: 1; width: 44px; height: 44px; display: grid; place-items: center; margin-left: -12px; }

.pill { display: inline-flex; align-items: center; justify-content: center; gap: 8px; height: 44px; padding: 0 20px; border-radius: 999px; font-weight: 700; font-size: 15px; border: 1px solid var(--dim); color: var(--ink); white-space: nowrap; }
.pill.solid { background: var(--ink); color: var(--ground); border-color: var(--ink); }
.pill.big { height: 54px; font-size: 17px; width: 100%; border-radius: 16px; }
.pill svg { width: 18px; height: 18px; fill: currentColor; }
.tl { display: inline-flex; align-items: center; min-height: 44px; text-decoration: underline; text-underline-offset: 3px; }
.tl.center { justify-content: center; }

.tabs { display: grid; grid-template-columns: 1fr 1fr; border-bottom: 1px solid var(--line); }
.tabs a { height: 52px; display: grid; place-items: center; color: var(--dim); font-weight: 500; position: relative; }
.tabs a.on { color: var(--ink); font-weight: 700; }
.tabs a.on::after { content: ""; position: absolute; bottom: 0; height: 4px; width: 56px; border-radius: 4px; background: var(--ink); }

/* A row: the post as it looked, then when we find out. No columns. */
.row { display: grid; grid-template-columns: 40px minmax(0, 1fr); gap: 0 12px; padding: 14px 16px 16px; border-bottom: 1px solid var(--line); }
.row .av, .mini .av { width: 40px; height: 40px; border-radius: 50%; }
.row.sel { background: var(--sel); border-left: 3px solid var(--ink); padding-left: 13px; }
.who { display: flex; flex-wrap: wrap; gap: 0 5px; align-items: center; white-space: nowrap; margin-bottom: 3px; min-width: 0; }
.who b { font-weight: 700; flex: 0 1 auto; min-width: 0; max-width: calc(100% - 24px); overflow: hidden; text-overflow: ellipsis; }
.who span { color: var(--dim); flex: 0 0 auto; max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
.badge { width: 17px; height: 17px; fill: var(--m-x); flex: none; }
.said { margin: 0; font-size: 16px; line-height: 1.5; }
.meta { margin: 8px 0 0; color: var(--dim); font-size: 14px; line-height: 20px; display: flex; align-items: center; gap: 8px; }
.meta.bet { margin-top: 6px; }
.meta.bet a { color: var(--ink); text-decoration: underline; text-underline-offset: 3px; }
.stack { display: flex; flex: none; }
.stack img { width: 22px; height: 22px; border-radius: 50%; border: 2px solid var(--ground); margin-left: -7px; display: block; box-sizing: content-box; }
.stack img:first-child { margin-left: -2px; }
.row.sel .stack img { border-color: var(--sel); }

/* The marks. Came true: a highlighter over the words. Did not: a line through them. */
.hl { background: var(--m-mark); color: var(--m-on-mark); padding: 0.24em 0.16em; margin: 0 -0.16em; border-radius: 2px; -webkit-box-decoration-break: clone; box-decoration-break: clone; }
.post .hl { padding: 0.19em 0.14em; margin: 0 -0.14em; }
.hl.mid, .post .hl.mid { padding-right: 0; margin-right: 0; border-radius: 2px 0 0 2px; }
.struck { text-decoration: line-through; text-decoration-thickness: 2px; text-decoration-color: var(--dim); }
@media (prefers-reduced-motion: no-preference) {
  .sweep { background: linear-gradient(var(--m-mark), var(--m-mark)) no-repeat 0 0 / 0% 100%; animation: sweep 480ms cubic-bezier(0.22, 1, 0.36, 1) 300ms forwards; color: inherit; }
  @keyframes sweep { to { background-size: 100% 100%; color: var(--m-on-mark); } }
}

/* One post, full size: the words are the largest thing on the page. */
.post { padding: 10px 16px 0; }
.post .head { display: grid; grid-template-columns: 44px 1fr; gap: 0 12px; align-items: center; margin-bottom: 14px; }
.post .head .av { width: 44px; height: 44px; border-radius: 50%; grid-row: span 2; }
.post .head b { display: flex; align-items: center; gap: 4px; font-size: 16px; }
.post .head span { color: var(--dim); }
.post .said { font-size: 28px; line-height: 1.42; letter-spacing: -0.015em; }
.when { display: flex; justify-content: space-between; align-items: center; min-height: 48px; padding: 0 16px; margin-top: 8px; border-bottom: 1px solid var(--line); color: var(--dim); font-size: 15px; }
.when b { color: var(--ink); font-weight: 600; }
.when a { text-decoration: underline; text-decoration-color: var(--line); text-underline-offset: 4px; }
.verdict { display: flex; align-items: baseline; gap: 12px; padding: 16px 16px 0; }
.verdict b { font-size: 36px; font-weight: 700; letter-spacing: -0.02em; line-height: 1; }
.verdict.yes b { color: var(--m-mark); }
.t-light .verdict.yes b { color: var(--ink); text-decoration: underline; text-decoration-color: var(--m-mark); text-decoration-thickness: 6px; text-underline-offset: 4px; }
.verdict span { color: var(--dim); font-size: 15px; }
.proof { display: flex; align-items: center; gap: 8px; padding: 2px 16px 10px; border-bottom: 1px solid var(--line); font-size: 15px; }

/* Two people. One seat may be open. */
.lead { margin: 0; padding: 18px 16px 0; font-size: 17px; font-weight: 700; display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }
.lead span { font-size: 14px; font-weight: 400; color: var(--dim); white-space: nowrap; }
.versus { padding: 18px 16px 4px; display: grid; grid-template-columns: 1fr 150px 1fr; align-items: start; text-align: center; }
.seat { display: grid; justify-items: center; gap: 4px; }
.seat img, .seat .open { width: 64px; height: 64px; border-radius: 50%; margin-bottom: 4px; }
.seat .open { border: 1.5px solid var(--dim); }
.seat img.ghost { filter: grayscale(1); opacity: 0.45; }
.seat b { font-size: 16px; }
.seat span { color: var(--dim); font-size: 14px; white-space: nowrap; }
.pot { align-self: start; padding-top: 12px; }
.pot b { font-size: 28px; font-weight: 600; letter-spacing: -0.02em; line-height: 1.1; display: block; font-variant-numeric: tabular-nums; }
.pot small { color: var(--dim); font-size: 14px; display: block; white-space: nowrap; margin-top: 2px; }
.seat.won img { outline: 3px solid var(--m-mark); outline-offset: 3px; }
.versus.no .seat.won img { outline-color: var(--ink); }
.seat.lost b { color: var(--dim); }

.stakes { margin: 0; padding: 14px 16px 0; text-align: center; color: var(--ink); font-size: 15px; text-wrap: balance; }
.stakes.left { color: var(--dim); text-wrap: pretty; }
.stakes.left { text-align: left; padding-top: 6px; }
.row .more { color: var(--dim); min-height: 44px; margin-bottom: -12px; }
.acts { padding: 16px 16px 8px; display: grid; gap: 2px; }
.acts .two { display: flex; justify-content: center; gap: 28px; }
.acts.line { border-bottom: 1px solid var(--line); padding-bottom: 16px; }
.mini { display: grid; grid-template-columns: 40px minmax(0, 1fr); gap: 0 12px; padding: 6px 16px 16px; border-bottom: 1px solid var(--line); }
.mini .said { font-size: 17px; line-height: 1.4; }

/* Offer a bet: the amount sits between the two sides, with its own controls under it. */
.stepper { display: flex; justify-content: center; gap: 16px; margin-top: 10px; }
.stepper .step { width: 44px; height: 44px; border-radius: 50%; border: 1px solid var(--dim); display: grid; place-items: center; font-size: 22px; line-height: 1; flex: none; }

/* Yours. */
.paste { margin: 14px 16px 4px; height: 54px; border-radius: 16px; background: var(--lift); display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 0 5px 0 20px; color: var(--dim); font-size: 16px; border: 1.5px solid var(--lift); }
.paste.typed { color: var(--ink); }
.paste.bad { border-color: var(--err); }
.paste .pill { border-radius: 11px; }
.record { margin: 0; padding: 14px 16px; border-bottom: 1px solid var(--line); color: var(--ink); font-size: 15px; font-weight: 600; }
.ask { display: flex; align-items: center; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
.ask span { flex-basis: 100%; }
.err { margin: 8px 36px 14px; font-size: 15px; color: var(--err); }
.blank { padding: 40px 32px 8px; text-align: center; font-size: 17px; line-height: 1.4; margin: 0; text-wrap: balance; }
.blank b { font-weight: 700; }

/* Signed out. */
.hero { padding: 12px 16px 14px; }
.hero h1 { margin: 0; font-size: 28px; font-weight: 600; line-height: 1.15; letter-spacing: -0.02em; }
.hero p { margin: 6px 0 0; font-size: 17px; line-height: 1.4; color: var(--dim); }
.hero p b { color: var(--ink); font-weight: 600; }
.took { display: flex; align-items: center; gap: 10px; margin: 0; padding: 12px 16px 4px; font-size: 15px; }
.took img { width: 32px; height: 32px; border-radius: 50%; }
.took img + img { margin-left: -18px; margin-right: 2px; }
.took img.won { outline: 2px solid var(--m-mark); outline-offset: 1px; position: relative; z-index: 1; }

/* What X shows when the link is posted: 1200 by 630. Yes is the only place the whole surface turns yellow. */
.card { width: 1200px; height: 630px; padding: 44px 64px 44px; display: flex; flex-direction: column; background: var(--ground); color: var(--ink); overflow: hidden; }
.card.t-dark { border: 1px solid var(--line); }
.card .head { display: flex; align-items: center; gap: 20px; flex: none; }
.card .head img { width: 76px; height: 76px; border-radius: 50%; }
.card .head b { font-size: 30px; display: flex; align-items: center; gap: 8px; }
.card .head div span { font-size: 26px; color: var(--dim); display: block; }
.card .head .badge { width: 28px; height: 28px; }
.card .head .wordmark { font-size: 32px; align-self: flex-start; }
.card .said { margin: 28px 0 0; flex: none; }
.card .said.xl { font-size: 92px; line-height: 1.12; letter-spacing: -0.035em; }
.card .said.lg { font-size: 76px; line-height: 1.14; letter-spacing: -0.03em; }
.card .said.md { font-size: 50px; line-height: 1.2; letter-spacing: -0.02em; }
.card .said.sm { font-size: 36px; line-height: 1.25; letter-spacing: -0.01em; }
.card .struck { text-decoration-thickness: 4px; }
.card .bottom { margin-top: auto; display: flex; align-items: flex-end; justify-content: space-between; gap: 40px; }
.card .res b { display: block; font-size: 72px; font-weight: 700; line-height: 0.95; letter-spacing: -0.03em; }
.card .res b.sm { font-size: 48px; letter-spacing: -0.03em; line-height: 1.1; }
.card .res span { display: block; font-size: 26px; color: var(--dim); margin-top: 12px; }
.card .ppl { display: grid; justify-items: end; gap: 14px; font-size: 26px; color: var(--dim); white-space: nowrap; }
.card .pair { display: flex; gap: 22px; align-items: center; padding: 9px; margin: -9px 0; }
.card .pair img, .card .pair .open { width: 120px; height: 120px; border-radius: 50%; }
.card .pair .open { border: 3px solid var(--dim); display: grid; place-items: center; font-size: 30px; font-weight: 700; color: var(--ink); }
.card .pair img.won { outline: 5px solid var(--ink); outline-offset: 4px; }

/* Desktop: the phone's own list, with whatever is selected beside it. */
.screen.desk { width: 1180px; min-height: 720px; display: grid; grid-template-columns: 600px 520px; justify-content: center; }
.desk .col { border-left: 1px solid var(--line); border-right: 1px solid var(--line); }
.aside { padding: 0; border-right: 1px solid var(--line); }
'''
SVG = '''<svg width="0" height="0" class="defs" aria-hidden="true">
  <symbol id="badge" viewBox="0 0 24 24"><path d="M22.5 12.5c0-1.58-.875-2.95-2.148-3.6.154-.435.238-.905.238-1.4 0-2.21-1.71-3.998-3.818-3.998-.47 0-.92.084-1.336.25C14.818 2.415 13.51 1.5 12 1.5s-2.816.917-3.437 2.25c-.415-.165-.866-.25-1.336-.25-2.11 0-3.818 1.79-3.818 4 0 .494.083.964.237 1.4-1.272.65-2.147 2.018-2.147 3.6 0 1.495.782 2.798 1.942 3.486-.02.17-.032.34-.032.514 0 2.21 1.708 4 3.818 4 .47 0 .92-.086 1.335-.25.62 1.334 1.926 2.25 3.437 2.25 1.512 0 2.818-.916 3.437-2.25.415.163.865.248 1.336.248 2.11 0 3.818-1.79 3.818-4 0-.174-.012-.344-.033-.513 1.158-.687 1.943-1.99 1.943-3.484zm-6.616-3.334l-4.334 6.5c-.145.217-.382.334-.625.334-.143 0-.288-.04-.416-.126l-.115-.094-2.415-2.415c-.293-.293-.293-.768 0-1.06s.768-.294 1.06 0l1.77 1.767 3.825-5.74c.23-.345.696-.436 1.04-.207.346.23.44.696.21 1.04z"/></symbol>
  <symbol id="x" viewBox="0 0 24 24"><path d="M18.9 2H22l-7.5 8.6L23 22h-6.9l-5.4-7-6.2 7H1.4l8-9.2L1 2h7l4.9 6.4L18.9 2Zm-1.2 18h1.9L7.4 3.9H5.4L17.7 20Z"/></symbol>
</svg>'''
def board(bid, *shots): return f'<div class="board" id="{bid}">' + '\n'.join(shots) + '</div>'
HTML = f'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Stated · Marked</title>
<style>{CSS}</style>
</head>
<body>
{SVG}
{board('b1', s_list, s_open, s_yes, s_no)}
{board('b9', moment(1), moment(2), moment(3))}
{board('b2', s_invite, s_offer, s_offered, s_home)}
{board('b3', s_yours, s_empty, s_empty_f, s_worst)}
{board('b10', s_in, s_taken, s_failed, s_expired)}
{board('b11', s_narrow, s_narrow_offer)}
{board('b4', c_yes, c_no)}
{board('b5', c_open)}
{board('b12', c_long)}
{board('b6', d_list)}
{board('b7', d_yes)}
{board('b8', s_list_light)}
</body>
</html>
'''
open(OUT, 'w').write(HTML)
print('wrote', OUT, len(HTML))
