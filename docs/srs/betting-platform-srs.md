# Betting Platform: Software Requirements Specification

Version 1.0 · 13 Oct 2026

## 1. Introduction

This SRS defines a licensable, real-money sportsbook (with an optional casino lobby) that rebuilds the RupertCloud/bettingplatform codebase to regulated-operator standard. It follows the ISO/IEC/IEEE 29148:2018 structure. Every requirement has a unique ID, a priority and a verification method, so design, build, test and audit can trace back to it.

### 1.1 Purpose

The document is the single agreed baseline for product, engineering, QA, compliance and the licensing regulator. It states what the system shall do and how well, not how it is built. Readers: product owner, architects, developers, QA, security, compliance officer (MLRO), external auditors and the test laboratory.

### 1.2 Scope

In scope (Release 1):

- Player accounts, identity verification (KYC), age and location checks
- Multi-currency wallet: fiat, Mobile Money and card deposits and withdrawals; crypto as a configurable option
- Sports data and odds ingestion, market management, trading and risk controls
- Bet placement (single, multiple/accumulator, system bets, cash out), live in-play and pre-match
- Automated and manual settlement, voids, resettlement
- Responsible gambling (RG) tools, self-exclusion, affordability triggers
- Anti-money-laundering (AML) and fraud controls
- Bonuses and promotions, booking codes, referral programme
- Back office: player management, trading, finance, compliance, reporting, CMS
- Regulatory reporting, audit logging, data protection

Optional modules (Release 2, separately licensed): casino lobby through third-party game aggregators, and on-chain betting through the Azuro protocol (repo Version 3). Out of scope: peer-to-peer exchange betting, pool betting, retail shop terminals, and in-house RNG game development.

### 1.3 Definitions and acronyms

| Term | Meaning |
| --- | --- |
| Market | A betting proposition on an event, for example Match Result (1X2) |
| Selection / outcome | One possible result inside a market, with a price (odds) |
| Bet slip | The player's set of selections and stakes before submission |
| Single / Multiple / System | One selection; several selections that must all win; a set of combinations (for example Trixie, Yankee) |
| Cash out | Early settlement of an open bet at a price the platform offers |
| Settlement | Determination of a bet's result and payout |
| Void | A bet or leg settled at odds 1.00 (stake returned) |
| Liability | The maximum net amount the operator would pay if an outcome wins |
| KYC / CDD / EDD | Know Your Customer / Customer Due Diligence / Enhanced Due Diligence |
| PEP | Politically Exposed Person |
| AML / CTF | Anti-Money Laundering / Counter-Terrorist Financing |
| RG | Responsible Gambling |
| GGR / NGR | Gross Gaming Revenue (stakes minus winnings) / Net Gaming Revenue (GGR minus bonuses and taxes) |
| MLRO | Money Laundering Reporting Officer |
| PSP | Payment Service Provider |
| RTO / RPO | Recovery Time Objective / Recovery Point Objective |
| SLO | Service Level Objective |
| MoSCoW | Priority: Must, Should, Could, Won't (this release) |

### 1.4 References

- ISO/IEC/IEEE 29148:2018, Requirements engineering
- UK Gambling Commission, Remote Gambling and Software Technical Standards (RTS) and LCCP
- Malta Gaming Authority, Player Protection Directive and System Audit requirements
- GLI-33 (Event Wagering Systems) and GLI-19 (Interactive Gaming Systems)
- FATF Recommendations; CEMAC/COBAC AML regulation (for XAF markets)
- EU GDPR 2016/679 and equivalent national data-protection laws
- PCI DSS v4.0; OWASP ASVS 4.0 Level 2; OWASP Top 10
- ISO/IEC 27001:2022
- WCAG 2.2 Level AA

### 1.5 Assumptions and dependencies

| ID | Assumption | Impact if false |
| --- | --- | --- |
| AS-01 | Launch market is a CEMAC country (XAF currency, Mobile Money), which matches repo Versions 1 and 2. Controls are set to the stricter UKGC/MGA standard so that a later licence needs no redesign. | Jurisdiction rules engine values change; core design holds |
| AS-02 | The operator holds or will hold a remote sports-betting licence before go-live. | No real-money launch |
| AS-03 | Sports data comes from a licensed feed (repo uses BetsAPI / b365api); a second feed is contracted for failover. | Single point of failure on odds and results |
| AS-04 | Payments use licensed PSPs and Mobile Money aggregators; the platform does not hold card data (PCI scope reduced to SAQ A). | PCI DSS scope grows to full assessment |
| AS-05 | Crypto deposits are off by default and enabled only where the licence allows. | Custody, travel-rule and wallet-security requirements become Must |
| AS-06 | KYC uses a third-party provider (document plus liveness checks) with local ID support. | Manual KYC capacity must be staffed |
| AS-07 | Cloud hosting in a region the regulator accepts; data residency rules are confirmed by counsel. | Hosting region changes |

Open questions for the product owner: confirm the launch country and licence type; confirm whether the casino and Web3 modules are Release 1; confirm the target concurrent-user figure used in section 6.

## 2. Overall description

The platform is a set of independently deployable services behind one API gateway, serving a responsive web app, native-wrapped mobile apps and a back office. The wallet ledger is the system of record for money; every other service changes balances only through it.

### 2.1 Product perspective

The system replaces the current Express/MongoDB monolith (repo `backend/`) with bounded services. The React player app (`frontend/`) and React admin (`admin/`) remain the client starting points. External systems: sports data and odds feeds, PSPs and Mobile Money aggregators, KYC/AML screening providers, game aggregators (optional), email/SMS/push providers, the regulator's reporting endpoint, and the national self-exclusion register where one exists.

Logical services:

| Service | Responsibility | Owns data |
| --- | --- | --- |
| Identity & Access | Registration, login, MFA, sessions, roles | Users, credentials, sessions |
| Player Profile & KYC | Personal data, verification state, documents | Profiles, KYC cases |
| Wallet & Ledger | Double-entry ledger, balances, holds | Accounts, journal entries |
| Payments | Deposit/withdrawal orchestration with PSPs | Payment transactions |
| Sports Data | Feed ingestion, event and market catalogue | Sports, events, markets, prices |
| Trading & Risk | Margins, limits, liability, suspensions | Risk profiles, liability book |
| Betting | Bet slip validation, acceptance, cash out | Bets, legs |
| Settlement | Result capture, bet grading, payouts | Results, settlements |
| Bonus & Promotions | Bonus rules, wagering, free bets | Campaigns, bonus wallets |
| Responsible Gambling | Limits, time-outs, exclusions, interventions | RG settings, markers |
| Compliance & AML | Screening, monitoring rules, case management | Alerts, cases, SAR log |
| Notifications | Email, SMS, push, in-app, websockets | Templates, delivery log |
| Back Office | Operator UI and APIs, RBAC | Admin users, audit trail |
| Reporting & Data | Warehouse, regulatory and finance reports | Read models |

*Diagram: logical architecture, 4 domains and 14 services. See the diagram in `betting-platform-srs.docx`.*

Payments, betting, settlement and bonuses all post through the wallet ledger; no service writes a balance directly.

### 2.2 Product functions (summary)

1. A player registers, passes age, location and identity checks, and sets deposit limits.
2. The player deposits, browses live and upcoming events, and builds a bet slip.
3. The platform validates the slip against price, market state, limits, balance and RG rules, then accepts or rejects it atomically.
4. Results arrive from the feed; the platform settles bets and credits winnings through the ledger.
5. The player withdraws to a verified payment method after AML checks.
6. Operators trade markets, manage risk, review compliance cases and produce regulatory and financial reports.

### 2.3 User classes

| Class | Description | Access channel | Key needs |
| --- | --- | --- | --- |
| Visitor | Not logged in | Web, mobile | Browse odds, register, read terms |
| Player | Verified adult account holder | Web, mobile | Bet, deposit, withdraw, RG tools |
| Restricted player | Self-excluded, suspended or under review | Web, mobile | Withdraw balance, contact support, no betting |
| Affiliate | Marketing partner | Affiliate portal | Tracking links, commission reports |
| Customer support agent | Operator staff | Back office | View player, add notes, handle tickets |
| Trader | Operator staff | Back office | Manage markets, prices, limits, liability |
| Risk / fraud analyst | Operator staff | Back office | Profile players, review alerts |
| Payments officer | Operator staff | Back office | Approve withdrawals, reconcile PSPs |
| Compliance officer / MLRO | Operator staff | Back office | KYC, AML cases, SAR filing, RG oversight |
| Marketing manager | Operator staff | Back office | Campaigns, bonuses, CMS |
| Super administrator | Operator staff, few named people | Back office | Roles, configuration, jurisdiction rules |
| Auditor / regulator | External, read-only | Reports, audit export | Evidence of control operation |

### 2.4 Operating environment

- Player web: last two major versions of Chrome, Safari, Firefox, Edge, Samsung Internet; Android 9+ and iOS 15+ browsers
- Reference low-end device: Android Go class phone, 2 GB RAM, on a 3G link (1.6 Mbps, 300 ms RTT)
- Mobile apps: Android (APK sideload where store rules forbid gambling, plus Play Store where allowed) and iOS where licensed
- Back office: desktop browsers, 1366×768 minimum
- Servers: containerised (Kubernetes), at least two availability zones, managed relational database, managed cache and message broker

### 2.5 Design and implementation constraints

| ID | Constraint |
| --- | --- |
| CON-01 | Money shall be stored as integer minor units or fixed-point decimal; binary floating point is forbidden for amounts. The current code uses JavaScript `number` with `toFixed` rounding (`backend/src/controllers/base.ts`), which shall be replaced. |
| CON-02 | The ledger shall run on an ACID database with serializable or row-locked transactions. MongoDB may remain for catalogue and feed data only. |
| CON-03 | All times shall be stored in UTC and shown in the player's time zone. The current fixed `America/New_York` zone shall be removed. |
| CON-04 | Odds shall be stored as exact decimals (at least 4 decimal places) and shown in decimal, fractional or American format per player choice. |
| CON-05 | The platform shall be configurable per jurisdiction without code changes (rules engine, section 4.12). |
| CON-06 | Certified components (RNG games, the betting engine where the regulator requires it) shall not change in production without re-certification and change control. |
| CON-07 | TypeScript with strict mode for all new services and clients. |
| CON-08 | Third-party libraries shall be maintained and free of known critical CVEs; `bcrypt-nodejs` and `request` (both unmaintained) shall be replaced. |

### 2.6 User documentation

Player help centre (rules per sport and market, bonus terms, RG guidance, payment FAQs), operator runbooks per back-office module, public API reference for feeds and affiliates, and an operations manual for on-call staff.

## 3. Current repository baseline and gap analysis

The repository is a partial showcase, not a buildable platform: about 2,100 lines of backend TypeScript plus client shells, with the data models, routes, sockets, middleware, sports, payment and settlement code absent. It also contains live-looking secrets and authentication flaws that must be fixed before any reuse. Findings below were read from the main branch on 13 Oct 2026.

### 3.1 What exists

| Area | Evidence in repo | Stack |
| --- | --- | --- |
| Backend API | `backend/src/index.ts`, `controllers/base.ts`, `controllers/users/*` (sign-in, sign-up, MetaMask and Solana address sign-in, password reset, referral, sessions, permissions, login history) | Node.js, Express 4, Mongoose 6, Socket.IO 4, TypeScript 4.7 |
| Odds feed | `.env.example` points to BetsAPI (b365api) in-play, upcoming, ended, odds, league and team endpoints, polled by cron every 5 s; feed scripts named in `package.json` (`matchs1`, `odds1`, `results`) are missing | REST polling |
| Bet limits | `getActiveBet` and `checkMaxBet` in `base.ts`; per-currency `minBet`, `maxBet`, `betLimit` (`set-bet-limit.ts`) | MongoDB |
| Wallet | `Balances` and `BalanceHistories` collections updated with `$inc`; SOL, ETH, BSC RPC helpers in `utils/payments.ts` | MongoDB, web3.js, @solana/web3.js |
| Player app | `frontend/src`: navigation, Redux store, types for sports, events, odds, currency, balance; pages and components are missing | React 17, MUI 5, web3-react |
| Admin app | `admin/src/router/routes`: dashboard, users, login history, online users, permissions, sports lists and leagues, brackets; view files are missing | React 17, Redux |
| Product variants | README: V1 crypto sportsbook (SOL, XAF), V2 sportsbook plus casino with Mobile Money (XAF), V3 Azuro on-chain sportsbook (Polygon) | Demo media only |
| Tests and CI | One default `admin/src/App.test.js`; no CI workflow | None |

### 3.2 Defects and risks found

| # | Finding | Location | Severity | Required action (requirement) |
| --- | --- | --- | --- | --- |
| G-01 | Access and refresh tokens are `md5(userId + expiration)`: both identical and predictable, so tokens can be forged | `base.ts` `signAccessToken` | Critical | Replace with signed, random tokens (SEC-AUTH-003) |
| G-02 | Secrets committed: `ADMIN_TOKEN`, `SESSION_SECRET`, `ENCRYPTION_KEY`, Infura key in `.env.example`; QuickNode and NodeReal RPC keys hard-coded | `backend/.env.example`, `utils/payments.ts` | Critical | Rotate every key, purge from git history, use a secrets manager (SEC-SEC-001, -002) |
| G-03 | Log download authorised by `ADMIN_TOKEN` in the URL and builds a file path from a URL parameter (path traversal risk) | `base.ts` `log` | High | Remove; logs only through the log platform with RBAC (SEC-LOG-004) |
| G-04 | Login lookup uses an unescaped, unanchored-end regex on user input: regex injection and a login name matching the wrong account by prefix; sign-up duplicate checks fail the same way | `users/index.ts`, `users/admin.ts` | High | Exact, normalised, indexed match (FR-ACC-004) |
| G-05 | Brute-force limit set to 10,000 failures; global API rate limits commented out | `base.ts`, `index.ts` | High | SEC-AUTH-006, NFR-CAP-005 |
| G-06 | Balance change and ledger history are separate writes with no transaction and no non-negative guard; referral bonus history records the wrong before-balance | `base.ts` `handleBet`, `balanceUpdate` | High | Double-entry ledger (FR-WAL-001 to -008) |
| G-07 | Money held as floating point and rounded with `toFixed(10)` | `base.ts` `NumberFix` | High | CON-01 |
| G-08 | Socket.IO accepts any origin; session cookie domain is hard-coded; `saveUninitialized: true` | `index.ts` | Medium | SEC-API-004 |
| G-09 | reCAPTCHA can be skipped by an environment flag and is only enforced when `MODE=pro` | `base.ts`, `users/index.ts` | Medium | SEC-AUTH-007 |
| G-10 | Unmaintained libraries (`bcrypt-nodejs`, `request`), Node and React versions past end of support | `package.json` files | Medium | CON-08 |
| G-11 | No KYC, responsible-gambling, AML, settlement-audit or regulatory-reporting functions | Whole repo | Blocking for licence | Sections 4.1, 4.8, 4.9, 4.13 |
| G-12 | No automated tests, CI, IaC or monitoring | Whole repo | High | Sections 6.5 and 8.2 |
| G-13 | Unrelated content in history (sorting algorithms, Wordle, portfolio generator commits) | Git log | Low | Clean repository before audit |

### 3.3 Reuse decision

Reuse the domain vocabulary (sports, leagues, events, currencies with min/max/limit), the admin information architecture and the UI designs shown in the version media. Rebuild the backend, auth, wallet and data layer to this SRS. Treat G-01 and G-02 as live incidents: rotate keys now, even before development starts.

## 4. Functional requirements

The platform has 19 functional modules and 186 functional requirements; 17 modules are Release 1 and two (casino, on-chain) are optional Release 2. Each requirement uses "shall" and is atomic and testable.

### 4.0 Conventions

- ID format: `FR-<MODULE>-<NNN>`. IDs are never reused; a deleted requirement keeps its ID with status "Deleted".
- Priority (Pri): M = Must, S = Should, C = Could (MoSCoW). All M items are required for go-live.
- Verification (Ver): T = Test, D = Demonstration, I = Inspection, A = Analysis.
- "Configurable" means changeable by an authorised back-office role without a deployment, with the change recorded in the audit log (FR-BO-010).
- Default values in brackets are starting values for the launch jurisdiction (AS-01).

### 4.1 Registration and account management (ACC)

| ID | Requirement | Pri | Ver |
| --- | --- | --- | --- |
| FR-ACC-001 | The system shall let a visitor register with email or mobile number, password, full legal name, date of birth, nationality, residential address, currency and acceptance of terms, privacy notice and age declaration. | M | T |
| FR-ACC-002 | The system shall reject registration when the declared age is below the jurisdiction minimum \[18\], and shall record the attempt. | M | T |
| FR-ACC-003 | The system shall verify email ownership by a single-use link and mobile ownership by a 6-digit OTP, each valid for \[15\] minutes. | M | T |
| FR-ACC-004 | The system shall enforce uniqueness of email, mobile number and username by exact match after normalisation (lower case, trimmed, E.164 for phones). | M | T |
| FR-ACC-005 | The system shall detect probable duplicate accounts by matching name plus date of birth, address, device fingerprint, payment instrument and IP, and shall flag them for review before first withdrawal. | M | T |
| FR-ACC-006 | The system shall allow one account per person; a confirmed duplicate shall be closed and its balance handled per terms. | M | D |
| FR-ACC-007 | The system shall check the national self-exclusion register (where available) and the internal exclusion list at registration and at each login, and shall block excluded persons. | M | T |
| FR-ACC-008 | The system shall support login by email/username/phone and password, and optional MFA by TOTP app or SMS OTP. | M | T |
| FR-ACC-009 | The system shall require MFA for withdrawals to a new payment method and for changes to email, phone, password or payment details. | M | T |
| FR-ACC-010 | The system shall provide password reset by single-use, time-limited \[30 min\] token, and shall end all other sessions after a reset. | M | T |
| FR-ACC-011 | The system shall show the player their last login time, IP location and device on each login. | S | D |
| FR-ACC-012 | The system shall let a player view and edit contact details, preferences (odds format, language, time zone, marketing consent per channel) and see read-only verified fields. | M | T |
| FR-ACC-013 | Changes to legal name, date of birth or address after verification shall require a new document check. | M | T |
| FR-ACC-014 | The system shall support account states: Pending verification, Active, Restricted (no deposits/bets), Suspended, Self-excluded, Timed-out, Closed, Dormant; each state shall define which actions are allowed. | M | T |
| FR-ACC-015 | The system shall let a player close their account themselves, and shall show the balance-withdrawal steps first. | M | T |
| FR-ACC-016 | The system shall mark an account Dormant after \[12\] months without login and shall notify the player before any dormancy fee where local law allows. | S | T |
| FR-ACC-017 | The system shall provide a full account history: bets, transactions, bonuses, logins, limit changes, exportable as CSV and PDF. | M | T |
| FR-ACC-018 | The system shall end a session after \[30\] minutes of inactivity and after an absolute \[12\] hours, and shall let the player view and revoke active sessions. | M | T |
| FR-ACC-019 | The system shall support wallet-address sign-in (MetaMask, Phantom) only as a linked login method on a KYC-verified account, never as an anonymous account, unless the Web3 module (FR-W3) is licensed for it. | C | T |
| FR-ACC-020 | The system shall support at least English and French at launch and shall allow new languages by translation files only. | M | I |

### 4.2 Identity, age and location verification (KYC)

| ID | Requirement | Pri | Ver |
| --- | --- | --- | --- |
| FR-KYC-001 | The system shall verify age and identity before the player can deposit or bet \[UKGC model\]; a configuration shall allow a jurisdiction to permit deposit before verification within a \[72\]-hour or \[XAF 1,000,000\] limit. | M | T |
| FR-KYC-002 | The system shall run electronic identity verification through the KYC provider and fall back to document upload (passport, national ID, driving licence) plus liveness selfie. | M | T |
| FR-KYC-003 | The system shall accept JPG, PNG and PDF uploads up to \[10\] MB, scan them for malware, and store them encrypted. | M | T |
| FR-KYC-004 | The system shall require proof of address dated within \[3\] months when e-verification cannot confirm the address. | M | T |
| FR-KYC-005 | The system shall screen every player against sanctions, PEP and adverse-media lists at registration and daily thereafter, and shall raise an alert on a match. | M | T |
| FR-KYC-006 | The system shall trigger Enhanced Due Diligence (source of funds or source of wealth documents) when cumulative deposits reach configurable thresholds \[EUR 2,000 equivalent in 30 days, EUR 10,000 lifetime\] or a risk score is High. | M | T |
| FR-KYC-007 | The system shall block withdrawals while an EDD request is open beyond \[30\] days, and shall restrict betting per the compliance officer's decision. | M | T |
| FR-KYC-008 | The system shall provide a KYC case queue with SLA timers, four-eyes approval for rejections and High-risk approvals, and a full decision history. | M | D |
| FR-KYC-009 | The system shall determine the player's location by IP geolocation at login and at each bet, and by device GPS in apps where the licence requires it; it shall block access from prohibited territories and detect VPN, proxy and Tor use. | M | T |
| FR-KYC-010 | The system shall store the KYC level (None, Basic, Full, Enhanced) and gate features by level through the rules engine (FR-JUR). | M | T |
| FR-KYC-011 | The system shall re-verify identity documents on expiry and request updated documents \[30\] days before. | S | T |
| FR-KYC-012 | The system shall assign each player a customer risk rating (Low, Medium, High) from geography, PEP status, deposit methods, velocity and behaviour, recalculated on each relevant event. | M | T |

### 4.3 Wallet and ledger (WAL)

| ID | Requirement | Pri | Ver |
| --- | --- | --- | --- |
| FR-WAL-001 | The system shall keep all player and operator money in a double-entry ledger where every journal entry has balanced debits and credits and is immutable once posted. | M | T, I |
| FR-WAL-002 | Each player shall have separate ledger accounts per currency for: cash (withdrawable), bonus (restricted), pending withdrawal, and bet holds. | M | T |
| FR-WAL-003 | Every balance-changing operation shall be one ACID transaction that writes the journal entry and updates the balance projection together, keyed by an idempotency key so that a retry never posts twice. | M | T |
| FR-WAL-004 | The system shall reject any operation that would make a player cash or bonus account negative. | M | T |
| FR-WAL-005 | Stake debit shall follow the order: bonus or cash per the active bonus rules (FR-BON-006), recorded per leg funding source so that winnings and voids return to the right account. | M | T |
| FR-WAL-006 | The system shall push balance changes to the player's open clients within \[1\] s by websocket. | M | T |
| FR-WAL-007 | Corrections shall be new reversing entries with a reason code and the approver's ID; editing or deleting a posted entry shall be impossible at database permission level. | M | T, I |
| FR-WAL-008 | The system shall reconcile the sum of player balances to the ledger control accounts every hour and alert on any difference above \[0\] minor units. | M | T |
| FR-WAL-009 | The system shall hold player funds segregated from operator funds and report the daily player-liability total to finance, so protected-funds requirements can be evidenced. | M | A |
| FR-WAL-010 | The system shall support multiple currencies per jurisdiction configuration \[XAF, EUR, USD at launch\]; one player shall hold one primary currency; conversion shall use a recorded rate snapshot. | M | T |
| FR-WAL-011 | Manual adjustments shall require a reason, a second approver above \[XAF 100,000\], and shall appear in the player's history with a neutral label. | M | T |

### 4.4 Payments: deposits and withdrawals (PAY)

| ID | Requirement | Pri | Ver |
| --- | --- | --- | --- |
| FR-PAY-001 | The system shall support deposits by Mobile Money (MTN MoMo, Orange Money via aggregator), debit card (hosted fields or redirect, 3-D Secure 2) and bank transfer; methods shall be configurable per country and currency. | M | T |
| FR-PAY-002 | The system shall support crypto deposits (SOL, USDT, USDC, ETH) only when enabled for the jurisdiction (AS-05), with deposit address per player, confirmation thresholds per chain and on-chain amount reconciliation. | C | T |
| FR-PAY-003 | The system shall enforce configurable minimum and maximum deposit amounts per method and currency. | M | T |
| FR-PAY-004 | Before accepting a deposit, the system shall check the player's deposit limits (FR-RG-001), account state, KYC level and the instrument owner's name where the PSP returns it. | M | T |
| FR-PAY-005 | The system shall credit a deposit only on a PSP-confirmed success (signed webhook or status poll), never on client redirect alone. | M | T |
| FR-PAY-006 | The system shall verify every PSP webhook signature, reject replays by event ID, and reconcile pending transactions by polling after \[5\] minutes without a callback. | M | T |
| FR-PAY-007 | The system shall apply a closed-loop rule: withdrawals go to the method used to deposit, up to the deposited amount, before any other method is allowed. | M | T |
| FR-PAY-008 | The system shall require Full KYC before the first withdrawal and shall pay only to instruments in the player's verified name. | M | T |
| FR-PAY-009 | On a withdrawal request the system shall move funds from cash to pending withdrawal, let the player cancel until processing starts (unless the jurisdiction bans reversal), and run automated checks: KYC, AML risk, bonus wagering, duplicate accounts, unsettled disputes. | M | T |
| FR-PAY-010 | Withdrawals passing all checks and below \[XAF 500,000\] shall be auto-approved; others go to the payments queue with \[24\] h SLA and four-eyes approval above \[XAF 5,000,000\]. | M | T |
| FR-PAY-011 | The system shall show the player the status of each payment: Initiated, Pending, Processing, Completed, Failed, Cancelled, Reversed, with reason on failure. | M | D |
| FR-PAY-012 | The system shall apply configurable fees per method \[withdrawal fee 1.25 % for crypto, matching repo `WFEE`\] and show the fee before confirmation. | S | T |
| FR-PAY-013 | The system shall handle chargebacks and Mobile Money reversals by restricting the account, posting a reversing entry and opening a risk case. | M | T |
| FR-PAY-014 | The system shall produce a daily settlement reconciliation per PSP, matching platform transactions to PSP reports, and list unmatched items. | M | T |
| FR-PAY-015 | The system shall route payments across at least two PSPs per method where available, with failover on PSP error rate above \[5\] % in \[5\] minutes. | S | T |

### 4.5 Sports data, events and markets (SPD)

| ID | Requirement | Pri | Ver |
| --- | --- | --- | --- |
| FR-SPD-001 | The system shall ingest sports, competitions, events, participants, markets, prices, live scores and results from a primary feed and a secondary feed, through push (websocket or AMQP) where offered and polling otherwise. | M | T |
| FR-SPD-002 | The system shall map feed entities to one internal catalogue with stable internal IDs, and shall provide a mapping tool for unmatched entities. | M | D |
| FR-SPD-003 | The system shall support at launch: soccer, basketball, tennis, table tennis, volleyball, ice hockey, MMA/UFC, boxing, cricket, eSports (CS2, Dota 2, LoL), with sports configurable. | M | D |
| FR-SPD-004 | The system shall support market types: 1X2, Double Chance, Draw No Bet, Asian Handicap (incl. quarter lines), European Handicap, Over/Under (incl. Asian totals), Both Teams To Score, Correct Score, Half-time/Full-time, first/second half markets, player props, outrights, and period markets for each sport. | M | T |
| FR-SPD-005 | Each market shall have a state: Open, Suspended, Closed, Settled, Voided; only Open markets shall accept bets. | M | T |
| FR-SPD-006 | The system shall suspend all markets of an event within \[1\] s of a feed suspension signal, a dangerous-attack or goal-in-progress flag, or loss of feed heartbeat for more than \[5\] s on live events. | M | T |
| FR-SPD-007 | The system shall close pre-match markets automatically at the scheduled start time unless the event is offered in-play. | M | T |
| FR-SPD-008 | The system shall flag and suspend an event whose start time or participants change in the feed, pending trader review. | M | T |
| FR-SPD-009 | The system shall keep a time-stamped history of every price and state change for each selection for at least \[5\] years, to resolve disputes and support integrity investigations. | M | T |
| FR-SPD-010 | The system shall show live match data: score, clock, period, and a match tracker or stream where licensed. | S | D |
| FR-SPD-011 | The system shall provide search across sports, competitions, teams and events, returning results within \[300\] ms at p95. | S | T |
| FR-SPD-012 | The system shall let traders create events and markets manually (specials, outrights) with the same lifecycle as feed markets. | M | D |
| FR-SPD-013 | The system shall fail over to the secondary feed per sport when the primary feed is stale beyond \[10\] s, and shall suspend markets that cannot be priced. | M | T |

### 4.6 Trading and risk management (RSK)

| ID | Requirement | Pri | Ver |
| --- | --- | --- | --- |
| FR-RSK-001 | The system shall apply a configurable margin per sport, competition, market type and in-play state to feed prices, and shall round displayed odds to a configured ladder. | M | T |
| FR-RSK-002 | The system shall let traders override a price, suspend or reopen a selection, market or event, with each action audited. | M | T |
| FR-RSK-003 | The system shall compute live liability per selection, market, event and competition in real time, updated within \[1\] s of bet acceptance. | M | T |
| FR-RSK-004 | The system shall enforce stake limits as the lowest of: global, sport, competition, market, selection, player risk profile, and maximum payout per bet \[XAF 50,000,000\]. | M | T |
| FR-RSK-005 | The system shall support player risk profiles (stake factor 0.01 to 10.0) assigned manually or by rule, applied to all stake limits. | M | T |
| FR-RSK-006 | The system shall auto-suspend or reprice a market when its liability exceeds a configured threshold, and alert the trader. | M | T |
| FR-RSK-007 | The system shall route bets above a configurable stake or liability threshold to a trader for manual accept, reject or counter-offer within \[30\] s, then auto-reject on timeout. | S | T |
| FR-RSK-008 | The system shall apply an in-play bet delay per sport \[soccer 7 s, tennis 5 s, basketball 5 s\], re-validating the price and market state at the end of the delay. | M | T |
| FR-RSK-009 | The system shall detect correlated selections in one multiple (same event, contingent outcomes) and either block them or price them through a bet-builder pricing service. | M | T |
| FR-RSK-010 | The system shall flag patterns indicating arbitrage, bonus abuse, late betting, syndicate or match-fixing activity (unusual stakes on low-tier events, price-move-led betting) and raise alerts. | M | T |
| FR-RSK-011 | The system shall report suspicious betting on an event to the sports integrity body (for example IBIA or Sportradar Integrity) through a recorded workflow. | S | D |
| FR-RSK-012 | The system shall provide trader screens: liability ladder, top exposures, bet ticker with filters, and a per-event P&L forecast. | M | D |

### 4.7 Bet placement (BET)

| ID | Requirement | Pri | Ver |
| --- | --- | --- | --- |
| FR-BET-001 | The system shall provide a bet slip that keeps selections across pages and sessions, shows each price, potential return, total stake, balance after bet and any bonus applied. | M | D |
| FR-BET-002 | The system shall support bet types: Single, Multiple (2 to \[30\] legs), System (Doubles, Trebles, Trixie, Patent, Yankee, Lucky 15/31/63, Heinz, Super Heinz, Goliath, and n-from-m), and each-way on outrights. | M | T |
| FR-BET-003 | The system shall validate on submission, in one atomic operation: session, account state, location, RG limits, KYC level, market Open, price unchanged or within the player's acceptance setting, stake within min and max limits, maximum payout, sufficient funds. | M | T |
| FR-BET-004 | The system shall offer the player odds-change settings: accept none, accept higher only, accept any; default "accept higher only". | M | T |
| FR-BET-005 | On acceptance, the system shall debit the stake through the ledger, store the bet with each leg's price, market line, timestamps (submitted, accepted), channel, IP and device, and return a unique bet reference. | M | T |
| FR-BET-006 | The system shall make bet submission idempotent by a client-generated request ID, so a resubmitted request returns the original result. | M | T |
| FR-BET-007 | The system shall return a specific reason for each rejection (price changed, market suspended, stake above max with the allowed max, insufficient funds, limit reached). | M | T |
| FR-BET-008 | The system shall offer cash out (full and partial) on eligible open bets at a price derived from current prices and a configurable cash-out margin, re-validated after an in-play delay; cash out shall be suspendable per market. | S | T |
| FR-BET-009 | The system shall support booking codes: save a slip as a short code \[8 alphanumeric\] that any user can load, with prices refreshed on load (repo V2 feature). | S | T |
| FR-BET-010 | The system shall support quick bets and one-click betting with a player-set default stake, off by default. | C | T |
| FR-BET-011 | The system shall show the player open and settled bets with filters, full leg detail, status and settlement reason. | M | D |
| FR-BET-012 | The system shall never allow a bet to be cancelled by the player after acceptance, except within a jurisdiction-mandated cooling window where configured. | M | T |
| FR-BET-013 | The system shall support bet builder (same-game multiples) priced by a dedicated pricing service. | C | T |
| FR-BET-014 | The system shall display odds in decimal, fractional or American format and, where required, the implied probability. | M | T |
| FR-BET-015 | The system shall time-stamp acceptance with a synchronised clock (NTP, drift under \[100\] ms) so that late-bet voids can be proven. | M | I |

### 4.8 Result capture and settlement (STL)

| ID | Requirement | Pri | Ver |
| --- | --- | --- | --- |
| FR-STL-001 | The system shall capture results from the primary feed and confirm them against the secondary feed or a trader before settling; mismatches shall go to a settlement queue. | M | T |
| FR-STL-002 | The system shall settle each leg as Won, Lost, Void, Half-won or Half-lost (Asian lines), Dead-heat reduced, or Each-way place, following the published sport rules. | M | T |
| FR-STL-003 | The system shall compute multiple and system bet returns from leg results, treating void legs at odds 1.00. | M | T |
| FR-STL-004 | The system shall settle at least \[95\] % of bets within \[2\] minutes of a confirmed result and 100 % within \[15\] minutes, excluding queued disputes. | M | T |
| FR-STL-005 | Settlement shall be idempotent: re-running settlement for a market shall not post duplicate payouts. | M | T |
| FR-STL-006 | The system shall support resettlement after a result correction, posting only the difference through the ledger and notifying affected players. | M | T |
| FR-STL-007 | The system shall void bets placed after the event start (pre-match markets) or after a material event (in-play), using the feed's event timestamps (late-bet / bet-after-off rule). | M | T |
| FR-STL-008 | The system shall void markets on abandoned, postponed beyond \[48\] h, or walkover events per the sport rules. | M | T |
| FR-STL-009 | The system shall let a trader manually settle, void or resettle a market with a reason; voiding above \[XAF 10,000,000\] total stake shall need a second approver. | M | T |
| FR-STL-010 | The system shall credit winnings to the funding source rules of FR-WAL-005 and apply any jurisdictional winnings tax before credit, showing gross, tax and net. | M | T |
| FR-STL-011 | The system shall settle cashed-out bets at cash out and exclude them from later result settlement. | S | T |
| FR-STL-012 | The system shall record the settlement source, result data version and operator (if manual) for each settled leg. | M | I |

*Diagram: bet lifecycle, 8 states. See the diagram in `betting-platform-srs.docx`.*

Validation (FR-BET-003) runs again at the end of the in-play delay (FR-RSK-008); only accepted bets debit the stake, and resettlement posts only the difference (FR-STL-006).

### 4.9 Responsible gambling (RG)

| ID | Requirement | Pri | Ver |
| --- | --- | --- | --- |
| FR-RG-001 | The system shall let a player set deposit limits per day, week and month; the system shall prompt for limits at registration. | M | T |
| FR-RG-002 | The system shall also offer loss limits, stake limits (per bet and per period) and session time limits. | M | T |
| FR-RG-003 | A decrease in any limit shall apply immediately; an increase or removal shall apply only after a \[24\] h cooling-off and an explicit re-confirmation by the player. | M | T |
| FR-RG-004 | The system shall offer time-out (24 h, 7 days, 6 weeks) and self-exclusion (6 months, 1 year, 5 years, permanent), effective immediately and irreversible by the player or staff before expiry. | M | T |
| FR-RG-005 | During time-out or self-exclusion the system shall block login to betting, deposits and all marketing, while allowing balance withdrawal and access to support. | M | T |
| FR-RG-006 | At self-exclusion the system shall prompt withdrawal of the balance, cancel pending bonuses per terms, and offer links to support organisations and blocking software. | M | D |
| FR-RG-007 | Self-exclusion shall apply across all brands run on the platform and shall be shared with the national scheme where one exists. | M | T |
| FR-RG-008 | The system shall show a reality check every \[60\] minutes (player-configurable 15 to 120) with session duration and net result, requiring acknowledgement to continue. | M | T |
| FR-RG-009 | The system shall show the session timer and net position for the current session in the header at all times. | S | D |
| FR-RG-010 | The system shall calculate a player harm-risk score from markers: deposit velocity, declined deposits, chasing losses, night-time play, limit increases, cancelled withdrawals, rising stakes, time on site; scored at least hourly. | M | T |
| FR-RG-011 | On configurable risk levels the system shall trigger interventions: in-app message, mandatory RG questionnaire, agent call task, deposit cap, or suspension; each intervention and outcome shall be recorded. | M | T |
| FR-RG-012 | The system shall run affordability checks at configured net-deposit thresholds \[EUR 500 / 30 days equivalent\], requesting income evidence or using credit-reference data where lawful, and shall cap deposits until resolved. | M | T |
| FR-RG-013 | The system shall forbid credit betting and shall not let a player deposit with a credit card where the jurisdiction bans it. | M | T |
| FR-RG-014 | The system shall block the reversal of a withdrawal where the jurisdiction requires it. | M | T |
| FR-RG-015 | The system shall provide an RG page with tools, self-assessment test, and support contacts, reachable in one click from every page. | M | I |
| FR-RG-016 | The system shall exclude from marketing any player who is self-excluded, timed-out, at High harm-risk, or has opted out. | M | T |

### 4.10 Bonuses and promotions (BON)

| ID | Requirement | Pri | Ver |
| --- | --- | --- | --- |
| FR-BON-001 | The system shall support bonus types: deposit match (for example 200 % up to XAF 100,000, as in repo V2), free bet (stake not returned), risk-free bet refund, odds boost, accumulator boost/insurance, cashback, and loyalty points. | M | T |
| FR-BON-002 | Each campaign shall define eligibility (segment, country, currency, KYC level, first deposit), award trigger, value, cap, wagering requirement, minimum odds per leg, eligible markets, expiry and maximum conversion. | M | T |
| FR-BON-003 | The system shall require explicit opt-in to each bonus and shall show its full terms before opt-in. | M | T |
| FR-BON-004 | The system shall track wagering progress in real time and show it to the player. | M | D |
| FR-BON-005 | The system shall let a player forfeit a bonus at any time, removing bonus funds and winnings derived from them, never cash funds. | M | T |
| FR-BON-006 | The system shall not lock the player's own deposited cash behind bonus wagering; cash shall be staked first and remain withdrawable \[UKGC rule\]. | M | T |
| FR-BON-007 | The system shall limit one welcome bonus per person, household, device and payment instrument, using the duplicate-account checks of FR-ACC-005. | M | T |
| FR-BON-008 | The system shall support raffles and jackpots (repo V2) with draws using a certified RNG, published rules, and an auditable draw record. | C | T |
| FR-BON-009 | The system shall cap total bonus cost per campaign and stop awards when the budget is used. | S | T |
| FR-BON-010 | The system shall exclude RG-flagged and self-excluded players from all offers (FR-RG-016). | M | T |

### 4.11 Back office (BO)

| ID | Requirement | Pri | Ver |
| --- | --- | --- | --- |
| FR-BO-001 | The back office shall use role-based access control with least-privilege default roles matching section 2.3, and fine-grained permissions per action (view, create, update, approve, export). | M | T |
| FR-BO-002 | Back-office login shall require SSO with phishing-resistant MFA (FIDO2/WebAuthn) and IP allow-listing or VPN. | M | T |
| FR-BO-003 | Personal data in back-office views shall be masked by default (partial email, phone, document numbers) and unmasked only with permission, with the reveal logged. | M | T |
| FR-BO-004 | The player 360 view shall show profile, KYC status, risk ratings, RG settings and markers, balances, transactions, bets, bonuses, sessions, notes, cases and communications on one screen. | M | D |
| FR-BO-005 | The dashboard shall show, per currency and period: registrations, FTDs, active players, logins, deposits, withdrawals, stakes, GGR, NGR, bonus cost, open bets, and margin by sport (extends the repo admin dashboard). | M | D |
| FR-BO-006 | The back office shall provide sport, competition, event and market management, including manual events, display order, featured events and sport icons. | M | D |
| FR-BO-007 | The back office shall provide CMS functions: banners, promotions pages, help articles, terms versions, translated content, with preview and scheduled publish. | S | D |
| FR-BO-008 | The back office shall allow configuration of currencies (min/max bet, max payout, min deposit/withdrawal, enabled flags) with change history, replacing the repo `set-bet-limit.ts` script. | M | T |
| FR-BO-009 | All exports shall be permission-controlled, watermarked with user and time, and logged. | M | T |
| FR-BO-010 | Every back-office write action shall create an audit record: who, when, from where, what changed (before/after), why (reason field mandatory for money, limits, KYC, RG and settlement actions). | M | T |
| FR-BO-011 | Defined sensitive actions shall require four-eyes approval: manual balance adjustments above threshold, large withdrawals, KYC rejection, removal of restrictions, manual settlement above threshold, role grants. | M | T |
| FR-BO-012 | The back office shall provide a support ticket view linked to the player, with templates and SLA timers, or integrate with the chosen helpdesk (FR-SUP). | S | D |

### 4.12 Jurisdiction rules engine (JUR)

| ID | Requirement | Pri | Ver |
| --- | --- | --- | --- |
| FR-JUR-001 | The system shall hold a versioned rules set per jurisdiction covering: minimum age, allowed and blocked countries/regions, KYC timing and levels, mandatory RG limits and defaults, reality-check interval, cooling-off periods, allowed payment methods, credit-card ban, bonus restrictions, winnings tax, in-play rules, withdrawal reversal, data retention and reporting formats. | M | T |
| FR-JUR-002 | The rules set applied to a player shall be determined by licence and verified residence, not by IP alone. | M | T |
| FR-JUR-003 | Rule changes shall require compliance-officer approval, take effect at a scheduled time, and keep previous versions for audit. | M | T |
| FR-JUR-004 | The system shall support multiple brands (white label) on one platform, each with its own domain, theme, licence, rules set, currencies and content, sharing exclusion data across brands. | S | T |

### 4.13 Anti-money-laundering and fraud (AML)

| ID | Requirement | Pri | Ver |
| --- | --- | --- | --- |
| FR-AML-001 | The system shall run transaction-monitoring rules in near real time, including: deposit and withdraw with little play (below \[30\] % turnover of deposits), structuring below thresholds, rapid deposit velocity, many instruments per account, many accounts per instrument, high-risk geography, and low-risk betting on both sides. | M | T |
| FR-AML-002 | Rules shall be configurable (threshold, window, segment) and testable on historical data before activation. | S | T |
| FR-AML-003 | Alerts shall create cases with priority, SLA, assignee, evidence attachments, notes and disposition (no action, restrict, EDD, SAR, close account). | M | D |
| FR-AML-004 | The MLRO shall be able to file a Suspicious Activity Report, record its reference, and the system shall prevent tipping-off (no player-visible trace of the SAR). | M | T |
| FR-AML-005 | The system shall require a minimum turnover of \[1×\] deposits before withdrawal to a different method, configurable per jurisdiction. | S | T |
| FR-AML-006 | The system shall compute device fingerprints and link accounts sharing devices, IPs, payment instruments or addresses in a graph view. | M | D |
| FR-AML-007 | The system shall score payment fraud risk on each deposit (velocity, BIN country vs residence, 3-DS result) and block or review high scores. | M | T |
| FR-AML-008 | The system shall keep AML records (KYC, transactions, cases) for at least \[5\] years after the business relationship ends, or longer if local law requires. | M | I |
| FR-AML-009 | For crypto (if enabled) the system shall screen deposit source addresses with a blockchain-analytics provider and comply with the travel rule for transfers above the local threshold. | C | T |

### 4.14 Notifications and communications (NTF)

| ID | Requirement | Pri | Ver |
| --- | --- | --- | --- |
| FR-NTF-001 | The system shall send transactional messages by email, SMS and push: verification, password reset, deposit and withdrawal status, bet settlement (opt-in), limit changes, RG actions, security alerts. | M | T |
| FR-NTF-002 | Marketing messages shall be sent only with recorded per-channel consent and shall include a one-click unsubscribe. | M | T |
| FR-NTF-003 | The system shall push real-time updates to clients over websockets: prices, market states, scores, balance, bet status. | M | T |
| FR-NTF-004 | Templates shall be versioned, translated and editable in the back office; every send shall be logged with delivery status. | S | D |
| FR-NTF-005 | The system shall provide an in-app message centre that keeps messages for \[90\] days. | C | D |

### 4.15 Reporting and analytics (REP)

| ID | Requirement | Pri | Ver |
| --- | --- | --- | --- |
| FR-REP-001 | The system shall produce regulatory reports in the regulator's format and schedule: GGR and tax returns, player-funds liability, large transactions, self-exclusions, RG interventions, complaints and disputes. | M | T |
| FR-REP-002 | The system shall produce finance reports: daily ledger trial balance, PSP reconciliation, player liability, bonus cost, GGR/NGR by product, sport, market, channel and currency. | M | T |
| FR-REP-003 | The system shall produce trading reports: margin achieved vs theoretical, P&L by sport, competition, market type, in-play vs pre-match, and by player risk profile. | M | D |
| FR-REP-004 | The system shall feed a data warehouse within \[15\] minutes of each business event through change-data capture or event streams, without load on transactional databases. | S | T |
| FR-REP-005 | The system shall support a regulator real-time data vault (safe server) where the licence requires it. | S | T |
| FR-REP-006 | The system shall capture product analytics events (funnel: landing, registration start, registration complete, KYC pass, first deposit, first bet) with consent, to find drop-off points. | S | T |
| FR-REP-007 | Reports shall be reproducible: re-running a report for a closed period shall give the same figures. | M | T |

### 4.16 Affiliates and referrals (AFF)

| ID | Requirement | Pri | Ver |
| --- | --- | --- | --- |
| FR-AFF-001 | The system shall attribute registrations to affiliates through tracking links, promo codes and server-to-server postbacks. | S | T |
| FR-AFF-002 | The system shall support commission plans: CPA, revenue share on NGR (with or without negative carry-over), hybrid. | S | T |
| FR-AFF-003 | The system shall provide an affiliate portal with statistics, creatives and payments. | C | D |
| FR-AFF-004 | The player referral programme (repo `iReferral`/`rReferral`) shall pay a referral reward only after the referred player passes KYC and meets a qualifying activity, and shall be blocked for linked accounts. | S | T |
| FR-AFF-005 | Affiliate content and marketing shall follow jurisdiction advertising rules; the system shall let compliance suspend an affiliate immediately. | S | D |

### 4.17 Customer support and complaints (SUP)

| ID | Requirement | Pri | Ver |
| --- | --- | --- | --- |
| FR-SUP-001 | The system shall offer contact by live chat, email and a web form, reachable from every page, and a phone line where the licence requires it. | M | D |
| FR-SUP-002 | The system shall log every complaint with a reference, acknowledge within \[48\] h, resolve within \[8\] weeks, and refer to the approved ADR body if unresolved. | M | T |
| FR-SUP-003 | Agents shall verify caller identity by knowledge questions or in-app confirmation before discussing an account. | M | D |

### 4.18 Casino lobby, optional Release 2 (CAS)

| ID | Requirement | Pri | Ver |
| --- | --- | --- | --- |
| FR-CAS-001 | The system shall integrate certified third-party games (slots, live dealer, crash games such as those in repo V2) through one aggregator using the same wallet via seamless-wallet API. | C | T |
| FR-CAS-002 | Game round debits and credits shall be idempotent ledger operations keyed by the aggregator's round and transaction IDs, with rollback handling. | C | T |
| FR-CAS-003 | The system shall show each game's RTP and rules, enforce jurisdiction game restrictions (spin speed, autoplay, bet limits), and apply all RG limits across casino and sports. | C | T |

### 4.19 On-chain betting, optional Release 2 (W3)

| ID | Requirement | Pri | Ver |
| --- | --- | --- | --- |
| FR-W3-001 | Where licensed, the system shall offer non-custodial betting through the Azuro protocol (repo V3) with wallet connect, showing chain, token and gas costs before signing. | C | D |
| FR-W3-002 | The on-chain front end shall still apply geolocation blocking, age confirmation, sanctions screening of the wallet address and RG messaging. | C | T |

## 5. External interface requirements

All external integrations sit behind adapter services with a common contract, so a provider can be swapped without changing core services.

### 5.1 User interfaces

| ID | Requirement | Pri | Ver |
| --- | --- | --- | --- |
| IF-UI-001 | The player app shall be responsive from 320 px to 2560 px width, mobile-first, with a bottom navigation bar and a persistent bet-slip control on mobile. | M | D |
| IF-UI-002 | The player app shall meet WCAG 2.2 AA: keyboard operable, screen-reader labels on odds buttons, contrast 4.5:1, no information carried by colour alone (odds up/down arrows plus colour). | M | T |
| IF-UI-003 | Every page shall show: the age symbol (18+), the RG link, licence number and regulator logo, and the account balance when logged in. | M | I |
| IF-UI-004 | Price changes shall be highlighted for \[2\] s with direction indicator without shifting layout. | S | D |
| IF-UI-005 | The app shall provide dark and light themes (repo `useSkin`) and remember the choice. | C | D |
| IF-UI-006 | The site shall show branded 404 and 500 pages with a link home and to support, without technical detail. | M | I |
| IF-UI-007 | Pages shall include meta tags, Open Graph and X card images for shareable pages (promotions, events, booking codes), without gambling ads to under-age audiences. | S | I |

### 5.2 Software interfaces

| ID | System | Interface | Requirement |
| --- | --- | --- | --- |
| IF-SW-001 | Sports data feeds (primary BetsAPI or Sportradar/Genius Sports; secondary another vendor) | Push (AMQP/websocket) or REST polling | Adapter shall normalise to the internal catalogue, track sequence numbers, detect gaps and request snapshots. |
| IF-SW-002 | PSPs and Mobile Money aggregators | REST + signed webhooks | Adapter shall implement initiate, status, refund/reversal, payout, reconciliation file import. |
| IF-SW-003 | KYC / IDV provider | REST + webhooks, SDK in app | Send applicant, receive decision and document data; no raw biometric template kept by the platform. |
| IF-SW-004 | Sanctions and PEP screening | REST, daily batch rescreen | Return match score and list source. |
| IF-SW-005 | National self-exclusion register | Regulator API | Check at registration and login; cache no longer than \[24\] h. |
| IF-SW-006 | Regulator reporting / safe server | SFTP or API per regulator spec | Signed, encrypted files on schedule with delivery receipts. |
| IF-SW-007 | Email, SMS, push providers | REST | At least two SMS routes for OTP delivery. |
| IF-SW-008 | Game aggregator (optional) | Seamless wallet REST | Idempotent debit/credit/rollback. |
| IF-SW-009 | Blockchain nodes (optional) | JSON-RPC via managed providers | Keys from the secrets manager; never hard-coded (see G-02). |
| IF-SW-010 | Observability and error tracking | OpenTelemetry, Sentry-compatible | Traces, metrics, logs, client errors. |

### 5.3 Platform API

| ID | Requirement | Pri | Ver |
| --- | --- | --- | --- |
| IF-API-001 | All client APIs shall be versioned REST/JSON (OpenAPI 3.1 documented) plus a websocket channel for real-time data. | M | I |
| IF-API-002 | Error responses shall use RFC 9457 problem details with stable error codes and no stack traces. | M | T |
| IF-API-003 | Write endpoints that move money or place bets shall require an `Idempotency-Key` header. | M | T |
| IF-API-004 | Breaking API changes shall get a new major version and the old one shall stay for at least \[90\] days. | S | I |

### 5.4 Communications interfaces

HTTPS with TLS 1.2 minimum (TLS 1.3 preferred) for all traffic; HSTS with preload; secure websockets (wss) only; internal service traffic encrypted by mTLS through the service mesh.

## 6. Non-functional requirements

Targets assume a launch load of 50,000 concurrent players and 500 bets per second sustained, with headroom to 4× by horizontal scaling; the product owner must confirm these figures (open question in 1.5).

### 6.1 Performance

| ID | Requirement | Target | Ver |
| --- | --- | --- | --- |
| NFR-PERF-001 | Bet placement API latency (pre-match), excluding in-play delay | p95 ≤ 300 ms, p99 ≤ 800 ms | T |
| NFR-PERF-002 | Price update from feed receipt to player screen | p95 ≤ 500 ms, p99 ≤ 1 s | T |
| NFR-PERF-003 | Market suspension propagation to bet acceptance layer | ≤ 200 ms p99 | T |
| NFR-PERF-004 | Read APIs (event lists, markets, account) | p95 ≤ 200 ms | T |
| NFR-PERF-005 | Player web: Largest Contentful Paint on reference low-end device and 3G link (2.4) | ≤ 3.0 s p75 | T |
| NFR-PERF-006 | Player web: Interaction to Next Paint / Cumulative Layout Shift | INP ≤ 200 ms, CLS ≤ 0.1 at p75 | T |
| NFR-PERF-007 | Initial JavaScript bundle (compressed) for the home route | ≤ 250 KB | I |
| NFR-PERF-008 | Back-office reports for 30 days of data | ≤ 10 s, larger exports asynchronous | T |
| NFR-PERF-009 | Balance update visible after deposit confirmation | ≤ 5 s end to end | T |

### 6.2 Capacity and scalability

| ID | Requirement | Target | Ver |
| --- | --- | --- | --- |
| NFR-CAP-001 | Concurrent logged-in players | 50,000 at launch, scalable to 200,000 | T (load test) |
| NFR-CAP-002 | Bet throughput | 500 bets/s sustained for 1 h, 2,000 bets/s for 5 min burst (major match kick-off) | T |
| NFR-CAP-003 | Feed ingestion | 20,000 price updates/s with no backlog growth | T |
| NFR-CAP-004 | Concurrent websocket connections | 100,000 per region | T |
| NFR-CAP-005 | Rate limiting per IP, per account and per endpoint class (auth, bet, payment) with HTTP 429 and Retry-After | Auth: 10 per min per account; bets: 5 per s per account | T |
| NFR-CAP-006 | Stateless services scale horizontally by autoscaling on CPU and queue depth | New capacity serving within 3 min | D |

### 6.3 Availability and resilience

| ID | Requirement | Target | Ver |
| --- | --- | --- | --- |
| NFR-AV-001 | Availability of bet placement, login, deposits (monthly, excluding announced maintenance) | ≥ 99.95 % (≤ 22 min downtime per month) | A (SLO reports) |
| NFR-AV-002 | Availability of back office and reporting | ≥ 99.5 % | A |
| NFR-AV-003 | Planned maintenance | ≤ 4 h per month, announced 72 h ahead, outside peak sport windows; zero-downtime deploys for normal releases | I |
| NFR-AV-004 | Recovery Point Objective for ledger and bets | 0 (synchronous replica in a second zone); ≤ 5 min for other data | T (DR test) |
| NFR-AV-005 | Recovery Time Objective | ≤ 30 min for core betting and wallet; ≤ 4 h full platform in a second region | T (DR test) |
| NFR-AV-006 | Graceful degradation: if a feed, PSP or KYC provider fails, affected markets or methods shall suspend while all other functions continue | No cascade failure in chaos test | T |
| NFR-AV-007 | Backups: encrypted, immutable, daily full plus continuous WAL/PITR; stored in a separate account and region | Restore test passed each quarter | T |

### 6.4 Usability

| ID | Requirement | Target | Ver |
| --- | --- | --- | --- |
| NFR-US-001 | Registration completion time for a new player | Median ≤ 3 min (excluding document KYC) | T (usability test) |
| NFR-US-002 | Placing a single bet from the event page | ≤ 3 taps | D |
| NFR-US-003 | Task success in moderated usability test (register, deposit, bet, withdraw, set limit, self-exclude) | ≥ 90 % of participants | T |
| NFR-US-004 | All player-facing text at reading age 12 or lower; key terms shown before acceptance in plain language | Readability check | I |

### 6.5 Maintainability and quality

| ID | Requirement | Target | Ver |
| --- | --- | --- | --- |
| NFR-MT-001 | Unit test line coverage of domain logic (ledger, betting, settlement, bonus, RG) | ≥ 90 %; ≥ 70 % elsewhere | I |
| NFR-MT-002 | Settlement and bet-type calculations verified against a golden test set of ≥ 5,000 cases per bet type | 100 % pass | T |
| NFR-MT-003 | CI pipeline: lint, type check, tests, SAST, dependency scan, container scan on every pull request | Merge blocked on failure | I |
| NFR-MT-004 | Infrastructure defined as code and reproducible | New environment in ≤ 1 day | D |
| NFR-MT-005 | Mean time to restore for P1 incidents | ≤ 1 h | A |
| NFR-MT-006 | Lead time from merge to production for normal changes | ≤ 1 day, with canary or blue-green release | A |

### 6.6 Observability

| ID | Requirement | Target | Ver |
| --- | --- | --- | --- |
| NFR-OBS-001 | Distributed tracing across all services with correlation IDs carried to logs | 100 % of requests traced, 10 % sampled stored | I |
| NFR-OBS-002 | Business alerts: bet rejection rate, settlement backlog, ledger reconciliation difference, feed staleness, PSP error rate, KYC backlog | Page on-call within 2 min of breach | T |
| NFR-OBS-003 | Client error tracking for web and apps | Errors grouped with release and device | D |
| NFR-OBS-004 | Public status page for players | Updated within 10 min of P1 start | D |

### 6.7 Compatibility and localisation

| ID | Requirement | Target | Ver |
| --- | --- | --- | --- |
| NFR-CMP-001 | Browser and device support | As section 2.4 | T |
| NFR-L10N-001 | Languages, number, date and currency formats per locale; XAF shown with no decimals | EN, FR at launch | T |
| NFR-L10N-002 | Right-to-left readiness for later languages | Layout passes RTL check | I |

### 6.8 Data integrity

| ID | Requirement | Target | Ver |
| --- | --- | --- | --- |
| NFR-DI-001 | Ledger balance equals sum of journal entries for every account | 0 differences in hourly check | T |
| NFR-DI-002 | No lost or duplicate bets or payments under failure injection (process kill, network partition, retry storms) | 0 in 10,000-run chaos suite | T |

## 7. Security, privacy and regulatory compliance

The platform shall meet OWASP ASVS 4.0 Level 2 for all player and back-office surfaces, and Level 3 for the wallet, payments and back-office authentication. An independent penetration test with no open High or Critical findings is a go-live gate.

### 7.1 Authentication and session security (SEC-AUTH)

| ID | Requirement | Pri | Ver |
| --- | --- | --- | --- |
| SEC-AUTH-001 | Passwords shall be hashed with Argon2id (memory ≥ 64 MB, iterations ≥ 3) or bcrypt cost ≥ 12 from a maintained library. | M | I |
| SEC-AUTH-002 | Passwords shall be at least 10 characters, checked against a breached-password list, with no composition rules or forced rotation (NIST SP 800-63B). | M | T |
| SEC-AUTH-003 | Session and access tokens shall be generated from a CSPRNG (≥ 128 bits) or signed (JWT with asymmetric keys, ≤ 15 min lifetime); refresh tokens shall be distinct, rotated on use, and revocable server-side. | M | T |
| SEC-AUTH-004 | Browser sessions shall use cookies with `Secure`, `HttpOnly`, `SameSite=Lax` or stricter, plus CSRF protection on state-changing requests. | M | T |
| SEC-AUTH-005 | Tokens shall be bound to the session record and invalidated on logout, password change, self-exclusion and account suspension. | M | T |
| SEC-AUTH-006 | Brute-force protection: progressive delay and lockout after \[5\] failed attempts per account in 15 min and per-IP limits, with alerting on credential-stuffing patterns. | M | T |
| SEC-AUTH-007 | Bot protection (CAPTCHA or risk-based challenge) shall be enforced on registration, login after failures, password reset and OTP send in every production environment; no configuration flag shall disable it in production. | M | T |
| SEC-AUTH-008 | Account-enumeration resistance: login, registration and reset responses shall not reveal whether an account exists. | M | T |

### 7.2 Secrets and key management (SEC-SEC)

| ID | Requirement | Pri | Ver |
| --- | --- | --- | --- |
| SEC-SEC-001 | No secret, API key, private key or credential shall be stored in source code, example files or images; secret scanning shall block such commits in CI and pre-commit hooks. | M | I |
| SEC-SEC-002 | Every secret ever committed to the repository (G-02) shall be rotated before development continues, and git history shall be purged of them. | M | I |
| SEC-SEC-003 | Secrets shall live in a managed secrets store with per-service access, automatic rotation at most every \[90\] days, and access logging. | M | I |
| SEC-SEC-004 | Encryption keys shall be held in a KMS or HSM; crypto hot-wallet signing keys (if enabled) shall be in an HSM or MPC custody service, with hot-wallet balance capped at \[24\] h of expected withdrawals and the rest in cold storage. | M | I |

### 7.3 Application and API security (SEC-API)

| ID | Requirement | Pri | Ver |
| --- | --- | --- | --- |
| SEC-API-001 | Every API endpoint shall enforce authentication and object-level authorisation server-side (a player can access only their own resources); hiding UI elements is not a control. | M | T |
| SEC-API-002 | All input shall be validated server-side against a schema (type, length, range, format); queries shall be parameterised; user input shall never build a regex, file path or shell command. | M | T |
| SEC-API-003 | Responses shall set CSP (no `unsafe-inline` scripts), HSTS, X-Content-Type-Options, frame-ancestors and Referrer-Policy headers. | M | T |
| SEC-API-004 | CORS and websocket origins shall be restricted to an allow-list per environment; websocket connections shall require an authenticated token for private channels. | M | T |
| SEC-API-005 | File uploads shall be type-checked by content, size-limited, malware-scanned and served from a separate domain without execution. | M | T |
| SEC-API-006 | Server-side request forgery protection for any URL the server fetches (feeds, webhooks, images). | M | T |
| SEC-API-007 | Error responses and logs shown to clients shall never include stack traces, SQL or internal hostnames. | M | T |
| SEC-API-008 | A web application firewall and DDoS protection shall front all public endpoints, absorbing at least \[100\] Gbps volumetric attacks. | M | D |

### 7.4 Data protection and privacy (SEC-PRV)

| ID | Requirement | Pri | Ver |
| --- | --- | --- | --- |
| SEC-PRV-001 | Data shall be encrypted in transit (TLS 1.2+) and at rest (AES-256); KYC documents and identity numbers shall have field- or object-level encryption with separate keys. | M | I |
| SEC-PRV-002 | The system shall keep a record of processing activities and apply data minimisation; analytics shall use pseudonymous IDs. | M | I |
| SEC-PRV-003 | The system shall support data-subject rights: access/export in machine-readable form within \[30\] days, rectification, and erasure where no legal retention duty applies (AML and gambling records are retained per FR-AML-008). | M | T |
| SEC-PRV-004 | A cookie and tracking consent banner shall block non-essential cookies until consent. | M | T |
| SEC-PRV-005 | Retention schedules shall be enforced automatically, with deletion or anonymisation at the end of each period. | M | T |
| SEC-PRV-006 | A personal-data breach shall trigger the incident process with regulator notification within \[72\] h where the law requires. | M | D |
| SEC-PRV-007 | A Data Protection Impact Assessment shall be completed for KYC, RG risk scoring and profiling before launch. | M | I |

### 7.5 Logging and audit (SEC-LOG)

| ID | Requirement | Pri | Ver |
| --- | --- | --- | --- |
| SEC-LOG-001 | Security events (logins, failures, MFA changes, privilege changes, admin actions, money movements, config changes) shall be logged centrally in structured form. | M | T |
| SEC-LOG-002 | Audit logs shall be append-only and tamper-evident (hash chaining or WORM storage) and kept for at least \[5\] years. | M | I |
| SEC-LOG-003 | Logs shall not contain passwords, full card numbers, tokens or document images; personal data shall be masked. | M | T |
| SEC-LOG-004 | Log access shall go only through the log platform with RBAC and SSO; no application endpoint shall serve log files. | M | T |

### 7.6 Infrastructure and operations security (SEC-OPS)

| ID | Requirement | Pri | Ver |
| --- | --- | --- | --- |
| SEC-OPS-001 | Production access shall be just-in-time, MFA-protected, approved and recorded; no shared accounts. | M | I |
| SEC-OPS-002 | Environments shall be separated (dev, test, staging, prod) with no production personal data in non-production. | M | I |
| SEC-OPS-003 | Vulnerability management: critical patches within \[7\] days, high within \[30\] days; container images rebuilt at least weekly. | M | A |
| SEC-OPS-004 | Change management for certified components shall follow the regulator's notification and approval process (CON-06). | M | I |
| SEC-OPS-005 | An incident response plan with on-call rota, severity definitions, runbooks and post-incident review shall exist and be exercised every \[6\] months. | M | D |
| SEC-OPS-006 | A tested rollback plan shall exist for every release, including database migrations (expand-and-contract), and a launch-day rollback runbook. | M | D |
| SEC-OPS-007 | The organisation shall work toward ISO/IEC 27001 certification within \[18\] months of launch. | S | I |

### 7.7 Regulatory compliance (REG)

| ID | Requirement | Pri | Ver |
| --- | --- | --- | --- |
| REG-001 | The platform shall be certified by an accredited test laboratory (GLI, BMM, eCOGRA or iTech Labs) against the jurisdiction's technical standards before launch and after significant changes. | M | I |
| REG-002 | Published terms shall include general terms, betting rules per sport, bonus terms, privacy notice, cookie policy, RG policy, complaints procedure; each version shall be stored and the player's acceptance of each version recorded. | M | I |
| REG-003 | Material changes to terms shall require re-acceptance at next login. | M | T |
| REG-004 | Advertising and promotional content shall carry RG messaging and age warnings, and shall not target minors or excluded players. | M | I |
| REG-005 | The operator shall be able to produce, within \[24\] h of a regulator request, the full record of any player, bet, transaction or control action. | M | D |
| REG-006 | Tax computation (betting duty on GGR, player winnings tax where applicable) shall follow the rules set and be reportable per period. | M | T |
| REG-007 | Unclaimed and dormant balances shall be handled per local law, with reporting. | S | I |

## 8. Data, verification and traceability

Twelve core entities carry the business; money and bets live in a relational ledger store, and everything a regulator may ask for is kept for at least five years.

### 8.1 Core data entities and retention

| Entity | Key attributes | Store | Retention |
| --- | --- | --- | --- |
| Player | ID, legal name, DOB, address, contacts, state, jurisdiction, risk ratings | Relational | Relationship + 5 years |
| KYC case | Level, provider reference, documents (encrypted), decisions, approver | Relational + object store | Relationship + 5 years |
| RG settings and events | Limits with history, exclusions, markers, interventions | Relational | Relationship + 5 years; exclusions permanent record |
| Ledger account | Owner, currency, type (cash, bonus, pending, hold, control) | Relational | Permanent within company records |
| Journal entry | ID, idempotency key, lines (account, debit, credit, minor units), reason, source, timestamp | Relational, append-only | 7 years (finance) |
| Payment transaction | Method, PSP, amounts, fee, status history, PSP reference | Relational | 7 years |
| Event / market / selection | Internal and feed IDs, state history, price history | Document store + time-series | 5 years |
| Bet and bet leg | Reference, type, stake, legs with price and line, timestamps, channel, device, IP, status, settlement detail | Relational | 5 years after settlement |
| Bonus award | Campaign, value, wagering progress, status | Relational | 5 years |
| AML alert and case | Rule, evidence, decisions, SAR reference (restricted) | Relational | 5 years after closure |
| Audit record | Actor, action, before/after, reason, IP, time, hash link | Append-only log store | 5 years minimum |
| Consent record | Purpose, channel, version, timestamp | Relational | Relationship + 5 years |

### 8.2 Verification approach

| Level | Method | Exit criterion |
| --- | --- | --- |
| Unit and property tests | Ledger invariants, odds maths, bet-type combinatorics, settlement rules | NFR-MT-001, NFR-MT-002 |
| Contract tests | Each external adapter against provider sandboxes and recorded fixtures | All contracts green |
| Integration and end-to-end | Signup, KYC, deposit, bet, settle, withdraw, password reset, self-exclusion, on web and the reference Android device | 100 % of M scenarios pass |
| Performance | Load tests to NFR-CAP figures, soak test 24 h | All NFR-PERF and NFR-CAP met |
| Resilience | Chaos tests, DR failover, backup restore | NFR-AV-004/005/007, NFR-DI-002 |
| Security | SAST, DAST, dependency and secret scans, independent penetration test | No open High/Critical |
| Compliance | Test laboratory certification, compliance officer sign-off of RG and AML flows | Certificate issued (REG-001) |
| User acceptance | Product owner and operations run the back-office runbooks | Sign-off recorded |

### 8.3 Launch-readiness traceability

The owner's pre-launch checklist maps to requirements in this SRS:

| # | Launch check | Requirement IDs |
| --- | --- | --- |
| 1 | No API keys in frontend or git | SEC-SEC-001, SEC-SEC-003 |
| 2 | Rotate any committed key | SEC-SEC-002, G-02 |
| 3 | Rate limiting | NFR-CAP-005, SEC-AUTH-006 |
| 4 | Auth on every route | SEC-API-001 |
| 5 | Users see only their own data | SEC-API-001, FR-BO-001, FR-BO-003 |
| 6 | Server-side input validation | SEC-API-002 |
| 7 | Spending cap on third-party providers | NFR-OBS-002 plus budget alerts per provider (feeds, SMS, KYC) |
| 8 | No stack traces in errors | IF-API-002, SEC-API-007 |
| 9 | Error tracking | IF-SW-010, NFR-OBS-003 |
| 10 | Tested backup restore | NFR-AV-007 |
| 11 | 404 and 500 pages | IF-UI-006 |
| 12 | Works on a cheap Android phone | 2.4 reference device, NFR-PERF-005 |
| 13 | Nothing slower than 3 s | NFR-PERF-001 to -005 |
| 14 | Meta tags and OG images | IF-UI-007 |
| 15 | Privacy policy and terms | REG-002, SEC-PRV-004 |
| 16 | Analytics on drop-off | FR-REP-006 |
| 17 | End-to-end tests of signup, payment, reset | 8.2 end-to-end level |
| 18 | Emails not in spam | FR-NTF-001 plus SPF, DKIM, DMARC (p=quarantine or stricter) on sending domains |
| 19 | Contact route for users | FR-SUP-001 |
| 20 | Rollback plan | SEC-OPS-006 |

### 8.4 Release plan

| Phase | Content | Gate |
| --- | --- | --- |
| 0. Remediate | Rotate keys, purge history, freeze current code (G-01, G-02) | Keys rotated |
| 1. Foundation | Identity, KYC, ledger, payments (one PSP plus Mobile Money), back-office core, CI/CD, observability | Ledger invariants and penetration test of auth pass |
| 2. Sportsbook MVP | Feed ingestion, pre-match markets, singles and multiples, settlement, RG tools, AML rules | End-to-end suite green |
| 3. Live and risk | In-play, bet delay, liability, trader tools, cash out, second feed | NFR-PERF and NFR-CAP met |
| 4. Certification and launch | Test laboratory, regulator approval, soft launch with capped players | REG-001, go-live checklist 8.3 |
| 5. Growth (Release 2) | Bonuses at scale, affiliates, casino lobby, Web3 module where licensed | Separate change approval |

### 8.5 Appendix A: worked settlement example

A player stakes XAF 10,000 on a treble at 1.80, 2.10 and 1.50 (combined 5.67). Leg 2 is voided because the match is abandoned. The bet becomes a double at 1.80 × 1.50 = 2.70, and the return is XAF 27,000. If leg 3 is an Asian handicap −0.25 that half-loses, that leg's factor is 0.5 and the return is 10,000 × 1.80 × 0.5 = XAF 9,000. The golden test set of NFR-MT-002 contains cases like these for every bet type.

### 8.6 Appendix B: open issues

| # | Issue | Owner | Needed by |
| --- | --- | --- | --- |
| OI-1 | Confirm launch jurisdiction and licence type | Product owner | Phase 1 start |
| OI-2 | Confirm capacity figures (50,000 concurrent, 500 bets/s) | Product owner | Phase 1 design |
| OI-3 | Select primary and secondary sports feed vendors | Trading lead | Phase 2 start |
| OI-4 | Decide whether casino and Web3 move into Release 1 | Product owner | Phase 1 start |
| OI-5 | Legal review of data residency and crypto permission | Counsel | Phase 1 design |
