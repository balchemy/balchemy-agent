# Changelog

All notable changes to `balchemy` (the Balchemy CLI) are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.9.0] — 2026-11-XX

### Changed: the cockpit is one screen

- **Every card now opens inside the cockpit screen.** Setup steps, confirmations, the wallet, model, budget, limits, rules and arming cards no longer drop to plain terminal lines and back. Esc leaves a card (nothing is changed) and keeps it as a chip; Ctrl+E opens it again. Typed confirmation phrases and every safety check are exactly as before.
- **Secret cards are kept apart.** A new wallet key, passphrases and API keys appear only inside their card and are never written to the conversation, its memory or the AI model. Text in the chat that looks like a key is refused before it is sent.
- **Who wrote each line is always clear.** A fixed column on the left shows `You`, `Agent`, `Balchemy` or the time of a runner record; on narrow terminals body lines sit behind a rail. Text from the model, token names and server messages is stripped of terminal control, colour and direction characters, so it can never pose as a Balchemy line. `NO_COLOR` and non-UTF-8 terminals are supported.
- **Setup starts from your directive.** The three ready-made templates are replaced by example directives that do not use launchpad names or "new pairs" (which hold every buy in this version); a chosen example opens in the input to edit. Stop-loss is asked only when the directive has none, slippage is no longer asked (1%, change it under Settings > Advanced), and a buy amount in the directive is checked against the per-buy limit.
- The rules review in the cockpit is plain language instead of the raw rule JSON (`balchemy runner rules` is unchanged). `/ask`, `/buy`, `/sell`, the ChatGPT option and launchpads that are not live yet are no longer shown. The funding QR code is drawn without colour so it shows inside the card.

### Security: changes that raise risk need your wallet passphrase

- **Every change that raises risk asks for the trading wallet passphrase.** Raising a spend cap or the buy size, changing slippage, confirming rules (turning owner approval on is the exception), changing the RPC, the model, the AI budget or launchpads, raising autonomy, arming, resuming new buys, and one-off actions on positions (close, resolve, stop managing, rebind exits) now ask the passphrase in a secret card (or a hidden prompt on the command line). Before this, another program running as your user could send these changes to the runner without it. Tightening a limit, pausing, disarming and stopping never ask. After 5 wrong passphrases the runner waits longer before each new check (from 2 seconds up to 5 minutes).
- **Your owner wallet and your limits are sealed.** After pairing (and inside arm or `/resume` when needed), or with `balchemy runner owner-pin <agent>`, a seal card shows the full owner wallet address, the Hub address and agent, your limits, buy size and slippage, the rules in plain language, approval, RPC host, model, AI budget and launchpads; you compare the address with the wallet you use on the Hub, type its last 6 characters and the passphrase. Arming and owner approvals are refused until the owner wallet is sealed. The seal is checked with a key derived from your wallet. If the files on disk are edited afterwards, so the seal is missing or the current values are looser than the sealed ones, the agent arms with **new buys paused**; open positions keep their stop-loss and take-profit. Seal again from the cockpit to resume buys.
- **A rules review that cannot describe a change blocks CONFIRM.** If a changed rule path cannot be written in plain language, the card says so and cannot be confirmed.
- Typed confirmation phrases are unchanged.

### Fixed

- **Stop-loss and take-profit keep running when the rules file cannot be read.** If the local rules file became unreadable while the agent was armed (for example because another program edited it), every exit stopped until the runner was restarted. Now new buys and DCA adds stay refused (`rules_unavailable`), while open positions keep selling at the stop-loss and take-profit set when they were bought, and the checks that settle whether a buy or sale landed keep running.

### Removed (breaking)

- **The external MCP connection model is gone.** The chat cockpit (`balchemy`) and the local runner (`balchemy runner ...`) are the only way to run an agent. Removed with it:
  - the commands `legacy`, `legacy init`, `start [config]`, `tui`, `list`, `control ...`, `agent list|current|use|control`, `auth status|login|logout`, `context current|status`, `config validate|list` and `docker` (with `docker generate`). Each of them now prints one fixed notice, `balchemy <command> was removed in 0.9.0`, and exits with code 2 without reading or changing anything. `balchemy init` and `--init` stay;
  - the legacy terminal UI, its setup wizard, the `agent.config.yaml` loader, the backend runtime-control client over MCP and the encrypted MCP credential store;
  - the `docker` templates (`Dockerfile`, `docker-compose.yml`, `.env.example`, `agent.config.yaml`); the package no longer ships a `templates` folder.
- `balchemy doctor` checks only Node.js and the terminal; it no longer looks for `agent.config.yaml` or the credential store and takes no arguments. `balchemy doctor --runner` is unchanged.
- The error codes `CONFIG_FILE_MISSING`, `CONFIG_ENV_MISSING`, `CONFIG_YAML_INVALID`, `FILE_OVERWRITE_CONFIRMATION_REQUIRED`, `UNSAFE_INIT_DIRECTORY` and `RUNTIME_STEP_UP_REQUIRED` are no longer emitted.

### Notes

- `~/.balchemy/agents.enc`, the old encrypted MCP credential file, is no longer read. The CLI does not delete it; remove it yourself if you no longer need it.
- Typed confirmations are unchanged; the runner's gates gain only the passphrase, seal and exit checks described above. The `create-balchemy-agent` and `balchemy-agent` command aliases stay.
- Going back to 0.8.1 after running 0.9.0: `balchemy runner recover` in 0.8.1 refuses while the new seal files exist. Stay on 0.9.0, or ask for help before downgrading.
- Ships together with `@balchemyai/agent-sdk` 0.9.0, which removes the MCP client and the ERC-8004 onboarding.

## [0.8.1] — 2026-11-22

### Fixed

- **Cockpit chat and the setup guide no longer fail with `invalid_result` when the model answers in prose or wraps its JSON in a markdown fence.** This happened with some OpenAI models (for example `gpt-6.1-terra`): the provider answered normally, but the runner only accepted one bare JSON object.
  - One surrounding markdown code fence (` ```json ... ``` ` or ` ``` ... ``` `) is removed before the reply is checked. The checks themselves are unchanged: the kind must be known, the keys exact and the text valid, so JSON with extra keys is still refused.
  - When a reply does not parse, the runner asks the model once more, in the same job, to return only the JSON object. That retry is a normal model call: it counts against the daily AI budget like any other, and a refused budget answers you as before (unless the first reply was usable plain text, see below). A job retries at most once.
  - If the reply still does not parse but is plain text that passes the same checks as an answer (length, no control characters), it is shown as a plain answer. Plain text can never read or propose rules, request research, propose limits or a buy size, or carry a card; only a valid JSON reply can. Anything else still fails with `invalid_result`.

### Changed

- Earlier chat turns are now sent back to the model in the same JSON answer form it is asked to produce, so the history no longer shows it plain prose.
- Chat and setup-guide calls do not request a provider JSON mode (`response_format`) for any provider; the fence handling, the single corrective retry and the prose fallback above are what keep replies usable. The SDK keeps JSON mode as an opt-in option, but the CLI does not use it.
- If the corrective retry call itself fails (provider error, abort or a refused AI budget) and the first reply was usable plain text, that text is shown as the answer instead of failing the job. Without usable plain text the failure is reported as before.

### Dependencies

- Needs `@balchemyai/agent-sdk` 0.8.1 or later (`^0.8.1`); `@balchemyai/agent-rules` stays 1.2.0 (`^1.2.0`).

## [0.8.0] — 2026-11-22

### Added

- **`/resume` turns new buys of an armed agent back on.** When you paused new buys with `/pause` (or in Hub), `/resume` now shows a card and asks you to type `RESUME <agent>`. It then sends the new owner-local runner action `entries_resume` (arming channel, owner socket only; Hub cannot reach it). The agent stays armed the whole time, so stop-loss and take-profit exits keep running.
  - It only turns new buys back on: it never arms, and it never changes caps, rules or exits. It applies at exactly the state version the card read.
  - It is refused, and nothing changes, when the agent is not armed or its buys are not paused, when the state moved since the card, while a trade is unresolved or a re-signed copy is unacknowledged, or when a rule, cap or wallet-approval check fails (the same checks arming runs).
  - It is also refused when the runner paused new buys itself. A change to rules, limits or buy size that is being saved or failed to save keeps them paused until a saved change lifts it (`change_pending`). An exits-only arm resumes by itself (`submission_unresolved`). The runner tells its own pause from yours by the state version its hold produced: any pause of yours moves the version. These markers live in memory only, like armed authority itself, which no restart keeps. No state file changes.
  - Stopped or paused agents that are not armed keep the previous `/resume`: back to shadow mode, and arming stays separate.
- **"Apply the new exit rules to open positions too?"** After you confirm changed rules in the cockpit (the `/directive` rules card, a rules review from the chat, the approval card or the setup card), a card lists each open position with its current and new stop-loss, take-profit and trailing-stop values. By default nothing changes: every position keeps the exits it was opened with. Type `APPLY <agent>` and the runner re-binds those positions to the confirmed rules through the new owner-local action `private_exit_rebind`.
  - The positions change in one durable position-ledger commit, which records the operation, the revision and its rules digest. Entry, units, cost, proceeds, ladder progress, trailing state and history stay as they were. A replay after a lost reply or a restart writes nothing.
  - The re-bind is bound to the head and the preview you saw. If the head moved, a position changed or a new position opened since the card, nothing is applied.
  - A position is skipped, never transformed, with the reason shown, when:
    - it is held, or a sell of it or of its token is in flight;
    - a buy or an unsettled DCA add of its token is in flight;
    - a take-profit level already sold and the new ladder does not start with the same levels;
    - its trailing stop is armed and the new trailing stop differs.
  - While a signal buy is being prepared, the whole re-bind is refused. An exit decision the exit worker made under the old exits is dropped after a re-bind; the next pass uses the new ones.
  - DCA: future lots always take the newest confirmed rules, whichever way you answer, because each add binds the head of its moment. Existing lots follow your yes or no like any position. An add in flight is never edited, so its token is skipped.

- **DCA adds in the runner (K1b, `dca.v1`).** The runner part of the DCA buy variant (purpose `balchemy.local-agent.execution.dca-request.v1`).
  This build declares `dca.v1`, so a confirmed rule revision with DCA is now executable against Balchemy's current backend. A runner that does not declare it still holds such a revision.
  - One durable campaign per token. Its spend only grows (the opening buy, then every add once signed), so selling a lot never frees room under `maxTotal`. Its last-buy reference is the newest buy ever made. A stop-loss or trailing-stop exit of the token ends DCA on it for good. At most 8 adds per campaign, and never for an unmanaged or outside token.
  - One durable add record per add, written before any reservation or network call. It binds the token, the parent lot's build digest, the amount, the slippage, the confirmed rule head and the exit rules of that moment by digest. A restart never builds it again: the record is resumed or settled from the journal. A released add is retried only as a new add with fresh research evidence.
  - Adds run inside the execution queue after signal buys and pass the same gates: the entry choke point, the exit holds, limits, the RPC class, wallet holds, the keystore, one start per agent and the rate guard. The typed rules apply, and the daily cap must be an amount. Interval and dip triggers are supported; the dip reads the exit worker's own valuation, so no extra sell assessment is made. An unsent add is withheld once an exit of the token starts. Slippage is the parent position's. A refused add backs off: server spacing waits 60 s, a parent or record-headroom refusal waits 10 min, and any other refusal doubles from 60 s to 10 min.
  - A filled add opens its own position with its own stop-loss and take-profit, from its record (never from a signal intent).

- **Cockpit commands, settings and a live panel (K5b).** Type slash commands in the chat input. Only the line you type there counts: a `/stop` in a model reply, a signal or a feed line does nothing, and an unknown command is a notice that is never sent to the model.
  - Risk-lowering commands act at once: `/pause` (new buys stop; an armed agent stays armed, so stop-loss and take-profit exits keep running), `/stop` (warns first with open positions; `/stop` again within a minute stops), a lower `/budget`, lower SOL `/limit` values and a lower slippage. For limits and slippage the cockpit answers the command's typed phrase only for the revision it compared against.
  - Risk-raising commands open a card with the command's own typed confirmation: a higher `/budget` (`BUDGET <agent>`), higher limits, a percentage or `none` (`SET LIMITS <agent>`; above the signed spend ceiling, arming needs a new wallet signature in the browser), a higher slippage (the sizing `CONFIRM`), `/directive change` (rules card: coach, stop-loss check, `CONFIRM`), `/arm`, and `/resume` (typed `RESUME <agent>`: new buys of an armed agent back on, or a stopped or paused agent back to shadow mode; arming stays separate).
  - `/resume` of an armed agent whose new buys are paused turns them back on without disarming it (see the `/resume` entry above). The shadow-mode resume, which disarms the agent and stops its exits, is never sent for an armed agent.
  - `/agents` and Ctrl+N list the agents and switch between them; a known agent the runner lacks is added with `runner add`, so nothing is restarted and no other agent is disarmed. `/new` names, adds and sets up a new agent.
  - `/model` (keep or change), `/signals` (launchpad multi-select; adding one shows a review line first; Telegram and Discord stay on the Hub page), `/status`, `/positions` (cost, proceeds and realized PnL in SOL), `/wallet` (address, QR code and balance), `/lang` (the reply language, sent with each message), `/help` (`?`), `/settings` and `/exit`. `/ask`, `/buy` and `/sell` say they are coming in a later update.
  - Ctrl+S settings: AI model, daily AI budget, slippage, strategy, reply language and your own Solana RPC (advanced; the RPC command still refuses a change while an armed agent has an open trade), each with the same lower/raise rule.
  - PgUp and PgDn scroll the conversation; `?` opens the help with every shortcut and command.
  - The right panel refreshes every 5 seconds: mode, keep-awake, SOL balance, trading wallet, signals checked, recent decisions and trades, open positions with realized PnL in SOL (cost pro-rated by units sold; proceeds still being confirmed are shown as such, never as zero; unrealized PnL is "not available yet") and today's AI spend against the daily budget. Narrow terminals get a four-line summary.
  - Narration in plain English, built by code from the runner's records: "Checked 7xKX…gAsU from pump.fun: no buy (it failed one of your entry rules)", "Bought 7xKX…gAsU for 0.05 SOL", "Stop-loss sold 7xKX…gAsU: +0.012 SOL". Launchpad names come only from the runner's catalog. The measured values behind a held decision (such as a holder share against its limit) are not in the runner's readback, so they are not shown yet.

- **A new cockpit setup order (owner-approved, 19 Nov 2026).** `balchemy` now goes: what you need, the agent name, the AI model, the daily AI budget, the trading wallet, one Hub visit, then the chat and one setup card.
  - First screen: you need a Balchemy account and your identity wallet (for example Phantom), access to an AI model (an API key) and the SOL you will fund the agent with.
  - The runner starts by itself in shadow mode (no Enter prompt). The version check and the Phase 1 shutdown and resume behaviour are unchanged.
  - AI model: choose OpenAI, Anthropic or OpenRouter and paste the key at a hidden prompt. The key is checked at once: OpenAI and Anthropic by their model list, OpenRouter by `GET /api/v1/key` (a 401 means rejected; any other failure is "could not be reached", never accepted). A rejected key shows a clear error and asks again. The ChatGPT subscription is shown as coming soon and cannot be chosen.
  - A saved model is shown first (provider and model, read without the passphrase), with Keep or Change. Changing only the model keeps the saved key: the new runner action `model_reselect` opens the record with your passphrase and re-seals it with the new model, and the key never leaves the runner. Without a key, the model list can be read only for OpenRouter (its public list); for OpenAI and Anthropic you type the model ID. Changing the provider or key re-enters the key.
  - For an OpenRouter model, its published prompt and completion prices are captured from the catalog and stored in the agent's AI budget record (new budget action `price`). The budget then estimates and settles that exact model at those prices instead of the highest listed price. OpenRouter's reported cost still settles a call when it is reported.
  - The daily AI budget step ($5 by default) explains that it caps the agent's own AI API cost per UTC day. Raising it above the current limit keeps the typed `BUDGET <agent>`.
  - One passphrase: the wallet step offers "Use the same passphrase for the model key" (the default). The model key's passphrase is now NFC-normalized like the wallet's. A record sealed before from a non-NFC passphrase still opens with its old form and is re-sealed in NFC on the next save. After a restart the cockpit asks once: the passphrase that unlocks the model key is tried once on the wallet, and only a wallet with its own passphrase asks again. The wallet text no longer tells you to use a different passphrase.
  - The wallet now exists before the Hub visit. After pairing, the runner links it by itself and the same page asks for the spend ceiling, shown here with the amounts and the check code.
  - The cockpit guide opens in English and then answers in the language of your latest message.
  - The Solana connection is no setup step and no card any more: Balchemy provides it, and your own RPC stays an advanced setting.
- **The setup card.** Until rules are confirmed, the rest of the first setup is one card.
  - Strategy: a template (memecoin sniper, DCA, swing) or your own directive. DCA is saved and, once its rules are confirmed, runs as DCA adds (see "DCA adds in the runner"). The deterministic rule coach (`coachBehaviorRuleCompilation`) shows what it did not understand and what is missing.
  - A stop-loss is required: a directive without one asks for it, and declining refuses the card with a clear message. Rule cards outside the setup card refuse a rules CONFIRM without an owner-stated stop-loss too.
  - Signal sources: the launchpad catalog, multi-select, with coming-soon launchpads shown but not selectable. No signature is needed. Telegram and Discord sources stay on the Hub page.
  - Spend limits default at or below the signed ceiling. The buy size must fit the per-buy limit.
  - Funding: the unlock-verified trading address, a terminal QR code (a small built-in encoder, no new dependency) and a minimum of one buy plus 0.02 SOL. The card waits until the balance shows; Ctrl+C skips the wait.
  - One summary of everything the agent will do (rules, automatic trading, sources, buy size, limits, ceiling, model, AI budget), with ONE typed `CONFIRM <agent>`. Only then are the rules, automatic trading, limits, buy size and sources saved, in that order, through their existing commands. Then the arm command runs with its own review, typed `ARM <agent>` and passphrase. Nothing is saved before the confirmation. A failed save stops the rest and says what was saved.

- **Your typed strategy rules now run on the runner (rules compiler 1.3.0).** Entry filters, never-buy lists, a per-token buy limit and a trades-per-day limit are enforced, so revisions that use them can execute instead of holding.
  - Entry filters use only real facts: liquidity, market cap and 1h/24h volume when Balchemy's research reports them, and the top-N holder share for N up to 20, read from Balchemy's two RPC providers, which must agree. The share counts token accounts, not owners, and includes pool and bonding-curve accounts. A fact that is unknown (token age, holder count, taxes, a creator, more than 20 holders) holds the buy: the agent does not buy.
  - Never-buy lists are checked before the model is asked and again before every buy. The per-token limit counts the buys of the current holding; the daily limit counts the trades the runner signed in the last 24 hours and never limits a stop-loss or take-profit sell.
  - DCA rules run as DCA adds, which have no signal of their own (see "DCA adds in the runner"); a runner that does not declare `dca.v1` still holds them.
- **Launchpad signal sources: `balchemy runner signals <agent> [--launchpads pumpfun,...|none]`.** It lists Balchemy's launchpad catalog (pump.fun live, the others coming soon) and chooses which launches the agent hears about. No wallet signature is needed. A launch is a public observation: the agent researches the token and your rules decide. A buy that cites a launch is allowed only while the agent is subscribed to that launchpad, the launchpad is live and the signal is fresh. Before installing an older runner on the same pairing, run `--launchpads none`.

- **One Hub visit for the first setup: the runner links the trading wallet by itself, and you sign a spend ceiling on the same page.** After you confirm the pairing in the browser, keep the page open.
  - The runner links the agent's trading wallet to your Hub account as soon as the pairing is saved, its lease is active and the wallet is unlocked. There is no typed `BIND <agent>` any more. A missing lease or a short Balchemy outage is retried; a refusal (for example the pairing wallet used as the trading wallet) is final and shown. `balchemy runner wallet <agent> bind` stays as the manual fallback, without the typed phrase.
  - On the same page you enter the most one trade and one day may spend (SOL, never "no limit"). The runner reads that proposal with its own signed read, opens exactly one approval request for exactly those amounts, and the cockpit shows the amounts and the runner's own check code, which must match the browser. You sign with your paired Solana wallet; the runner checks the signature itself before storing it. Nothing trades until you arm.
  - The signed amount is a maximum: later limits at or below it are covered, so arming needs no second browser visit. The cockpit's limit defaults stay at or below the ceiling; a higher limit (or none) asks for a new signature when you arm, as before.
  - Ctrl+C skips the ceiling step; arming then asks for your wallet approval as before. A Base pairing, a Balchemy site without this step, a changed wallet link or too many open requests are shown and never retried in a loop.

- **Balchemy provides the Solana connection: you no longer need your own RPC.** Once an agent is linked and its runner is online, the runner gets access to two independent providers from Balchemy and connects to both directly (no Balchemy proxy). Your own RPC stays an optional advanced setting (`balchemy runner rpc <agent> set`); when one is set, that agent keeps using it alone.
  - The runner accepts only a fixed list of provider hosts (alchemy, helius, quicknode, triton, syndica) and two different providers on different domains; any other grant is refused. The access is held in memory only and refreshed on time. URLs, keys and tokens are never written, shown or logged; status shows the provider names only.
  - New buys need both providers to answer and agree. A sell goes ahead on one provider when the other does not answer, but only on a positive result (a sell that landed without error, a valid blockhash). The same holds for opening the position of a filled buy (so it gets its stop-loss even while one provider is down). When the two disagree the step stops and is retried (`rpc_sources_disagree`). Proving that a sell or buy did not land, or settling a held position, needs both.
  - `balchemy runner rpc <agent> status`, the setup checklist and the cockpit guide show the Balchemy connection (ready, being set up or unavailable). The cockpit shows the own-RPC card only when Balchemy's connection is unavailable.
- **Daily AI budget in US dollars** for the agent's own model API cost: `balchemy runner budget <agent>` shows today's spend, the limit and the reset time (00:00 UTC); `--daily-usd N` sets it ($0.10–$1000, default $5).
  - Lowering applies at once; raising asks you to type `BUDGET <agent>`. Today's spend is never reset.
  - Every chat and autonomous decision call reserves a conservative estimate first and is refused without reaching the provider when it does not fit.
  - Spend counts at the cost OpenRouter reports, else at the tokens times a dated price table (17 Nov 2026), else (a failed or cancelled call) at the full estimate. A model missing from the table counts at the highest listed price.
  - When the budget is used up, chat answers with a short note and new autonomous decisions are held (`model_budget_exhausted`). Stop-loss and take-profit exits never use the model and keep running.
  - The runner keeps the budget in a new private file per agent. A held decision with the new reason cannot be read by an older runner, so a downgrade refuses that state.

### Changed

- **Changing an armed agent no longer disarms it.** Confirming rules, saving spend limits or saving a buy size now pauses only new entries while the change is saved. Stop-loss and take-profit exits keep running. After the save, entries turn on again by themselves if:
  - you did not pause them yourself (a Hub or CLI pause, disarm or stop is never undone);
  - no other change to the agent is still being saved;
  - the new rules are still executable, with a stop-loss, without shadow mode and without per-trade approval;
  - your wallet approval still covers the spend limits.

  Otherwise entries stay paused and the command says why and what to do next. A refused change, or one with an unknown outcome, also leaves entries paused; the next saved change turns them on again.
- **RPC changes of an armed agent with an open trade are refused** (`positions_open`). This covers a position that is open, waiting for an exit, held or not opened yet, and an unfinished trade. Another endpoint could leave the position without its stop-loss. Without an open trade, an RPC change still disarms the agent first, as before.
- **Shutdown warns before it leaves positions without stop-loss.** While an agent is armed or holds an open, exit-pending or held position, `balchemy runner shutdown` prints the count and that stop-loss and take-profit stop while the runner is off and until you arm again, and asks you to type `SHUTDOWN`.
  - Without a terminal (`--json`, `--ci`, a script) it refuses and stops nothing; `--yes` is still refused. An agent whose positions cannot be read counts as open.
  - With no armed agent and no open position, shutdown is unchanged. A runner that is running but whose state cannot be read (it does not answer, or its control journal is held) counts as possibly protecting positions: in a terminal you can still type `SHUTDOWN` to stop it; a script is refused. The cockpit's restart-to-upgrade message shows the same warning.
- **One-step resume after a restart.** When the trading wallet is locked and the agent holds open positions, `balchemy runner arm <agent>` and the cockpit list the positions first and ask your passphrase once: it unlocks the wallet and is used again for the arm. The review and the typed `ARM <agent>` stay. Your stored wallet approval is reused; the browser opens only when the caps rose or the wallet binding changed. If you stop after the unlock, the wallet stays unlocked until you lock it.
- **Arming for exits only.** A trade from before the restart that is still unresolved (for example one this runner disputes) used to refuse arming (`submission_unresolved`), which left every other open position without stop-loss until you closed it out. Now, when no buy from before can still be sent (a runner dispute, a buy Balchemy reported failed or expired, an unresolved sell), arming proceeds for exits only: stop-loss and take-profit are armed, and new entries stay paused until no unresolved trade remains, then turn on by themselves (same checks as after a settings change). While the unresolved trade still holds the wallet, other positions' exits run once the runner's own proof on your RPC frees it (retried with back-off; `runner trades` shows why it waits); a position whose sell is disputed stays held for review. A buy that can still be resent (for example a stalled buy the runner has not yet seen expire) keeps the refusal; a buy whose resends are used up no longer does, and its relay now closes at its blockhash expiry even after a restart. A trade this runner disputes still ends only with `balchemy runner trades <agent> close <attempt>`.
- **Pausing in Hub or the CLI always wins.** A pause of an armed agent now applies even when a settings change or an exits-only arm paused new entries a moment before (it was refused as a version conflict, and new entries could turn on again when the change finished). New entries stay paused until you turn them back on with the cockpit `/resume` (the agent stays armed) or disarm and re-arm; Hub shows the pause as a version conflict with the paused state.
- **Balchemy's two providers: a lagging answer is read again.** When one provider answers and the other has nothing yet (or the blockhash validity differs), the runner reads both once more before it waits. A filled buy that one provider shows finalized without error while the other still has no record of it opens its position (with its stop-loss) after three checks in a row, and `balchemy runner rpc <agent> status` says so (`rpc_source_lag_accepted`). A sell is never settled this way: it waits until both providers agree (or the other one does not answer at all), and a failed or missing trade never goes ahead on one provider. The arming review no longer says the two providers are "both checked": new buys need both to agree, a stop-loss or take-profit sell may go ahead on one.
- **Balchemy's providers must be on Solana mainnet.** Before the runner uses a new provider endpoint it checks the network's genesis hash; an endpoint on another network is refused (`wrong_network`). An endpoint that cannot be checked yet (its provider is down) stays unused and is checked again shortly, while the other provider keeps working.
- **The Telegram "back online" message says when the runner is not armed.** After an outage, a runner that comes back unarmed (every restart does) now reads "back online but not armed: stop-loss and take-profit stay off until you arm it again". The message is sent at most once per outage. This follows a new offline alert: when an armed runner's lease has been expired for more than 2 minutes, Balchemy sends one Telegram alert per outage and the Hub agent page shows an offline banner. Outages older than 24 hours are not alerted, and owners without exactly one verified Telegram identity are skipped.
- **Keep-awake.** While an agent is armed or holds open positions, the runner keeps the computer from idle sleep: `caffeinate -i -w <runner pid>` on macOS, `systemd-inhibit --what=sleep:idle` on Linux when it is installed; elsewhere none, and `runner status` says so. `runner status` and the cockpit side panel show the state. A closed laptop lid on battery can still put the computer to sleep.

### Fixed

- **Setup card, max positions and DCA rule checks (review of Phase 2).** A percentage spend limit in the setup card is fixed into SOL from the wallet balance before the summary, which shows the SOL amount and checks the buy size against it; the save goes through only when the limits command fixes it to exactly that amount again, and the rules save only for exactly the compiled rules the summary showed. "Max N positions at a time" is now enforced for every new buy, signal buys and DCA adds alike, when your rules state it (`max_positions`): a buy of a new token is refused while N tokens are held or being bought, an add into a held token is not limited, and a count that cannot be read refuses (`max_positions_unknown`). Rules that never state a limit have none: the compiled rules' internal default of 3 is not applied, and the held tokens are not counted for them (owner decision of 21 Nov 2026). Whether your rules state it is read from the confirmed revision itself (the rule coach's "State how many positions may be open" check), so no revision is recompiled or changed. The setup card and `/directive` show "At most N open positions" only when you stated N, and "Open positions: no limit (your rules state none)" otherwise. DCA adds now pass the same entry filters as signal buys on their fresh research (unknown or failing: no add, with a back-off), check never-buy symbols against the report's symbol instead of refusing every add, and never count a DCA lot's spend twice. A never-buy symbol list no longer refuses every signal buy at the build step: the runner checks the symbol the decision's own research reports carry (refused only for a listed symbol; an unknown or disagreeing symbol refuses, `rule_fact_unknown:symbol`). A never-buy creator entry still holds every buy and add (no creator fact exists yet); the rules summary now says so. `runner status`, the cockpit's `/status` and its right panel now show one line for why DCA adds wait (for example "DCA: waiting — symbol facts unknown for 7xKX…gAsU", from a new optional `dca` key of the execution status) and say "max N positions reached" in plain words (N is the number your rules state) when new buys stopped there; the activity feed names it too.

### Downgrade

- A downgrade below this version is not supported once the trade journal has written `evictedRecentAt` (it evicted an attempt less than a day old, which takes more than 64 trades in one day): an older runner reads that journal as unavailable. Only this version drops the field again, with its first journal write once the field is a day old.

### Dependencies

- Needs `@balchemyai/agent-sdk` 0.8.0 or later (`^0.8.0`) and `@balchemyai/agent-rules` 1.2.0 or later (`^1.2.0`): the CLI
  uses the SDK's launchpad, Balchemy RPC access, spend-ceiling and DCA clients, and the rules package's coach, typed grammar
  and compiler 1.3.0.

## [0.7.0] — 2026-11-17

### Added

- **The cockpit.** `balchemy` in a terminal is one session.
  - It starts with a short part without the model: agent name, starting the runner with Enter (shadow mode), model, Hub pairing, trading wallet.
  - Then a chat with the agent: conversation on the left; setup checklist, trading wallet and balance on the right.
  - The agent (the inner model) guides the remaining setup from the runner's setup state: RPC, funding, limits, rules and approval, buy size, arm.
  - Every change is a card (Ctrl+E). A card runs the existing command with its unchanged review and typed confirmation.
  - Proposal cards come only from code-built reply lines. Card-looking lines are removed from model text.
  - After arming, decisions and trade states are narrated in the chat. The narration lines are built by code from the runner's journals.
  - The setup checklist comes from a read-only setup state (`setup-state.ts`): the eight setup steps in dependency order, each done or not, and the owner-approved default suggestions.
  - `balchemy init` and the other `runner` commands are unchanged.
- **Hub pairing in one step**, with a Balchemy site that offers the pairing relay.
  - The browser opens and the runner finds the page's request itself: no Challenge ID to copy, no proof to paste and no separate confirm command.
  - You type `PAIR` and the 8-character code shown on the page. Then you type the code the CLI shows into the page, and sign with your wallet there.
  - An earlier approval is resumed and an expired request renewed.
  - A site without the relay keeps the step-by-step flow (Challenge ID and runner answer).
- **Secret guard** (a best-effort pattern check; secrets still belong only in the masked fields). Chat text that looks like a private key, a recovery phrase, an API key, an RPC or other URL with a key or token (in the query or the path), or a key file is stopped in the cockpit, and the runner refuses it too, so it does not reach the model or the job journal. Explorer links, `chat-rule-` IDs and `sha256:` digests pass; a bare 88-character signature or a bare `0x` + 64-hex hash is refused, because it cannot be told apart from a key (paste the explorer link instead).
- `runner chat` also gets the setup guide; a proposal card there points to the cockpit.
- **Sizing proposals.** The setup guide can propose a buy size (`propose_sizing`), validated by code. It is only a card default; the sizing command's `CONFIRM` still saves it.
- **Wallet balance.** A read-only `wallet_balance` action on the owner's arming channel: one SOL balance read on the owner's own RPC (refused on a public RPC), for the cockpit panel.

### Changed

- The typed confirmation of a rules proposal, a buy size change and an RPC change is now `CONFIRM`
  and the first 8 characters of its ID (as pairing does); the whole ID is still accepted. For a
  rules proposal the assistant drafted (`chat-rule-<hash>`) the 8 characters come from the hash;
  any other ID shape still needs the whole ID.
- Model setup asks how the model is paid for first. With an API key: OpenAI, Anthropic or
  OpenRouter. The models the key can use are loaded from the provider and picked with the arrow
  keys and Enter, with type-to-search for large catalogs such as OpenRouter's; a manual model ID
  is the fallback when the list cannot be loaded. ChatGPT subscription sign-in is shown as not
  available yet.
- OpenRouter as a model provider, at its fixed endpoint. Model IDs may now be `vendor/model`.

### Compatibility

- Saved models of 0.6.0 (`openai`, `anthropic`) read and unlock unchanged; the encrypted record
  format is the same. A runner started by 0.6.0 refuses OpenRouter: restart it on the new version.
- Downgrading: once any agent saves an OpenRouter or `vendor/model` model, a 0.6.0 runner cannot
  read the encrypted model file and shows saved models as unavailable (nothing is deleted).
  Upgrading again restores them.
- Needs `@balchemyai/agent-sdk` 0.7.0 or later (`^0.7.0`): the CLI uses its `/`-segmented model IDs and
  the one-step pairing client methods.
- **The cockpit needs a runner started by this version.** With a runner from another version (which has no setup guide, no balance read and no card-line filtering), the cockpit stops and asks you to run `balchemy runner shutdown`, then `balchemy` again.
- `runner chat` attached to a 0.6.0 runner gets no setup guide.

---

## [0.6.0] — 2026-11-16

### Upgrading

- **Restart the runner after upgrading.** Run `balchemy runner shutdown`, then a bare
  `balchemy runner start`. A restart locks the trading wallet and disarms; unlock the wallet
  again afterwards. `balchemy runner status` shows `Runner vX (CLI vY)` when the two differ.
- Automatic exits are in this build. Arming still needs `ARM <agent>` plus the wallet passphrase,
  the spend limits answered, and the owner's one-time wallet approval. Downgrading to a build
  without exits switches stop-losses off: close or watch open positions by hand.
- **Keep this computer's clock in sync.** If the clock differs from Balchemy's by more than 5
  seconds, Balchemy's answers are refused and automatic sells, stop-loss included, wait until the
  clock is corrected (turn on automatic time sync; the runner then reconnects by itself).

### Added

- Automatic stop-loss and take-profit exits. `PRIVATE_EXIT_EXECUTION_AVAILABLE` is true: an armed
  agent's buys are protected by the exit worker, whose protective back-off is at most 60 s and
  runs on a monotonic clock.
- First-enable owner approval: the CLI prints a Hub link, the locally recomputed check code and
  the requested terms ("per trade X SOL, per day Y SOL" or "no spend limit"), polls, verifies the
  paired wallet's signature locally, then continues to the ARM prompt. A Base-paired owner cannot
  be verified yet.
- Optional spend caps (per trade, per day; `none` is an explicit answer) and buy sightings that
  survive a restart.
- `runner positions <agent> unmanage <reservation-id>` takes a completed buy whose position cannot
  open off automatic management, on the owner's typed confirmation; true sell labels and a plain
  fee-policy line.
- The runner signs a swap only when its fee is at most 150 bps and goes to a Balchemy fee wallet
  on its compile-time allow-list.
- Named holds and owner paths for sells: a sell the runner cannot find on chain, a relayed sell
  Balchemy never resolves, a held sell's expiry proof after an RPC outage; `runner recover`
  accepts a configured folder.
- Clock text: a clock more than 5 s off Balchemy's is named on the Hub line of `runner status` and
  in `runner positions`, instead of a bare "Hub: offline". `runner status --json` gains
  `hub.reason`; the positions readback gains `hubReason`.
- `runner positions` and the `runner status` exits line name Balchemy's daily exit budget refusal
  (64 built attempts a day per coin, 512 per agent; retried after 00:00 UTC).

### Changed

- Dependency: `@balchemyai/agent-sdk` ^0.6.0; `@balchemyai/agent-rules` stays 1.1.0.

### Fixed

- A wall-clock step back no longer holds a wallet. Settling spend writes (release and commit of an
  existing reservation), an ambiguous buy build and the outside-mint write are recorded at the
  store's mark while the clock is behind it, so a clock step no longer leaves every sell of the
  wallet waiting. New buy reservations, spend-limit changes and position openings still refuse
  `clock_rollback`. The owner text for a held intent no longer says the wallet always stays held.
- Wall-clock steps no longer stall protection: exit back-offs and the submission service's waits
  and graces use a monotonic clock; exit writes to the position ledger and a running buy intent's
  outcome are recorded at the store's mark while the clock is behind it.
- A trade Balchemy never received ends on the runner's own not-landed proof, also while disarmed;
  the gRPC HMAC binds the bytes sent; the signing simulation uses the exact token-account rent and
  counts the WSOL account as the wallet's own money.

---

## [0.5.0] — 2026-11-11

### Upgrading

- **Restart the runner after upgrading.** A runner that was already running
  keeps the old version's code until it is restarted. Run
  `balchemy runner shutdown`, then a bare `balchemy runner start`: it starts
  every agent the runner already knows and leaves an agent you stopped stopped
  (naming agents would resume them). A restart locks the trading wallet and
  disarms; unlock the wallet again afterwards.
  `balchemy runner status` shows `Runner vX (CLI vY)` and prints these steps when
  the two differ; a 0.4.x runner reports no version and is shown as older.

### Added

- Read-only `balchemy runner positions <id>` (positions, holds and reasons), with
  `positions <id> resolve <position-id>` for a held position proven by a chain
  readback, and `runner trades <id> close <attempt>` to close out a trade held for
  review; both need a typed confirmation and sign or send nothing.
- The runner reports runner-signed, bounded per-decision summaries and its
  trading-wallet lock state to Hub (no address or key material).
- `balchemy runner --help`: a runner section grouped by task (start and stop,
  set up an agent, trading wallet, live trading, review, after an upgrade,
  troubleshooting).
- `balchemy doctor --runner`: read-only checks of the platform, runner folder,
  control socket, daemon state, known agents, versions and the Hub connection.
  The runner keeps no log file in this version.
- `runner status` shows the runner and CLI versions, a Hub connection line and a
  trading-wallet line per agent; a stopped runner lists the agents it knows and
  the command to start them.
- A bare `balchemy runner start` starts the runner again with the agents it
  already knows, without resuming an agent you stopped.
- The interactive menu (`balchemy`) adds `wallet` and `status` entries and shows
  the next setup steps after an agent starts.

### Changed

- Wallet create asks for the passphrase (typed twice, up to three tries) before
  any key is generated or shown.
- A wrong passphrase is reported as "Wrong passphrase" for wallet unlock and arm.
- Commands that need the runner (including `runner rules` and `runner intent`)
  say "The Balchemy runner is not running" with the exact start command, and tell an unknown agent name apart from a stopped
  runner. `runner recover` is suggested only after a crash or power loss, and a
  refused recover names the running runner and how to shut it down.
- `runner arm` checks first whether this build has automatic exits. This build
  has none, so arming is always refused before any other setup check, and no
  message claims that stop-losses or exits run.
- `runner limits` help says it limits AI model calls per day, separate from the
  spend caps under `runner wallet <id> limits`.
- `balchemy control arm` is labelled legacy (backend MCP agents only); it never
  arms the local runner.
- Pairing shows where the Challenge ID comes from, the next step after pairing,
  and plain copy when Balchemy cannot be reached.
- Runner text says it stops when the computer restarts or shuts down and does
  nothing while it sleeps; an unlocked trading wallet stays unlocked across
  sleep (lock it with `runner wallet <id> lock`).
- Pairing approval accepts `PAIR` and the first 8 characters of the Challenge ID
  (or the whole ID).
- `--yes` is rejected on runner lifecycle commands.
- Depends on `@balchemyai/agent-sdk@^0.5.0`; `@balchemyai/agent-rules@^1.1.0`
  is unchanged.
- Source maps are no longer published.

### Not available yet

- Live trading stays unavailable: automatic exits are not built, so every arm is
  refused. Windows and Alpine/musl are not supported, and the runner does not
  start by itself after a reboot.

## [0.4.0] — 2026-11-09

### Added

- Local runner: a detached, non-executing background service managed with
  `balchemy runner start <agent-id> [...]`, `runner status`, `runner stop`,
  `runner shutdown` and `runner recover`. Running `balchemy` opens local setup
  and management.
- Hub identity pairing for the runner (`balchemy runner pair`), with matching
  runner fingerprints shown in the CLI and in Hub.
- Local daemon with an encrypted local model vault,
  confirmed behavior rules (shared `@balchemyai/agent-rules`) and local research.
- Shadow decisions: the runner evaluates signals and records decisions without
  executing anything.
- Legacy launcher, config and Docker commands remain available behind
  `balchemy legacy`.

### Changed

- Depends on `@balchemyai/agent-sdk@^0.4.0` and `@balchemyai/agent-rules@^1.1.0`.
- `balchemy doctor` now checks the Node.js version against the `engines` range in
  `package.json` (Node.js 20 or newer) instead of a stale minimum of 18.
- Added a `LICENSE` file (MIT) and this changelog to the published package.

### Not available yet

- Live trading is unavailable. Execution stays non-executing; the complete
  autonomous trading journey is unfinished.
- Windows and Alpine/musl are not supported. The runner does not start by itself
  after a reboot.
